import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// A short digest of the folder one harness's session reads an item from
// (CAN-6817), kept with the item's per-harness install record so a copy
// changed or removed outside the app shows on its row.
//
// The digest covers every file's relative path and size, and the full text
// of the files that say what loads (manifests, `SKILL.md`, MCP and hook
// tables). It never reads modification times, which installs and copies do
// not keep, so an untouched copy keeps its digest. The walk is bounded and
// skips `.git` and `node_modules`; a folder past the bound digests what it
// walked plus a marker, which still changes when that part changes.
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 2_000;
const MAX_DEPTH = 8;
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const CONTENT_FILES = new Set([
  'SKILL.md',
  'plugin.json',
  'marketplace.json',
  '.mcp.json',
  'hooks.json',
]);
/** Longest file read in full; larger ones count by size only. */
const MAX_CONTENT_BYTES = 256 * 1024;
/** How long one digest is reused: rows are served often, copies rarely change. */
const CACHE_TTL_MS = 5_000;

const cache = new Map<string, { at: number; digest: string | undefined }>();

/**
 * The digest of `folder`, or `undefined` when it cannot be read (it is not a
 * folder, or a read failed). Unreadable is not changed: callers flag nothing.
 */
export function harnessCopyFingerprint(
  folder: string,
  options: {
    /** Skip the cache: a digest that is saved must be the copy as it is now. */
    readonly fresh?: boolean;
    readonly now?: number;
  } = {},
): string | undefined {
  const now = options.now ?? Date.now();
  const cached = cache.get(folder);
  if (
    options.fresh !== true &&
    cached !== undefined &&
    now - cached.at < CACHE_TTL_MS
  )
    return cached.digest;
  const digest = digestFolder(folder);
  cache.set(folder, { at: now, digest });
  return digest;
}

/** Drops cached digests, after this app writes a copy itself. */
export function forgetHarnessCopyFingerprints(): void {
  cache.clear();
}

function digestFolder(folder: string): string | undefined {
  try {
    if (!fs.statSync(folder).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const hash = createHash('sha256');
  const lines: string[] = [];
  let entries = 0;
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    const children = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (entries >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      entries += 1;
      const full = path.join(dir, child.name);
      const relative = path.relative(folder, full).split(path.sep).join('/');
      if (child.isDirectory()) {
        if (SKIPPED_DIRS.has(child.name)) continue;
        lines.push(`d ${relative}`);
        if (depth < MAX_DEPTH) walk(full, depth + 1);
        continue;
      }
      if (!child.isFile()) {
        lines.push(`o ${relative}`);
        continue;
      }
      const size = fs.statSync(full).size;
      lines.push(`f ${relative} ${size}`);
      if (CONTENT_FILES.has(child.name) && size <= MAX_CONTENT_BYTES)
        lines.push(
          `c ${relative} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`,
        );
    }
  };
  try {
    walk(folder, 0);
  } catch {
    return undefined;
  }
  if (truncated) lines.push('truncated');
  hash.update(lines.join('\n'));
  return hash.digest('hex').slice(0, 32);
}
