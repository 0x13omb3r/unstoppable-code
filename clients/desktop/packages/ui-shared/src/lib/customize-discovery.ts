import type { UnifiedPluginEntry } from './unified-plugin-entry';
import {
  MARKETPLACE_TYPE_TABS,
  type MarketplaceTypeTab,
  type MarketplaceTypeTabId,
} from './marketplace-type-tabs';

/**
 * New Customize (CAN-6809, the `customize-discovery` Labs experiment): five
 * tabs and one filter menu. Pure model shared by desktop and Portal; the
 * hosts own the state and only read it through these helpers. The Labs
 * entry is `CUSTOMIZE_DISCOVERY_EXPERIMENT` in `@canopy/protocol/experiments`.
 */

/** The tabs New Customize keeps. */
export type CustomizeDiscoveryTabId =
  | 'all'
  | 'plugin'
  | 'app'
  | 'skill'
  | 'workflow';

const DISCOVERY_TAB_IDS: readonly CustomizeDiscoveryTabId[] = [
  'all',
  'plugin',
  'app',
  'skill',
  'workflow',
];

export function isCustomizeDiscoveryTab(
  tab: MarketplaceTypeTabId,
): tab is CustomizeDiscoveryTabId {
  return DISCOVERY_TAB_IDS.some((candidate) => candidate === tab);
}

/** All, Plugins, MCP servers, Skills and Workflows, with today's labels. */
export const CUSTOMIZE_DISCOVERY_TABS: readonly MarketplaceTypeTab[] =
  MARKETPLACE_TYPE_TABS.filter((tab) => isCustomizeDiscoveryTab(tab.id));

export type CustomizeDiscoveryStatus =
  | 'any'
  | 'installed'
  | 'available'
  | 'attention';

export const CUSTOMIZE_DISCOVERY_STATUS_OPTIONS: readonly {
  readonly value: CustomizeDiscoveryStatus;
  readonly label: string;
}[] = [
  { value: 'any', label: 'Any' },
  { value: 'installed', label: 'Installed' },
  { value: 'available', label: 'Available' },
  { value: 'attention', label: 'Attention' },
];

/** The harnesses Works with offers, in the design's order. */
export type CustomizeDiscoveryHarness =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'opencode';

export const CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS: readonly {
  readonly value: CustomizeDiscoveryHarness;
  readonly label: string;
}[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'copilot', label: 'Copilot' },
  { value: 'opencode', label: 'OpenCode' },
];

export interface CustomizeDiscoveryFilters {
  readonly status: CustomizeDiscoveryStatus;
  /** Also show: off by default, so All lists the five kinds the tabs name. */
  readonly collections: boolean;
  readonly agents: boolean;
  /** A marketplace's source label; `null` is Any marketplace. */
  readonly source: string | null;
  /** Empty is Any harness. */
  readonly harnesses: readonly CustomizeDiscoveryHarness[];
}

export const DEFAULT_CUSTOMIZE_DISCOVERY_FILTERS: CustomizeDiscoveryFilters =
  Object.freeze({
    status: 'any',
    collections: false,
    agents: false,
    source: null,
    harnesses: Object.freeze([]),
  });

/** Filters that are on, for the count on the filter button. */
export function customizeDiscoveryFilterCount(
  filters: CustomizeDiscoveryFilters,
): number {
  return (
    (filters.status !== 'any' ? 1 : 0) +
    (filters.collections ? 1 : 0) +
    (filters.agents ? 1 : 0) +
    (filters.source !== null ? 1 : 0) +
    (filters.harnesses.length > 0 ? 1 : 0)
  );
}

/** Where an old tab lands in New Customize. */
export interface CustomizeDiscoveryLanding {
  /** `sources` is the Marketplaces view, reached from Manage marketplaces. */
  readonly tab: CustomizeDiscoveryTabId | 'sources';
  /** Filters the old tab implied, merged over the current ones. */
  readonly filters?: Partial<CustomizeDiscoveryFilters>;
}

/**
 * Old deep links and saved tab choices: Collections and Agents open All with
 * Also show on, Project templates opens All (where they are listed), and
 * Marketplaces keeps its view. None lands on an empty view.
 */
export function customizeDiscoveryLanding(
  tab: MarketplaceTypeTabId,
): CustomizeDiscoveryLanding {
  switch (tab) {
    case 'collection':
      return { tab: 'all', filters: { collections: true } };
    case 'agent':
      return { tab: 'all', filters: { agents: true } };
    case 'blueprint':
      return { tab: 'all' };
    case 'sources':
      return { tab: 'sources' };
    default:
      return { tab };
  }
}

