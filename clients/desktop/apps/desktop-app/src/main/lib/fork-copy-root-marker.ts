import {
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { MULTI_REPO_CHILD_RELATIVE_PATH } from './org-project-setup-journal';
import { isPathInside } from './path-safety';
import type { SidebarItem } from '@canopy/desktop-shared/types';

/**
 * Proof that a new organization copy of a multi-repo share (CAN-4856) made a
 * staged root. The fork writes it before any other effect in the root, first
 * at the root and then, once `git init` has run, inside `.git`. Readers accept
 * either location, so no window leaves a staged root without proof. Only a
 * root carrying a marker with the expected creation key is ever removed on
 * the copy's behalf.
 */
export interface ForkCopyRootMarker {
  version: 1;
  /** The 64-hex creation key of the copy that staged this root. */
  creationKey: string;
  containerId: string;
  revisionId: string;
  repositories: Array<{ repoId: string; relativePath: string }>;
  /**
   * Set once the copy was published, so the root is a finished copy's
   * checkout, not staging: it is never re-staged or removed on the copy's
   * behalf, even after its workspace is removed and the folder kept.
   */
  published?: true;
}

const MARKER_FILENAME = 'canopy-fork-copy.json';
const STAGING_MARKER_FILENAME = `.${MARKER_FILENAME}`;
const MAX_MARKER_BYTES = 64 * 1024;

function normalizeMarker(value: unknown): ForkCopyRootMarker | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  const {
    version,
    creationKey,
    containerId,
    revisionId,
    repositories,
    published,
  } = record;
  if (
    version !== 1 ||
    (published !== undefined && published !== true) ||
    typeof creationKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(creationKey) ||
    typeof containerId !== 'string' ||
    typeof revisionId !== 'string' ||
    !Array.isArray(repositories)
  )
    return null;
  const entries: unknown[] = repositories;
  const normalized: ForkCopyRootMarker['repositories'] = [];
  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('repoId' in entry) ||
      typeof entry.repoId !== 'string' ||
      !('relativePath' in entry) ||
      typeof entry.relativePath !== 'string' ||
      !MULTI_REPO_CHILD_RELATIVE_PATH.test(entry.relativePath)
    )
      return null;
    normalized.push({ repoId: entry.repoId, relativePath: entry.relativePath });
  }
  return {
    version: 1,
    creationKey,
    containerId,
    revisionId,
    repositories: normalized,
    ...(published === true ? { published: true } : {}),
  };
}

async function readMarkerFile(
  path: string,
): Promise<ForkCopyRootMarker | null | 'absent'> {
  const info = await lstat(path).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return null;
    throw error;
  });
  if (info === null) return 'absent';
  if (!info.isFile() || info.size > MAX_MARKER_BYTES) return null;
  try {
    return normalizeMarker(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * The marker a staged root carries: `'absent'` when the root holds none (or is
 * gone), `null` when one is present but unreadable. Throws only when the root
 * itself cannot be inspected.
 */
export async function readForkCopyRootMarker(
  root: string,
): Promise<ForkCopyRootMarker | null | 'absent'> {
  const lasting = await readMarkerFile(join(root, '.git', MARKER_FILENAME));
  if (lasting !== 'absent') return lasting;
  return readMarkerFile(join(root, STAGING_MARKER_FILENAME));
}

/** Written into a root the fork just created, before any other effect there. */
export async function writeForkCopyRootMarker(
  root: string,
  marker: ForkCopyRootMarker,
): Promise<void> {
  await writeFile(join(root, STAGING_MARKER_FILENAME), JSON.stringify(marker), {
    flag: 'wx',
    mode: 0o600,
  });
}

/** Move the marker to its lasting home once the root's `.git` exists. */
export async function settleForkCopyRootMarker(root: string): Promise<void> {
  await rename(
    join(root, STAGING_MARKER_FILENAME),
    join(root, '.git', MARKER_FILENAME),
  );
}

/**
 * Record that the copy staged under `root` was published (CAN-4856), so a later
 * copy of the same key moves past it instead of re-staging it. Replaces the
 * lasting marker atomically; a root without this key's marker is left alone,
 * and an unreadable marker throws.
 */
export async function publishForkCopyRootMarker(
  root: string,
  creationKey: string,
): Promise<void> {
  const marker = await readForkCopyRootMarker(root);
  // A publish that cannot happen fails the copy rather than leave this key's
  // finished root unpublished, where a later copy could re-stage it.
  if (marker === null)
    throw new Error('Organization copy marker could not be read');
  // A root with no marker is never re-staged or removed on a copy's behalf
  // (it reads as not this copy's), so it has nothing to protect here.
  if (marker === 'absent') return;
  if (marker.creationKey !== creationKey || marker.published) return;
  const lasting = join(root, '.git', MARKER_FILENAME);
  const pending = `${lasting}.publishing`;
  try {
    await writeFile(pending, JSON.stringify({ ...marker, published: true }), {
      mode: 0o600,
    });
    await rename(pending, lasting);
  } catch (error) {
    // The lasting marker is unchanged; leave no partial copy in `.git`.
    await rm(pending, { force: true }).catch((): void => {});
    throw error;
  }
}

/**
 * Lowercased where volumes are usually case-insensitive. On a case-sensitive
 * volume there this can only over-report a reference, which keeps the root.
 */
function comparablePath(path: string): string {
  const os = hostOperatingSystem();
  return os === 'win32' || os === 'darwin' ? path.toLowerCase() : path;
}

/**
 * Whether an indexed workspace references `root` or anything under it: its
 * root, a repository, or a single checkout. Both sides are realpath'd, and
 * compared case-insensitively where the volume usually is. A workspace at an
 * ancestor of `root` is deliberately not a reference: a copy's root is its own
 * folder under the fork's parent directory, and another workspace's folder
 * containing it says nothing about whether this copy is still in use.
 */
export async function isForkCopyRootReferenced(
  root: string,
  items: readonly SidebarItem[],
): Promise<boolean> {
  const canonicalRoot = comparablePath(
    await realpath(root).catch((): string => root),
  );
  for (const item of items) {
    const paths =
      item.type === 'single-repo'
        ? [item.repoPath]
        : item.type === 'multi-repo'
          ? [item.sourceRepoPath, ...item.repos.map((repo) => repo.repoPath)]
          : [];
    for (const path of paths) {
      if (!path) continue;
      const canonical = comparablePath(
        await realpath(path).catch((): string => path),
      );
      if (isPathInside(canonicalRoot, canonical)) return true;
    }
  }
  return false;
}
