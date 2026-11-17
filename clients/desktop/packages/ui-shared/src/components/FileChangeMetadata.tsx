import type { JSX } from 'react';
import { DiffLineCounts } from './DiffLineCounts';
import { DiffFileStatusMarker } from './diff/DiffFileTree';

/**
 * Closed set of file-change statuses surfaced in the Changed Files section,
 * the diff sidebar, and any future per-file activity feed.
 */
export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'type-changed'
  | 'untracked'
  | 'unknown';

const STATUS_LABELS: Record<FileChangeStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  unmerged: 'Unmerged',
  'type-changed': 'Type changed',
  untracked: 'Untracked',
  unknown: 'Unknown',
};

export interface FileChangeMetadataProps {
  /** Insertion count. Hidden when undefined or zero. */
  insertions?: number;
  /** Deletion count. Hidden when undefined or zero. */
  deletions?: number;
  /** File status; renders the colored dot at the end. */
  status: FileChangeStatus;
  /** Hide the metadata when the parent is in a "hover-action" state — used
   * by Changed Files to swap +/- counts for the revert button. */
  hideOnHover?: boolean;
}

/**
 * `+N -M` insertion/deletion text plus a status dot. Pure display; both
 * Changed Files (desktop + web) and the file-tree sidebar render this.
 */
export function FileChangeMetadata({
  insertions,
  deletions,
  status,
  hideOnHover = false,
}: FileChangeMetadataProps): JSX.Element {
  const hiddenClass = hideOnHover
    ? 'group-hover:hidden group-focus-within:hidden'
    : '';
  const label = STATUS_LABELS[status];
  return (
    <>
      <DiffLineCounts
        insertions={insertions}
        deletions={deletions}
        className={`shrink-0 ${hiddenClass}`}
      />
      <DiffFileStatusMarker
        status={status}
        label={label}
        size="regular"
        className={hiddenClass}
      />
    </>
  );
}