/** The filters after landing from an old tab. */
export function customizeDiscoveryFiltersForLanding(
  current: CustomizeDiscoveryFilters,
  landing: CustomizeDiscoveryLanding,
): CustomizeDiscoveryFilters {
  return landing.filters ? { ...current, ...landing.filters } : current;
}

/** An installed entry that needs the person: sign-in, or a failing connection. */
export function customizeDiscoveryNeedsAttention(
  entry: UnifiedPluginEntry,
): boolean {
  if (entry.state === 'needs-auth') return true;
  if ((entry.pendingSignIns ?? 0) > 0) return true;
  const connection = entry.aggregateConnection ?? entry.connection;
  return (
    connection !== undefined &&
    connection.disabled !== true &&
    (connection.status === 'auth_required' ||
      connection.status === 'unreachable')
  );
}

/**
 * The item's published harness, until CAN-6807 reports real compatibility:
 * only Claude Code and Codex are published today, so Cursor, Copilot and
 * OpenCode match nothing yet.
 */
export function customizeDiscoveryWorksWith(
  entry: UnifiedPluginEntry,
  harness: CustomizeDiscoveryHarness,
): boolean {
  switch (harness) {
    case 'claude':
      return entry.providerSupport.claude;
    case 'codex':
      return entry.providerSupport.codex;
    case 'cursor':
    case 'copilot':
    case 'opencode':
      return false;
  }
}

/**
 * Whether New Customize lists an entry. `installed` is the host's own
 * installed test (`marketplaceEntryIsInstalled`), so Installed shows exactly
 * what it shows today: Also show only adds collections and agents that are
 * not installed, and an installed one stays listed. `hasUpdate` is the host's
 * update test: an update is a badge on the row (CAN-6810), so Attention still
 * finds it.
 */
export function customizeDiscoveryEntryMatches(
  entry: UnifiedPluginEntry,
  filters: CustomizeDiscoveryFilters,
  installed: boolean,
  hasUpdate = false,
): boolean {
  if (!installed && entry.kind === 'collection' && !filters.collections)
    return false;
  if (!installed && entry.kind === 'agent' && !filters.agents) return false;
  switch (filters.status) {
    case 'installed':
      if (!installed) return false;
      break;
    case 'available':
      if (installed) return false;
      break;
    case 'attention':
      if (!installed || !(hasUpdate || customizeDiscoveryNeedsAttention(entry)))
        return false;
      break;
    case 'any':
      break;
  }
  if (filters.source !== null && entry.sourceLabel?.trim() !== filters.source)
    return false;
  if (
    filters.harnesses.length > 0 &&
    !filters.harnesses.some((harness) =>
      customizeDiscoveryWorksWith(entry, harness),
    )
  )
    return false;
  return true;
}

/** The marketplaces Source offers: every source label the entries carry, sorted. */
export function customizeDiscoverySourceOptions(
  entries: readonly UnifiedPluginEntry[],
): string[] {
  const labels = new Set<string>();
  for (const entry of entries) {
    const label = entry.sourceLabel?.trim();
    if (label) labels.add(label);
  }
  return [...labels].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' }),
  );
}

/**
 * Shared with me (CAN-6810): a share someone else published to a team or
 * organization the viewer belongs to. The viewer's own shares carry
 * `ownedByViewer`; a share whose owner is unknown counts as shared with them.
 */
export function customizeEntrySharedWithViewer(
  entry: UnifiedPluginEntry,
): boolean {
  return (
    entry.origin === 'shared' &&
    entry.isShared !== false &&
    entry.ownedByViewer !== true
  );
}

/**
 * An installed copy of a share from someone else: a receipted copy, or one
 * whose share is folded into it. Shared with me lists it as its Installed row.
 */
export function customizeEntryIsCopyOfSharedWithViewer(
  entry: UnifiedPluginEntry,
): boolean {
  return (
    entry.origin !== 'shared' &&
    (entry.copyOfSharedWithViewer !== undefined ||
      entry.installedFrom !== undefined)
  );
}

/** One share from someone else, as the Shared with me counter reads it. */
export interface CustomizeSharedWithMeShare {
  /** The share row's entry id, the same for a share and its folded copy. */
  readonly id: string;
  /** ISO date the share was created; absent when unknown. */
  readonly sharedSince?: string;
}

/**
 * The shares from others the entries carry: share rows, and installed copies
 * whose share row is folded into them. Each share is listed once.
 */
export function customizeSharedWithMeShares(
  entries: readonly UnifiedPluginEntry[],
): CustomizeSharedWithMeShare[] {
  const shares = new Map<string, CustomizeSharedWithMeShare>();
  for (const entry of entries) {
    if (customizeEntrySharedWithViewer(entry)) {
      shares.set(entry.id, {
        id: entry.id,
        ...(entry.sharedSince !== undefined
          ? { sharedSince: entry.sharedSince }
          : {}),
      });
      continue;
    }
    const copy = entry.copyOfSharedWithViewer;
    if (copy !== undefined && entry.origin !== 'shared')
      shares.set(copy.shareEntryId, {
        id: copy.shareEntryId,
        sharedSince: copy.sharedSince,
      });
  }
  return [...shares.values()];
}

