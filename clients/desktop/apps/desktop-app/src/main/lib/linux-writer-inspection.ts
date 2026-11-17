/**
 * The Linux app-owned writer inspection (CAN-6899), synchronous so it can run
 * on a worker thread: one walk of the app's process tree costs thousands of
 * /proc reads, which a loaded main thread could not finish in time. No
 * Electron or app imports; the worker and tests load it directly.
 */

export interface SyncLinuxProcFs {
  readFile(path: string): string;
  readlink(path: string): string;
  readdir(path: string): string[];
}

export interface CapturedLinuxOwner {
  identity: string;
  worktreeRelated: boolean;
}

export interface LinuxWriterInspectionInput {
  /** The app's main process, whose tree is inspected. */
  rootPid: number;
  worktreePaths: readonly string[];
  /** Owners captured by earlier inspections of this worktree. */
  owners: ReadonlyArray<readonly [number, CapturedLinuxOwner]>;
  /** Time the inspection may take before it refuses as incomplete. */
  budgetMs: number;
}

export type LinuxWriterInspectionResult =
  | {
      readonly ok: true;
      readonly writers: number[];
      readonly owners: Array<[number, CapturedLinuxOwner]>;
    }
  | {
      readonly ok: false;
      /** `incomplete`: nothing is proved. `error`: a /proc read failed. */
      readonly reason: 'incomplete' | 'error';
      readonly message: string;
      readonly code?: string;
      /**
       * Owners as far as the walk got: a writer seen before the failure stays
       * tracked if it is reparented before the retry.
       */
      readonly owners?: Array<[number, CapturedLinuxOwner]>;
    };

class InspectionIncomplete extends Error {}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isProcPermissionError(error: unknown): boolean {
  return ['EACCES', 'EPERM'].includes(errnoCode(error) ?? '');
}

function readProc<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(errnoCode(error) ?? '')) return undefined;
    throw error;
  }
}

export function pathReferencesWorktree(
  path: string,
  worktreePaths: readonly string[],
): boolean {
  const entry = path.replace(/ \(deleted\)$/, '');
  return worktreePaths.some(
    (candidate) => entry === candidate || entry.startsWith(`${candidate}/`),
  );
}

function readIdentity(
  pid: number,
  procFs: SyncLinuxProcFs,
): string | undefined {
  const stat = readProc(() => procFs.readFile(`/proc/${pid}/stat`));
  if (stat === undefined) return undefined;
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  // A process can become a zombie between reading stat and opening fd. Linux
  // may deny fd inspection then, but an exited process has no writable handles.
  if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
  return fields[19];
}

/** Inspect only this app's process tree; unreadable unrelated terminals are not owners. */
export function inspectLinuxWritersSync(
  input: LinuxWriterInspectionInput,
  procFs: SyncLinuxProcFs,
  now: () => number = Date.now,
): LinuxWriterInspectionResult {
  const owners = new Map(input.owners.map(([pid, owner]) => [pid, owner]));
  try {
    const writers = walk(input, owners, procFs, now);
    return { ok: true, writers, owners: [...owners] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof InspectionIncomplete)
      return { ok: false, reason: 'incomplete', message, owners: [...owners] };
    const code = errnoCode(error);
    return {
      ok: false,
      reason: 'error',
      message,
      owners: [...owners],
      ...(code === undefined ? {} : { code }),
    };
  }
}

