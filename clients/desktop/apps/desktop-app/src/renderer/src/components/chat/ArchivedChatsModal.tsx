import { useMemo, type JSX } from 'react';
import type { ArchivedChatSummary } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL, CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { ArchivedChatsList, DialogModal } from '@canopy/ui-shared/components';
import { useArchivedChatsSortStore } from '@/stores/archivedChatsSortStore';
import { toArchivedChatsListItem } from './archivedChatItems';

export interface ArchivedChatsModalProps {
  summaries: ArchivedChatSummary[];
  /** Open the read-only transcript viewer for a chat (row click). */
  onOpenChat: (chatId: string) => void;
  onRestore: (chatId: string) => void;
  onSummarize: (chatId: string) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
  summarizingIds: ReadonlySet<string>;
  restoringIds: ReadonlySet<string>;
}

/** `66 archived chats · 12 unread`: totals, whatever the search or filter. */
function archivedChatsSubtitle(total: number, unread: number): string {
  const unit = (
    total === 1 ? CHAT_UNIT_LABEL : CHAT_UNIT_LABEL_PLURAL
  ).toLowerCase();
  const count = `${String(total)} archived ${unit}`;
  return unread > 0 ? `${count} · ${String(unread)} unread` : count;
}

/**
 * Every archived chat for the worktree in the shared `ArchivedChatsList`:
 * search, sort, an All / Unread / Restorable filter, and the same Restore /
 * Summarize actions as the hover card. Opened from the archive icon (click)
 * or the card's "N more…" row.
 */
export function ArchivedChatsModal({
  summaries,
  onOpenChat,
  onRestore,
  onSummarize,
  onMarkAllRead,
  onClose,
  summarizingIds,
  restoringIds,
}: ArchivedChatsModalProps): JSX.Element {
  const sort = useArchivedChatsSortStore((state) => state.sort);
  const setSort = useArchivedChatsSortStore((state) => state.setSort);
  const items = useMemo(
    () =>
      summaries.map((summary) =>
        toArchivedChatsListItem(summary, summarizingIds, restoringIds),
      ),
    [summaries, summarizingIds, restoringIds],
  );
  const unread = useMemo(
    () => summaries.filter((summary) => summary.unread).length,
    [summaries],
  );
  return (
    <DialogModal
      inset="flush"
      scrollableBody={false}
      // The list's toolbar sits under the header, and rows scroll beneath it.
      headerBorder={false}
      // Keeps the card from shrinking with each keystroke or filter change.
      minHeight="min(28rem, 80vh, 85dvh)"
      onClose={onClose}
      title={`Archived ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`}
      subtitle={archivedChatsSubtitle(summaries.length, unread)}
      maxWidth="lg"
      dataTestId="archived-chats-modal"
    >
      <ArchivedChatsList
        items={items}
        sort={sort}
        onSortChange={setSort}
        onOpen={onOpenChat}
        onRestore={onRestore}
        onSummarize={onSummarize}
        onMarkAllRead={onMarkAllRead}
      />
    </DialogModal>
  );
}
