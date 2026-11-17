import type { JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { UnsavedMessageEdits } from '@canopy/ui-shared/components';
import { useChatStore as useLiveChatStore } from '@/stores/chatStore';
import type { UnsavedQueuedEdit } from '@/stores/chat/state';
import { useChatSurfaceStore } from '@/stores/chat/surface-store';
import { requestChatComposerText } from '@canopy/app-core';

interface UnsavedQueuedEditsProps {
  readonly worktreeTarget: { projectId: string; worktreeId: string } | null;
  readonly chatId: string;
}

/**
 * Text from this chat's queued-message edits that wasn't saved (CAN-6799),
 * in the shared card the web shows, until the person dismisses it or
 * restores it into this chat's composer.
 */
export function UnsavedQueuedEdits({
  worktreeTarget,
  chatId,
}: UnsavedQueuedEditsProps): JSX.Element | null {
  const useChatStore = useChatSurfaceStore(useLiveChatStore);
  const worktreeKey =
    worktreeTarget === null
      ? null
      : `${worktreeTarget.projectId}/${worktreeTarget.worktreeId}`;
  const edits = useChatStore(
    useShallow((state) =>
      state.unsavedQueuedEdits.filter(
        (edit) => edit.worktreeKey === worktreeKey && edit.chatId === chatId,
      ),
    ),
  );
  const dismiss = useChatStore((state) => state.dismissUnsavedQueuedEdit);
  if (edits.length === 0) return null;
  const editOf = (draft: { id: string }): UnsavedQueuedEdit | undefined =>
    edits.find((candidate) => candidate.id === draft.id);
  return (
    <UnsavedMessageEdits
      drafts={edits}
      onDismiss={(draft): void => {
        const edit = editOf(draft);
        if (edit) dismiss(edit);
      }}
      onRestore={(draft): void => {
        // Kept until the composer takes it, so a closed composer loses nothing.
        const edit = editOf(draft);
        if (requestChatComposerText({ chatId, text: draft.text }) && edit)
          dismiss(edit);
      }}
    />
  );
}