function walk(
  input: LinuxWriterInspectionInput,
  owners: Map<number, CapturedLinuxOwner>,
  procFs: SyncLinuxProcFs,
  now: () => number,
): number[] {
  const { rootPid, worktreePaths } = input;
  const deadline = now() + input.budgetMs;
  const checkDeadline = (): void => {
    if (now() >= deadline)
      throw new InspectionIncomplete(
        'App-owned writer inspection exceeded its deadline; cleanup is incomplete.',
      );
  };
  const pending: Array<{
    pid: number;
    worktreeRelated: boolean;
    identity?: string;
  }> = [{ pid: rootPid, worktreeRelated: false }];
  // Retain birth identities across reparenting without adopting reused PIDs.
  for (const [pid, owner] of owners) {
    checkDeadline();
    try {
      if (readIdentity(pid, procFs) === owner.identity)
        pending.push({
          pid,
          worktreeRelated: owner.worktreeRelated,
          identity: owner.identity,
        });
      else owners.delete(pid);
    } catch (error) {
      if (owner.worktreeRelated || !isProcPermissionError(error)) throw error;
    }
  }
  const seen = new Map<number, boolean>();
  const writers = new Set<number>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined) continue;
    const previous = seen.get(candidate.pid);
    if (previous === true || (previous === false && !candidate.worktreeRelated))
      continue;
    const { pid } = candidate;
    checkDeadline();
    const root = `/proc/${pid}`;
    let inspectionFailure: Error | undefined;
    // A denied cwd must not hide readable argv, handles, or terminal ancestry.
    const readEvidence = <T>(read: () => T): T | undefined => {
      try {
        return readProc(read);
      } catch (error) {
        if (!isProcPermissionError(error)) throw error;
        inspectionFailure ??=
          error instanceof Error ? error : new Error(String(error));
        return undefined;
      }
    };
    const identity = readEvidence(() => readIdentity(pid, procFs));
    if (identity === undefined && inspectionFailure === undefined) continue;
    // A captured PID may be reused between the seed read and this inspection.
    if (candidate.identity !== undefined && identity !== candidate.identity) {
      if (inspectionFailure && (candidate.worktreeRelated || pid === rootPid))
        throw inspectionFailure;
      continue;
    }
    const cwd = readEvidence(() => procFs.readlink(`${root}/cwd`));
    const command = readEvidence(() => procFs.readFile(`${root}/cmdline`));
    const commandReferencesWorktree =
      command
        ?.split('\0')
        .some((arg) =>
          pathReferencesWorktree(
            arg.slice(arg.indexOf('=') + 1),
            worktreePaths,
          ),
        ) ?? false;
    let worktreeRelated =
      candidate.worktreeRelated || commandReferencesWorktree;
    let writing =
      cwd !== undefined && pathReferencesWorktree(cwd, worktreePaths);
    worktreeRelated ||= writing;
    const handles = readEvidence(() => procFs.readdir(`${root}/fd`));
    for (const handle of handles ?? []) {
      checkDeadline();
      const target = readEvidence(() =>
        procFs.readlink(`${root}/fd/${handle}`),
      );
      if (
        target === undefined ||
        !pathReferencesWorktree(target, worktreePaths)
      )
        continue;
      worktreeRelated = true;
      const info = readEvidence(() =>
        procFs.readFile(`${root}/fdinfo/${handle}`),
      );
      const flags =
        info === undefined ? undefined : /^flags:\s+([0-7]+)/m.exec(info);
      if (flags && (Number.parseInt(flags[1], 8) & 3) !== 0) writing = true;
    }
    const childrenToInspect: number[] = [];
    const tasks = readEvidence(() => procFs.readdir(`${root}/task`));
    for (const task of tasks ?? []) {
      const children = readEvidence(() =>
        procFs.readFile(`${root}/task/${task}/children`),
      );
      if (
        children === undefined &&
        !inspectionFailure &&
        readEvidence(() => procFs.readFile(`${root}/task/${task}/stat`)) !==
          undefined
      )
        throw new InspectionIncomplete(
          'Linux process-child inspection is unavailable; cleanup is incomplete.',
        );
      for (const child of children?.trim().split(/\s+/) ?? []) {
        if (/^\d+$/.test(child)) childrenToInspect.push(Number(child));
      }
    }
    let finalIdentity: string | undefined;
    try {
      finalIdentity = readIdentity(pid, procFs);
    } catch (error) {
      if (!isProcPermissionError(error) || worktreeRelated || pid === rootPid)
        throw error;
      continue;
    }
    // Do not retain descriptors or child PIDs read from a recycled process.
    if (
      finalIdentity === undefined ||
      (identity !== undefined && finalIdentity !== identity)
    )
      continue;
    seen.set(pid, worktreeRelated);
    if (identity !== undefined) owners.set(pid, { identity, worktreeRelated });
    for (const child of childrenToInspect)
      pending.push({
        pid: child,
        // Main owns many worktrees. Its open files never implicate every PTY.
        worktreeRelated: pid !== rootPid && worktreeRelated,
      });
    if (writing) {
      writers.add(pid);
    } else if (inspectionFailure && (worktreeRelated || pid === rootPid)) {
      throw inspectionFailure;
    }
  }
  return [...writers];
}
