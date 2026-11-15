import { useCallback, useContext, type JSX } from 'react';
import {
  MessageFileTile,
  MessageMediaRow,
  MessageMediaTile,
} from '@canopy/ui-shared/components';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import { useAttachmentHover } from '@/hooks/useAttachmentHover';
import { getFilenameFromPath } from '@/lib/file-type';
import type { SentAttachment } from '@/hooks/useSentAttachments';
import {
  cloudAttachmentIdOfPath,
  isCloudAttachmentPath,
} from '@/cloud-chats/cloud-chat-attachments';
import { CloudChatFileTargetContext } from '@/cloud-chats/cloud-chat-file-target';
import { useGitHubStore } from '@/stores/githubStore';

/**
 * Everything sent with a user message, inside its bubble, in the shared
 * media row the web also mounts: images and videos as the pictures
 * themselves (a video as its first frame with a play mark), other files as
 * tiles with their type and name. Clicking one opens it in the system's
 * default app; a cloud chat's attachment saves through that chat's own web
 * core read instead (CAN-6771). Resting on a file shows its preview.
 */
export function MessageImages({
  attachments,
  alone = false,
}: {
  readonly attachments: readonly SentAttachment[];
  /** The message has no text under the row. */
  readonly alone?: boolean;
}): JSX.Element | null {
  const addToast = useGitHubStore((state) => state.addToast);
  const {
    hoveredPath,
    anchorRef,
    handleMouseEnter,
    handleMouseLeave,
    popoverMouseEnter,
    popoverMouseLeave,
  } = useAttachmentHover();
  // One failure notice for both ways a tile opens its file.
  const failed = useCallback(
    (action: 'open' | 'save', absolutePath: string): void => {
      addToast(
        `Couldn't ${action} ${getFilenameFromPath(absolutePath)}.`,
        'error',
        undefined,
        { forceInApp: true },
      );
    },
    [addToast],
  );
  const open = useCallback(
    (absolutePath: string): void => {
      void window.api
        .openExternalFile({ absolutePath })
        .catch(() => failed('open', absolutePath));
    },
    [failed],
  );
  const cloudTarget = useContext(CloudChatFileTargetContext);
  const save = useCallback(
    (absolutePath: string): void => {
      const id = cloudAttachmentIdOfPath(absolutePath);
      if (cloudTarget === null || id === null) return;
      void window.api.cloudChats
        .downloadFile(cloudTarget, {
          kind: 'attachment',
          id,
          filename: getFilenameFromPath(absolutePath),
        })
        .then(
          (result) => {
            // A cancelled save dialog is no failure.
            if (!result.ok && result.reason !== 'canceled')
              failed('save', absolutePath);
          },
          () => failed('save', absolutePath),
        );
    },
    [cloudTarget, failed],
  );
  if (attachments.length === 0) return null;
  return (
    <>
      <MessageMediaRow alone={alone}>
        {attachments.map((attachment) => {
          const { absolutePath } = attachment;
          const name = getFilenameFromPath(absolutePath);
          // A cloud chat's attachment has no file on this computer to open:
          // it saves through its chat, when the transcript names one.
          const cloud = isCloudAttachmentPath(absolutePath);
          const onOpen = !cloud
            ? (): void => open(absolutePath)
            : cloudTarget !== null
              ? (): void => save(absolutePath)
              : undefined;
          return attachment.kind === 'file' ? (
            <MessageFileTile
              key={absolutePath}
              file={{
                key: absolutePath,
                name,
                ...(onOpen === undefined ? {} : { onOpen }),
                onHoverStart: (anchor): void =>
                  handleMouseEnter(absolutePath, anchor),
                onHoverEnd: handleMouseLeave,
              }}
            />
          ) : (
            <MessageMediaTile
              key={absolutePath}
              image={{
                key: absolutePath,
                src: attachment.src,
                kind: attachment.kind,
                alt: name,
                ...(onOpen === undefined ? {} : { onOpen }),
              }}
            />
          );
        })}
      </MessageMediaRow>
      {hoveredPath && (
        <AttachmentPreviewPopover
          absolutePath={hoveredPath}
          filename={getFilenameFromPath(hoveredPath)}
          anchorRef={anchorRef}
          onMouseEnter={popoverMouseEnter}
          onMouseLeave={popoverMouseLeave}
        />
      )}
    </>
  );
}
