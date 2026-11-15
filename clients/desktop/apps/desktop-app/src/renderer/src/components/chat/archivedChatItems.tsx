import {
  getModelDisplayName,
  type ArchivedChatSummary,
} from '@canopy/desktop-shared/types';
import {
  ModelProviderIcon,
  type ArchivedChatsCardItem,
  type ArchivedChatsListItem,
} from '@canopy/ui-shared/components';
import { formatArchivedChatTime } from '@canopy/ui-shared/lib';
import { getArchivedChatDisplayLabel } from '@/components/standalone-chat/chat-label';

/** The sub-line facts: the model and the turn count. */
function archivedChatMeta(summary: ArchivedChatSummary): string {
  const turns = `${summary.turnCount} ${
    summary.turnCount === 1 ? 'turn' : 'turns'
  }`;
  return summary.model
    ? `${getModelDisplayName(summary.model)} · ${turns}`
    : turns;
}

function toBaseItem(
  summary: ArchivedChatSummary,
  summarizingIds: ReadonlySet<string>,
  restoringIds: ReadonlySet<string>,
): ArchivedChatsCardItem {
  return {
    id: summary.chatId,
    title: getArchivedChatDisplayLabel(summary),
    meta: archivedChatMeta(summary),
    icon: summary.providerType ? (
      <ModelProviderIcon provider={summary.providerType} size="sm" />
    ) : undefined,
    unread: summary.unread,
    restorable: summary.restorable,
    restoring: restoringIds.has(summary.chatId),
    summarizing: summarizingIds.has(summary.chatId),
  };
}

/**
 * A hover card row: the facts end with the archived time
 * ("Opus 5.5 · 1 turn · 12m ago"), left off while the time is unparseable.
 */
export function toCardItem(
  summary: ArchivedChatSummary,
  summarizingIds: ReadonlySet<string>,
  restoringIds: ReadonlySet<string>,
  now: number,
): ArchivedChatsCardItem {
  const base = toBaseItem(summary, summarizingIds, restoringIds);
  const time = formatArchivedChatTime(summary.archivedAt, now);
  return time === '' ? base : { ...base, meta: `${base.meta ?? ''} · ${time}` };
}

/** A full-list row: the card's facts plus the times and turns it sorts on. */
export function toArchivedChatsListItem(
  summary: ArchivedChatSummary,
  summarizingIds: ReadonlySet<string>,
  restoringIds: ReadonlySet<string>,
): ArchivedChatsListItem {
  return {
    ...toBaseItem(summary, summarizingIds, restoringIds),
    archivedAt: summary.archivedAt,
    createdAt: summary.createdAt,
    turnCount: summary.turnCount,
  };
}
