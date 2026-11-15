/**
 * Pure helpers behind the archived chats list: sort, filter, count, group by
 * date and label times. No React, so they test without a renderer.
 *
 * Every calendar comparison reads local date parts, never milliseconds
 * divided by a day, so a DST change does not move a chat into another day.
 */
import { groupContiguousRuns } from './group-runs';
import { formatRelativeTime } from './format-relative-time';

/** The facts the list sorts, filters and groups on. */
export interface ArchivedChatListEntry {
  readonly id: string;
  /** The title the row renders, including any untitled fallback. */
  readonly title: string;
  /** ISO timestamp the chat was archived. */
  readonly archivedAt: string;
  /** ISO timestamp the chat was started. */
  readonly createdAt: string;
  readonly turnCount: number;
  readonly unread?: boolean;
  readonly restorable: boolean;
}

export type ArchivedChatSort = 'archived' | 'started' | 'turns' | 'name';

export type ArchivedChatFilter = 'all' | 'unread' | 'restorable';

export const ARCHIVED_CHAT_SORT_OPTIONS: readonly {
  readonly value: ArchivedChatSort;
  readonly label: string;
}[] = [
  { value: 'archived', label: 'Recently archived' },
  { value: 'started', label: 'Recently started' },
  { value: 'turns', label: 'Most turns' },
  { value: 'name', label: 'Name' },
];

export const DEFAULT_ARCHIVED_CHAT_SORT: ArchivedChatSort = 'archived';

export function isArchivedChatSort(value: unknown): value is ArchivedChatSort {
  return ARCHIVED_CHAT_SORT_OPTIONS.some((option) => option.value === value);
}

/** Milliseconds since the epoch, or `null` for a missing or bad timestamp. */
function parseTime(iso: string): number | null {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

/** Keeps rows matching the query (title, case-insensitive) and the filter. */
export function filterArchivedChats<T extends ArchivedChatListEntry>(
  items: readonly T[],
  {
    query,
    filter,
  }: { readonly query: string; readonly filter: ArchivedChatFilter },
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filter === 'unread' && item.unread !== true) return false;
    if (filter === 'restorable' && !item.restorable) return false;
    return needle === '' || item.title.toLocaleLowerCase().includes(needle);
  });
}

/** Newest first; an unparseable time sorts after every parseable one. */
function compareTimesDesc(a: string, b: string): number {
  const left = parseTime(a);
  const right = parseTime(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

const nameCollator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

function compareByKey(
  a: ArchivedChatListEntry,
  b: ArchivedChatListEntry,
  sort: ArchivedChatSort,
): number {
  switch (sort) {
    case 'archived':
      return compareTimesDesc(a.archivedAt, b.archivedAt);
    case 'started':
      return compareTimesDesc(a.createdAt, b.createdAt);
    case 'turns':
      return b.turnCount - a.turnCount;
    case 'name':
      return nameCollator.compare(a.title, b.title);
  }
}

/**
 * A sorted copy. Ties break by archived time (newest first), then by id, so
 * the order is stable across renders.
 */
export function sortArchivedChats<T extends ArchivedChatListEntry>(
  items: readonly T[],
  sort: ArchivedChatSort,
): T[] {
  return [...items].sort((a, b) => {
    const byKey = compareByKey(a, b, sort);
    if (byKey !== 0) return byKey;
    const byArchived = compareTimesDesc(a.archivedAt, b.archivedAt);
    if (byArchived !== 0) return byArchived;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

export interface ArchivedChatCounts {
  readonly all: number;
  readonly unread: number;
  readonly restorable: number;
}

/** Totals over the unfiltered list; they do not follow the query. */
export function countArchivedChats(
  items: readonly ArchivedChatListEntry[],
): ArchivedChatCounts {
  let unread = 0;
  let restorable = 0;
  for (const item of items) {
    if (item.unread === true) unread += 1;
    if (item.restorable) restorable += 1;
  }
  return { all: items.length, unread, restorable };
}

const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long' });
const monthYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
});
const weekdayTimeFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});
const monthDayYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const clockFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/** Local midnight of the day `time` falls on. */
function startOfLocalDay(time: number): Date {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Whole calendar days from `then` to `now` in local time. Built from local
 * date parts through `Date.UTC`, so a 23- or 25-hour DST day still counts as
 * one day.
 */
function calendarDaysBetween(then: number, now: number): number {
  const a = new Date(then);
  const b = new Date(now);
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((dayB - dayA) / 86_400_000);
}

export interface ArchivedChatGroup<T> {
  /** Stable key for React. */
  readonly key: string;
  /** The sticky header; `null` for the one unlabelled group of a flat sort. */
  readonly label: string | null;
  readonly items: readonly T[];
}

/**
 * The bucket a time falls in, first match wins: Today, Yesterday, Earlier
 * this week, Earlier this month, then one bucket per older month. Weeks start
 * on Monday. A time after `now` (clock skew) counts as Today.
 */
function dateBucket(
  time: number | null,
  now: number,
): { key: string; label: string } {
  if (time === null) return { key: 'older', label: 'Older' };
  const today = startOfLocalDay(now);
  if (time >= today.getTime()) return { key: 'today', label: 'Today' };
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );
  if (time >= yesterday.getTime()) {
    return { key: 'yesterday', label: 'Yesterday' };
  }
  // getDay() is 0 for Sunday; Monday starts the week.
  const sinceMonday = (today.getDay() + 6) % 7;
  const weekStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - sinceMonday,
  );
  if (time >= weekStart.getTime()) {
    return { key: 'week', label: 'Earlier this week' };
  }
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  if (time >= monthStart.getTime()) {
    return { key: 'month', label: 'Earlier this month' };
  }
  const date = new Date(time);
  const sameYear = date.getFullYear() === today.getFullYear();
  return {
    key: `month-${String(date.getFullYear())}-${String(date.getMonth())}`,
    label: sameYear
      ? monthFormatter.format(date)
      : monthYearFormatter.format(date),
  };
}

