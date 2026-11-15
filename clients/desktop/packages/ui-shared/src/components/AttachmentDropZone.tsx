import type { JSX } from 'react';
import { DownloadIcon } from '../icons/AppIcons';
import { Stack } from './Stack';
import { Surface } from './Surface';

export interface AttachmentDropZoneProps {
  readonly active?: boolean;
  readonly emptyMessage?: string;
  readonly testId: string;
}

function AttachmentDropZoneContent({
  active = false,
  emptyMessage = 'Drop files here or click + to add attachments',
  iconSize = 'xl',
}: Omit<AttachmentDropZoneProps, 'testId'> & {
  readonly iconSize?: 'xl' | number;
}): JSX.Element {
  return active ? (
    <Stack gap="inline" align="center">
      <DownloadIcon size={iconSize} />
      <p className="text-xs font-medium">Drop files to attach</p>
    </Stack>
  ) : (
    <p className="text-xs fg-secondary/60">{emptyMessage}</p>
  );
}

/** Attachment presentation shared by local and hosted upload adapters. */
export function AttachmentDropZone({
  active = false,
  emptyMessage,
  testId,
}: AttachmentDropZoneProps): JSX.Element {
  return (
    <div className="flex h-full min-h-28">
      <Surface
        variant="dashed"
        size="small"
        selected={active}
        className="flex flex-1 items-center justify-center text-center"
        data-testid={testId}
      >
        <div className={active ? 'py-8 fg-accent' : 'py-8'}>
          <AttachmentDropZoneContent
            active={active}
            emptyMessage={emptyMessage}
          />
        </div>
      </Surface>
    </div>
  );
}

/** Non-interactive feedback drawn over the destination during a file drag. */
export function AttachmentDropOverlay({
  testId,
}: Pick<AttachmentDropZoneProps, 'testId'>): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed bg-base/85 text-center ring-2 ring-inset ring-line-accent fg-accent"
      style={{ borderRadius: 'inherit' }}
      data-testid={testId}
    >
      <AttachmentDropZoneContent active iconSize={24} />
    </div>
  );
}