/** The share's date as an instant, or `undefined` for a missing or bad date. */
function sharedSinceMs(share: CustomizeSharedWithMeShare): number | undefined {
  if (share.sharedSince === undefined) return undefined;
  const value = Date.parse(share.sharedSince);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * How many shares from others arrived since the viewer last opened Shared
 * with me. `lastSeenMs` is the stored marker; `null` means never opened, so
 * every share is new. A share without a readable date is new only until the
 * first open.
 */
export function customizeSharedWithMeNewCount(
  shares: readonly CustomizeSharedWithMeShare[],
  lastSeenMs: number | null,
): number {
  const seen = new Set<string>();
  let count = 0;
  for (const share of shares) {
    if (seen.has(share.id)) continue;
    seen.add(share.id);
    if (lastSeenMs === null) {
      count += 1;
      continue;
    }
    const since = sharedSinceMs(share);
    if (since !== undefined && since > lastSeenMs) count += 1;
  }
  return count;
}

/**
 * The marker to store when the viewer opens Shared with me: now, or the
 * newest share's date when a server clock runs ahead, so every known share
 * reads as seen.
 */
export function customizeSharedWithMeSeenMarker(
  shares: readonly CustomizeSharedWithMeShare[],
  nowMs: number,
): number {
  let marker = nowMs;
  for (const share of shares) {
    const since = sharedSinceMs(share);
    if (since !== undefined && since > marker) marker = since;
  }
  return marker;
}

function relevanceText(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, ' ');
}

/** Whether a skill name matches a search, as the skill tier reads it. */
function customizeSkillNameMatches(skillName: string, query: string): boolean {
  const needle = relevanceText(query);
  return needle !== '' && relevanceText(skillName).includes(needle);
}

/** Matched skills a plugin row names before "+N more skills" (CAN-6812). */
const CUSTOMIZE_SKILL_MATCH_LIMIT = 3;

/**
 * The "Includes" line of a plugin row that a search reached through its
 * skills (CAN-6812): the first matched skill names, in the plugin's order,
 * and how many of the plugin's other skills the line leaves out.
 */
export interface CustomizeSkillMatch {
  readonly names: readonly string[];
  readonly moreCount: number;
}

/** The row's skill match line, or `undefined` when no skill matches. */
export function customizeSkillMatch(
  skillNames: readonly string[],
  query: string,
): CustomizeSkillMatch | undefined {
  const all = [...new Set(skillNames)];
  const names = all
    .filter((name) => customizeSkillNameMatches(name, query))
    .slice(0, CUSTOMIZE_SKILL_MATCH_LIMIT);
  if (names.length === 0) return undefined;
  return { names, moreCount: all.length - names.length };
}

/**
 * Search relevance for Browse (CAN-6810): 3 for a name match, 2 when one of
 * the item's skills matches by name, 1 for a description match, else 0 (the
 * item matched on other metadata, such as its author). Grouped listings take
 * their best listing's score. There is no popularity signal yet, so equal
 * scores keep the list's order.
 */
export function customizeRelevanceScore(
  entry: Pick<UnifiedPluginEntry, 'name' | 'description'> & {
    readonly marketplaceListings?: readonly Pick<
      UnifiedPluginEntry,
      'name' | 'description'
    >[];
  },
  query: string,
  skillNames: readonly string[] = [],
): number {
  const needle = relevanceText(query);
  if (needle === '') return 0;
  const score = (
    item: Pick<UnifiedPluginEntry, 'name' | 'description'>,
  ): number =>
    relevanceText(item.name).includes(needle)
      ? 3
      : skillNames.some((name) => customizeSkillNameMatches(name, query))
        ? 2
        : relevanceText(item.description).includes(needle)
          ? 1
          : 0;
  return Math.max(
    score(entry),
    ...(entry.marketplaceListings ?? []).map(score),
  );
}

/**
 * Browse search results, best match first. Stable: equal scores keep the
 * input order, which is today's Browse order.
 */
export function rankCustomizeByRelevance<T extends UnifiedPluginEntry>(
  entries: readonly T[],
  query: string,
  skillNamesOf: (entry: T) => readonly string[] = () => [],
): T[] {
  if (relevanceText(query) === '') return [...entries];
  return entries
    .map((entry, index): { entry: T; index: number; score: number } => ({
      entry,
      index,
      score: customizeRelevanceScore(entry, query, skillNamesOf(entry)),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ entry }) => entry);
}