/**
 * Splits an already sorted list into date groups. Only the two date sorts
 * group (on archived or started time); Most turns and Name return one
 * unlabelled group. Empty groups never appear.
 */
export function groupArchivedChats<T extends ArchivedChatListEntry>(
  items: readonly T[],
  sort: ArchivedChatSort,
  now: number,
): ArchivedChatGroup<T>[] {
  if (items.length === 0) return [];
  if (sort !== 'archived' && sort !== 'started') {
    return [{ key: 'all', label: null, items }];
  }
  const labels = new Map<string, string>();
  const runs = groupContiguousRuns(items, (item) => {
    const bucket = dateBucket(
      parseTime(sort === 'archived' ? item.archivedAt : item.createdAt),
      now,
    );
    labels.set(bucket.key, bucket.label);
    return bucket.key;
  });
  return runs.map((run) => ({
    key:
      run.occurrence === 0 ? run.key : `${run.key}-${String(run.occurrence)}`,
    label: labels.get(run.key) ?? null,
    items: run.rows,
  }));
}

/**
 * A row's short time: `just now` under a minute (the list ticks once a
 * minute, so seconds would go stale), `12m ago` the same day, `Thu 4:12 PM`
 * within the past six calendar days, then `Nov 3`, or `Nov 3, 2025` in
 * another year. Unparseable reads as an empty string.
 */
export function formatArchivedChatTime(iso: string, now: number): string {
  const time = parseTime(iso);
  if (time === null) return '';
  if (now - time < 60_000) return 'just now';
  const days = calendarDaysBetween(time, now);
  if (days === 0) return formatRelativeTime(time, now);
  if (days <= 6) return weekdayTimeFormatter.format(time);
  return new Date(time).getFullYear() === new Date(now).getFullYear()
    ? monthDayFormatter.format(time)
    : monthDayYearFormatter.format(time);
}

function fullDateTime(iso: string): string | null {
  const time = parseTime(iso);
  if (time === null) return null;
  return `${monthDayYearFormatter.format(time)} at ${clockFormatter.format(time)}`;
}

/**
 * The row tooltip: `Archived Nov 13, 2026 at 2:04 PM · Started Nov 12, 2026
 * at 9:30 AM`. An unparseable half is left out; both leaves an empty string.
 */
export function archivedChatTimeTooltip(
  item: Pick<ArchivedChatListEntry, 'archivedAt' | 'createdAt'>,
): string {
  const archived = fullDateTime(item.archivedAt);
  const started = fullDateTime(item.createdAt);
  return [
    archived === null ? null : `Archived ${archived}`,
    started === null ? null : `Started ${started}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}
