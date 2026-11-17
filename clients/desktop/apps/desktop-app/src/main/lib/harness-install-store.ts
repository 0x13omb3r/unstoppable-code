import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';

// ---------------------------------------------------------------------------
// One record file for one Add for every harness: MCP servers (CAN-6815,
// `mcp-servers/harness-installs.json`) and plugins and skills (CAN-6816,
// `plugin-harness-installs.json`). Each file holds one collection of records
// keyed by item; the records are display data that sit on top of an install
// and never replace it.
// ---------------------------------------------------------------------------

const STORE_VERSION = 1;

export interface HarnessInstallRecordStore<T> {
  read(): Promise<Record<string, T>>;
  /** Replaces one item's record, or removes it with `undefined`. */
  write(key: string, record: T | undefined): Promise<void>;
  /**
   * Reads one item's current record and writes what `change` returns, in one
   * step no other write to this store can interleave with, so concurrent
   * changes to one item never restore each other's stale state. `change`
   * returning `undefined` removes the record. Resolves the written record.
   */
  update(
    key: string,
    change: (current: T | undefined) => T | undefined,
  ): Promise<T | undefined>;
  /**
   * Removes one item's record for good, after its item was uninstalled
   * (CAN-6817). A failed write is tried twice more; while it fails, every
   * read in this process leaves the record out and the next write that
   * succeeds drops it, so a record left on disk has no effect here. Resolves
   * whether the record is off the disk.
   */
  remove(key: string): Promise<boolean>;
}

export interface HarnessInstallStoreDisk {
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Attempts to remove a record whose write failed, back to back. */
const REMOVE_ATTEMPTS = 3;

// Records whose removal has not reached the disk yet, per record file, each
// with the marker of its latest removal. Module-wide, so every store
// instance on one file (the IPC handlers' and the Claude session resolver's)
// leaves them out. A write clears only the markers it saw when it started,
// so a removal made while a write is in flight is never cleared by it.
const pendingRemovals = new Map<string, Map<string, number>>();
let nextRemovalMarker = 1;

function pendingFor(path: string): Map<string, number> {
  let pending = pendingRemovals.get(path);
  if (pending === undefined) {
    pending = new Map();
    pendingRemovals.set(path, pending);
  }
  return pending;
}

/** Clears `key`'s marker only if it is still the one `seen` holds. */
function clearIfSeen(
  pending: Map<string, number>,
  seen: ReadonlyMap<string, number>,
  key: string,
): void {
  const marker = seen.get(key);
  if (marker !== undefined && pending.get(key) === marker) pending.delete(key);
}

const productionDisk: HarnessInstallStoreDisk = {
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  },
  // A fresh data folder may not exist yet when the first record is written.
  writeText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomically(path, text);
  },
};

/**
 * A record file. Writes rewrite only the named item's record and keep every
 * other entry as found, including ones this version cannot read. A file a
 * newer app wrote is read around and never written.
 */
export function createHarnessInstallRecordStore<T>(options: {
  readonly path: () => string;
  /** The top-level key holding the records, e.g. `servers`. */
  readonly collection: string;
  readonly parse: (value: unknown) => T | undefined;
  readonly newerError: () => Error;
  readonly disk?: HarnessInstallStoreDisk;
}): HarnessInstallRecordStore<T> {
  const { path, collection, parse, newerError } = options;
  const disk = options.disk ?? productionDisk;
  let queue: Promise<unknown> = Promise.resolve();
  // The errors this store threw for a file a newer app wrote.
  const newerErrors = new WeakSet<Error>();
  const readRaw = async (): Promise<{
    entries: Record<string, unknown>;
    newer: boolean;
  }> => {
    const text = await disk.readText(path());
    if (text === undefined) return { entries: {}, newer: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Our own display data: an unreadable file starts over.
      return { entries: {}, newer: false };
    }
    if (!isRecord(parsed)) return { entries: {}, newer: false };
    if (typeof parsed.version === 'number' && parsed.version > STORE_VERSION)
      return { entries: {}, newer: true };
    const entries = parsed[collection];
    return {
      entries: isRecord(entries) ? { ...entries } : {},
      newer: false,
    };
  };
  const update: HarnessInstallRecordStore<T>['update'] = (key, change) => {
    const run = queue.then(async () => {
      const file = path();
      const pending = pendingFor(file);
      const { entries, newer } = await readRaw();
      if (newer) {
        const error = newerError();
        newerErrors.add(error);
        throw error;
      }
      // A removal that has not reached the disk yet goes with this write.
      const seen = new Map(pending);
      const flushed = [...seen.keys()].filter((removed) => removed in entries);
      for (const removed of flushed) delete entries[removed];
      // A key written again is a new install; it is no longer removed.
      const removedBefore = seen.has(key);
      const current =
        !removedBefore && Object.prototype.hasOwnProperty.call(entries, key)
          ? parse(entries[key])
          : undefined;
      const record = change(current);
      if (record === undefined) {
        if (!(key in entries) && flushed.length === 0) {
          clearIfSeen(pending, seen, key);
          return undefined;
        }
        delete entries[key];
      } else entries[key] = record;
      await disk.writeText(
        file,
        `${JSON.stringify({ version: STORE_VERSION, [collection]: entries }, null, 2)}\n`,
      );
      for (const removed of flushed) clearIfSeen(pending, seen, removed);
      clearIfSeen(pending, seen, key);
      return record;
    });
    queue = run.catch(() => undefined);
    return run;
  };
  const remove: HarnessInstallRecordStore<T>['remove'] = async (key) => {
    const file = path();
    // Left out of every read from now on, even if no write ever succeeds.
    pendingFor(file).set(key, nextRemovalMarker++);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await update(key, () => undefined);
        return true;
      } catch (error) {
        // A file a newer app wrote is never written, so retrying cannot help.
        const newer = error instanceof Error && newerErrors.has(error);
        if (newer || attempt >= REMOVE_ATTEMPTS) return false;
      }
    }
  };
  return {
    async read() {
      const { entries } = await readRaw();
      const pending = pendingFor(path());
      const records: Record<string, T> = {};
      for (const [key, value] of Object.entries(entries)) {
        if (pending.has(key)) continue;
        const record = parse(value);
        if (record !== undefined) records[key] = record;
      }
      return records;
    },
    write: (key, record) => update(key, () => record).then(() => undefined),
    update,
    remove,
  };
}
