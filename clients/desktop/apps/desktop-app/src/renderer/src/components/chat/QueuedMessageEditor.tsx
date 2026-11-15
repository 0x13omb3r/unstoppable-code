import {
  AgentSentTitle,
  useAgentSentReceivingContext,
} from '@canopy/ui-shared';
import { useCallback, useRef, useState, type JSX } from 'react';
import type {
  AttachmentMeta,
  ChatAttachmentPromptContext,
  FileReference,
} from '@canopy/desktop-shared/types';
import { isChatAttachmentPromptKind } from '@canopy/desktop-shared/types';
import {
  useChatStore as useLiveChatStore,
  type QueuedChatMessage,
} from '@/stores/chatStore';
import { findQueuedEditScope } from '@/stores/chat/slices/queue';
import { useChatSurfaceStore } from '@/stores/chat/surface-store';
import { getFilenameFromPath } from '@/lib/file-type';
import { ChatInput, type ChatInputEditingState } from './ChatInput';
import type { ActiveComposerView } from './types';

interface QueuedMessageEditorProps {
  message: QueuedChatMessage;
  index: number;
  composerTab: ActiveComposerView | null;
  onCancel: () => void;
  onSave: (
    index: number,
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
    expected?: QueuedChatMessage,
  ) => void;
  scheduleEnabled?: boolean;
  autoFocus?: boolean;
}

function attachmentPathsToMeta(
  paths: readonly string[],
  contexts: readonly ChatAttachmentPromptContext[] | undefined,
): AttachmentMeta[] {
  const promptKindByPath = new Map(
    (contexts ?? [])
      .filter((context) => isChatAttachmentPromptKind(context.promptKind))
      .map((context) => [context.attachmentPath, context.promptKind] as const),
  );
  return paths.map((path) => {
    const promptKind = promptKindByPath.get(path);
    return {
      filename: getFilenameFromPath(path),
      absolutePath: path,
      ...(promptKind ? { promptKind } : {}),
    };
  });
}

export function QueuedMessageEditor({
  message,
  index,
  composerTab,
  onCancel,
  onSave,
  scheduleEnabled = false,
  autoFocus,
}: QueuedMessageEditorProps): JSX.Element {
  const receivingContext = useAgentSentReceivingContext();
  const useChatStore = useChatSurfaceStore(useLiveChatStore);
  // The chat this edit opened in, so text the editor closes on without Save
  // or Cancel is kept there if the message has left its queue (CAN-6799).
  const [openedIn] = useState(() =>
    findQueuedEditScope(useChatStore.getState(), message),
  );
  const closedByUser = useRef(false);
  const agentSent = message.agentSent ?? message.dispatchOptions?.agentSent;
  const [attachments, setAttachments] = useState<AttachmentMeta[]>(() =>
    attachmentPathsToMeta(
      message.attachmentPaths ?? [],
      message.attachmentPromptContexts,
    ),
  );

  const handleAddAttachments = useCallback(
    (additions: AttachmentMeta[]): void => {
      if (additions.length === 0) return;
      setAttachments((current) => {
        const seen = new Set(current.map((a) => a.absolutePath));
        const next = [...current];
        for (const attachment of additions) {
          if (!seen.has(attachment.absolutePath)) {
            next.push(attachment);
            seen.add(attachment.absolutePath);
          }
        }
        return next;
      });
    },
    [],
  );

  const handleRemoveAttachment = useCallback((absolutePath: string): void => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.absolutePath !== absolutePath),
    );
  }, []);

  const handleSave = useCallback(
    (
      text: string,
      fileReferences: FileReference[],
      attachmentPaths: string[],
      attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
      inputMode: 'typed' | 'voice',
      scheduledSendDraft: { runAt: string } | undefined,
    ): void => {
      closedByUser.current = true;
      onSave(
        index,
        text,
        fileReferences,
        attachmentPaths,
        attachmentPromptContexts,
        inputMode,
        scheduledSendDraft,
        message,
      );
    },
    [index, onSave, message],
  );

  const handleCancel = useCallback((): void => {
    closedByUser.current = true;
    onCancel();
  }, [onCancel]);

  const handleUnmount = useCallback(
    (text: string): void => {
      if (closedByUser.current || openedIn === undefined) return;
      useChatStore.getState().keepQueuedEditIfRowLeft(openedIn, message, text);
    },
    [message, openedIn, useChatStore],
  );

  const editingState: ChatInputEditingState = {
    autoFocus,
    initialText: message.text,
    initialFileReferences: message.fileReferences ?? [],
    attachments,
    onAddAttachments: handleAddAttachments,
    onRemoveAttachment: handleRemoveAttachment,
    onCancel: handleCancel,
    onSave: handleSave,
    onUnmount: handleUnmount,
    scheduledSendDraft: message.scheduledSendDraft,
    scheduleEnabled,
  };

  return (
    <>
      {agentSent && (
        <AgentSentTitle
          agentSent={agentSent}
          receivingContext={receivingContext}
        />
      )}
      <ChatInput tab={composerTab} editingState={editingState} />
    </>
  );
}
