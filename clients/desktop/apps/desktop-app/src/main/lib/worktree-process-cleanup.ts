import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type {
  CapturedLinuxOwner,
  LinuxWriterInspectionInput,
  LinuxWriterInspectionResult,
} from './linux-writer-inspection';

const execFileAsync = promisify(execFile);
const TERMINATION_GRACE_MS = 750;
const PROCESS_LIST_TIMEOUT_MS = 5_000;
const POSIX_COMMAND_READ_CONCURRENCY = 16;
const EXIT_CHECK_COUNT = 20;
const EXIT_CHECK_DELAY_MS = 25;

/**
 * Why cleanup stopped, as a privacy-safe code: an app-owned writer still
 * holds the worktree, the inspection could not finish so nothing is proved,
 * or a terminated process outlived its kill.
 */
export type WorktreeProcessCleanupCode =
  | 'WORKTREE_WRITERS_ACTIVE'
  | 'WORKTREE_WRITER_INSPECTION_INCOMPLETE'
  | 'WORKTREE_PROCESSES_ALIVE';

export class WorktreeProcessCleanupError extends Error {
  constructor(
    message: string,
    readonly code: WorktreeProcessCleanupCode = 'WORKTREE_WRITERS_ACTIVE',
  ) {
    super(message);
  }
}

interface LinuxWriterVerificationOps {
  findWriters(paths: readonly string[]): Promise<number[]>;
  delay(ms: number): Promise<void>;
  inspect: LinuxWriterInspector;
  additionalPaths: readonly string[];
}

/** One inspection of the app's process tree for writers into the given paths. */
export type LinuxWriterInspector = (
  input: LinuxWriterInspectionInput,
) => Promise<LinuxWriterInspectionResult>;

// The walk runs on a worker thread with synchronous /proc reads, so its cost
// no longer depends on how busy the main thread is (CAN-6899). Past either
// bound nothing is proved, and removal is refused.
const INSPECTION_BUDGET_MS = 10_000;
const INSPECTION_TIMEOUT_MS = 15_000;
const INCOMPLETE_INSPECTION_MESSAGE =
  'App-owned writer inspection did not finish; cleanup is incomplete.';

let inspectionWorkerEntry: string | undefined;
let inspectionProcRoot = '/proc';
let inspectionTimeoutMs = INSPECTION_TIMEOUT_MS;

/** Test seam: the worker entry to run, the /proc tree it reads, and its time limit. */
export function __setLinuxWriterInspectionWorkerForTests(
  entry: string | undefined,
  procRoot = '/proc',
  timeoutMs = INSPECTION_TIMEOUT_MS,
): void {
  inspectionWorkerEntry = entry;
  inspectionProcRoot = procRoot;
  inspectionTimeoutMs = timeoutMs;
}

let inspectorForTests: LinuxWriterInspector | undefined;

/**
 * Test seam: Jest runs sources, where the bundled worker does not exist, so
 * its setup inspects in-process with the same walk. A worker entry set
 * through `__setLinuxWriterInspectionWorkerForTests` takes precedence.
 */
export function __setLinuxWriterInspectorForTests(
  inspector: LinuxWriterInspector | undefined,
): void {
  inspectorForTests = inspector;
}

function incompleteInspection(message = INCOMPLETE_INSPECTION_MESSAGE): {
  ok: false;
  reason: 'incomplete';
  message: string;
} {
  return { ok: false, reason: 'incomplete', message };
}

function isInspectionResult(
  value: unknown,
): value is LinuxWriterInspectionResult {
  if (typeof value !== 'object' || value === null || !('ok' in value))
    return false;
  if (value.ok === true)
    return (
      'writers' in value &&
      Array.isArray(value.writers) &&
      value.writers.every((pid) => Number.isInteger(pid)) &&
      'owners' in value &&
      Array.isArray(value.owners)
    );
  return (
    value.ok === false &&
    'reason' in value &&
    (value.reason === 'incomplete' || value.reason === 'error') &&
    'message' in value &&
    typeof value.message === 'string' &&
    (!('owners' in value) || Array.isArray(value.owners))
  );
}

/** Runs one inspection on its own worker; any failure to answer is incomplete. */
/** The app inspects on its worker; see `__setLinuxWriterInspectorForTests`. */
const defaultInspector: LinuxWriterInspector = (input) =>
  inspectionWorkerEntry === undefined && inspectorForTests !== undefined
    ? inspectorForTests(input)
    : inspectOnWorker(input);

const inspectOnWorker: LinuxWriterInspector = (input) =>
  new Promise((resolveResult) => {
    let settled = false;
    let worker: Worker | undefined;
    const finish = (result: LinuxWriterInspectionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate().catch(() => undefined);
      resolveResult(result);
    };
    const timer = setTimeout(
      () => finish(incompleteInspection()),
      inspectionTimeoutMs,
    );
    try {
      worker = new Worker(
        inspectionWorkerEntry ??
          join(__dirname, 'linux-writer-inspection-worker.js'),
        {
          workerData: { input, procRoot: inspectionProcRoot },
          name: 'linux-writer-inspection',
        },
      );
    } catch {
      finish(incompleteInspection());
      return;
    }
    worker.once('message', (message: unknown) =>
      finish(isInspectionResult(message) ? message : incompleteInspection()),
    );
    worker.once('error', () => finish(incompleteInspection()));
    worker.once('exit', () => finish(incompleteInspection()));
  });

interface LinuxProcFs {
  readFile(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

const linuxProcFs: LinuxProcFs = {
  readFile: (path) => readFile(path, 'utf8'),
  readlink,
  readdir,
};

async function readProc<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (
      isErrnoException(error) &&
      ['ENOENT', 'ESRCH'].includes(error.code ?? '')
    )
      return undefined;
    throw error;
  }
}

interface LinuxWriterTracking {
  owners: Map<number, CapturedLinuxOwner>;
  paths: Set<string>;
  unresolved: boolean;
  activeAttempts: number;
}

const linuxWriterTracking = new AsyncLocalStorage<LinuxWriterTracking>();
const unresolvedLinuxWorktrees = new Map<string, LinuxWriterTracking>();

function createLinuxWriterTracking(): LinuxWriterTracking {
  return {
    owners: new Map(),
    paths: new Set(),
    unresolved: false,
    activeAttempts: 0,
  };
}

/** Keep birth identities through removal and across retries of a failed worktree. */
export async function withLinuxWorktreeWriterTracking<T>(
  run: () => Promise<T>,
  worktreeKey?: string,
): Promise<T> {
  if (hostOperatingSystem() !== 'linux') return run();
  const retained =
    worktreeKey === undefined
      ? undefined
      : unresolvedLinuxWorktrees.get(worktreeKey);
  // A live-state drain can be nested in this worktree's archive lifecycle.
  if (retained !== undefined && linuxWriterTracking.getStore() === retained)
    return run();
  const tracking = retained ?? createLinuxWriterTracking();
  if (worktreeKey !== undefined)
    unresolvedLinuxWorktrees.set(worktreeKey, tracking);
  // A rejected lifecycle keeps its snapshot, even when cancellation failed before
  // verification. No expiry can prove that an orphan has closed its handles.
  tracking.activeAttempts += 1;
  try {
    const result = await linuxWriterTracking.run(tracking, run);
    if (
      worktreeKey !== undefined &&
      tracking.activeAttempts === 1 &&
      !tracking.unresolved &&
      unresolvedLinuxWorktrees.get(worktreeKey) === tracking
    )
      unresolvedLinuxWorktrees.delete(worktreeKey);
    return result;
  } finally {
    tracking.activeAttempts -= 1;
  }
}

async function inspectLinuxWriters(
  paths: readonly string[],
  tracking: LinuxWriterTracking,
  inspect: LinuxWriterInspector,
): Promise<number[]> {
  for (const path of paths) tracking.paths.add(path);
  tracking.unresolved = true;
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race<LinuxWriterInspectionResult>([
    inspect({
      rootPid: process.pid,
      worktreePaths: [...tracking.paths],
      owners: [...tracking.owners],
      budgetMs: INSPECTION_BUDGET_MS,
    }).catch(() => incompleteInspection()),
    new Promise<LinuxWriterInspectionResult>((resolveTimeout) => {
      timer = setTimeout(
        () => resolveTimeout(incompleteInspection()),
        inspectionTimeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  // As far as the walk got, also when it failed: a writer it saw stays
  // tracked through a reparent before the retry. A worker that never
  // answered leaves the earlier owners as they were.
  if (result.ok || result.owners !== undefined) {
    tracking.owners.clear();
    for (const [pid, owner] of result.owners ?? [])
      tracking.owners.set(pid, owner);
  }
  if (!result.ok) {
    if (result.reason === 'incomplete')
      throw new WorktreeProcessCleanupError(
        result.message,
        'WORKTREE_WRITER_INSPECTION_INCOMPLETE',
      );
    throw Object.assign(
      new Error(result.message),
      result.code === undefined ? {} : { code: result.code },
    );
  }
  tracking.unresolved = result.writers.length > 0;
  return result.writers;
}

async function readLinuxProcessIdentity(
  pid: number,
  procFs: LinuxProcFs = linuxProcFs,
): Promise<string | undefined> {
  const stat = await readProc(() => procFs.readFile(`/proc/${pid}/stat`));
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

/** Capture live owners before cancellation, including writers later reparented. */
export async function captureLinuxWorktreeWriterVerification(
  worktreePath: string,
  inspect: LinuxWriterInspector = defaultInspector,
): Promise<() => Promise<void>> {
  if (hostOperatingSystem() !== 'linux') return async (): Promise<void> => {};
  const paths = await resolveCleanupWorktreePaths(worktreePath);
  const tracking =
    linuxWriterTracking.getStore() ?? createLinuxWriterTracking();
  await inspectLinuxWriters(paths, tracking, inspect);
  return async (): Promise<void> => {
    await withLinuxWorktreeRemovalVerification(worktreePath, async () => {}, {
      findWriters: () => inspectLinuxWriters(paths, tracking, inspect),
    });
  };
}

/** A successful unlink on Linux says nothing about an old writable descriptor. */
export async function withLinuxWorktreeRemovalVerification<T>(
  worktreePath: string,
  remove: () => Promise<T>,
  overrides: Partial<LinuxWriterVerificationOps> = {},
): Promise<T> {
  if (hostOperatingSystem() !== 'linux') return remove();
  const paths = (
    await Promise.all(
      [worktreePath, ...(overrides.additionalPaths ?? [])].map((path) =>
        resolveCleanupWorktreePaths(path),
      ),
    )
  )
    .flat()
    .map((path) => resolve(path));
  const tracking =
    linuxWriterTracking.getStore() ?? createLinuxWriterTracking();
  const findWriters =
    overrides.findWriters ??
    ((candidates: readonly string[]): Promise<number[]> =>
      inspectLinuxWriters(
        candidates,
        tracking,
        overrides.inspect ?? defaultInspector,
      ));
  const delay =
    overrides.delay ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const verify = async (removed: boolean): Promise<void> => {
    const deadline = Date.now() + 2_000;
    for (let check = 0; ; check += 1) {
      const writers = await findWriters(paths);
      if (writers.length === 0) return;
      if (check >= EXIT_CHECK_COUNT || Date.now() >= deadline) {
        throw new WorktreeProcessCleanupError(
          removed
            ? `The directory was removed at ${worktreePath}, but app-owned writers are still active (${writers.join(', ')}); cleanup is incomplete.`
            : `The directory was retained at ${worktreePath} because app-owned writers are still active (${writers.join(', ')}).`,
        );
      }
      await delay(EXIT_CHECK_DELAY_MS);
    }
  };
  await verify(false);
  const result = await remove();
  await verify(true);
  return result;
}

export interface ProcessRow {
  pid: number;
  parentPid: number;
  command: string;
}

interface WorktreeProcessCleanupOps {
  currentPid: number;
  listProcesses(): Promise<ProcessRow[]>;
  protectedPids(rows: readonly ProcessRow[]): Set<number>;
  kill(pid: number, signal: NodeJS.Signals): void;
  isAlive(pid: number): boolean | Promise<boolean>;
  processIdentity(pid: number): Promise<string | undefined>;
  delay(ms: number): Promise<void>;
  resolveRealPath(path: string): Promise<string>;
}

export async function readPosixProcessRows(
  pidOutput: string,
  readProcess: (pid: number) => Promise<string>,
): Promise<ProcessRow[]> {
  const pids = pidOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
  const rows: Array<ProcessRow | undefined> = pids.map(() => undefined);
  let nextIndex = 0;
  const readNext = async (): Promise<void> => {
    while (nextIndex < pids.length) {
      const index = nextIndex;
      nextIndex += 1;
      const expectedPid = pids[index];
      try {
        const output = await readProcess(expectedPid);
        const lineEnd = output.search(/[\r\n]/);
        const firstLine = lineEnd >= 0 ? output.slice(0, lineEnd) : output;
        const continuation =
          lineEnd >= 0 ? output.slice(lineEnd).replace(/^[\r\n]+/, '') : '';
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(firstLine);
        if (!match || Number(match[1]) !== expectedPid) continue;
        const command = `${match[3]} ${continuation}`
          .replace(/[\r\n\t]+/g, ' ')
          .trim();
        rows[index] = {
          pid: expectedPid,
          parentPid: Number(match[2]),
          command,
        };
      } catch {
        // The process may exit between the PID snapshot and its detail read.
      }
    }
  };
  const workerCount = Math.min(POSIX_COMMAND_READ_CONCURRENCY, pids.length);
  await Promise.all(Array.from({ length: workerCount }, () => readNext()));
  return rows.filter((row): row is ProcessRow => row !== undefined);
}

async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    const script = buildWindowsProcessListScript();
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: PROCESS_LIST_TIMEOUT_MS,
      },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const [pid, parentPid, ...command] = line.split('\t');
        return /^\d+$/.test(pid) && /^\d+$/.test(parentPid)
          ? [
              {
                pid: Number(pid),
                parentPid: Number(parentPid),
                command: command.join('\t'),
              },
            ]
          : [];
      });
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid='], {
    encoding: 'utf8',
    timeout: PROCESS_LIST_TIMEOUT_MS,
  });
  return readPosixProcessRows(stdout, async (pid) => {
    const result = await execFileAsync(
      'ps',
      ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,command='],
      { encoding: 'utf8', timeout: PROCESS_LIST_TIMEOUT_MS },
    );
    return result.stdout;
  });
}

export function buildWindowsProcessListScript(): string {
  return [
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $command = [string]$_.CommandLine -replace "`r|`n|`t", " "',
    '  Write-Output ("{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $command)',
    '}',
  ].join('\n');
}

export function protectedPidsForCurrentProcess(
  rows: readonly ProcessRow[],
  currentPid = process.pid,
): Set<number> {
  // Linux removal targets app-owned descendants; only our own process and
  // ancestors must be protected there. Other platforms retain their policy.
  const protectedPids =
    hostOperatingSystem() === 'linux'
      ? new Set([currentPid])
      : descendantPids(rows, currentPid);
  const byPid = new Map(rows.map((row) => [row.pid, row]));

  let cursor = byPid.get(currentPid);
  while (
    cursor &&
    cursor.parentPid > 0 &&
    !protectedPids.has(cursor.parentPid)
  ) {
    protectedPids.add(cursor.parentPid);
    cursor = byPid.get(cursor.parentPid);
  }
  return protectedPids;
}

function descendantPids(
  rows: readonly ProcessRow[],
  currentPid: number,
): Set<number> {
  const descendants = new Set<number>([currentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }

  return descendants;
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort: processes can exit between enumeration and signaling.
  }
}

async function defaultIsAlive(pid: number): Promise<boolean> {
  if (hostOperatingSystem() === 'linux') {
    const stat = await readProc(() =>
      linuxProcFs.readFile(`/proc/${pid}/stat`),
    );
    if (stat === undefined) return false;
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0];
    // A zombie holds no writable descriptors and cannot write again.
    if (state === 'Z' || state === 'X') return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

const defaultOps: WorktreeProcessCleanupOps = {
  currentPid: process.pid,
  listProcesses,
  protectedPids: protectedPidsForCurrentProcess,
  kill: defaultKill,
  isAlive: defaultIsAlive,
  processIdentity: (pid) =>
    hostOperatingSystem() === 'linux'
      ? readLinuxProcessIdentity(pid)
      : Promise.resolve(undefined),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  resolveRealPath: realpath,
};

export async function resolveCleanupWorktreePaths(
  worktreePath: string,
  resolveRealPath: (path: string) => Promise<string> = realpath,
): Promise<string[]> {
  const absolutePath = resolve(worktreePath);
  try {
    const [resolvedPath, resolvedParent] = await Promise.all([
      resolveRealPath(absolutePath),
      resolveRealPath(dirname(absolutePath)),
    ]);
    const expectedPath = resolve(resolvedParent, basename(absolutePath));
    const normalize = (value: string): string =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    return normalize(resolvedPath) === normalize(expectedPath)
      ? Array.from(new Set([worktreePath, resolvedPath]))
      : [worktreePath];
  } catch {
    return [worktreePath];
  }
}

export function selectProcessesReferencingPath(
  rows: readonly ProcessRow[],
  worktreePaths: string | readonly string[],
  protectedPids: ReadonlySet<number>,
): number[] {
  const paths: readonly string[] =
    typeof worktreePaths === 'string' ? [worktreePaths] : worktreePaths;
  const normalize = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const normalizedPaths = paths.map(normalize);
  const referencesWorktree = (rawCommand: string): boolean => {
    const command = normalize(rawCommand);
    return normalizedPaths.some((candidate) => {
      let offset = command.indexOf(candidate);
      while (offset >= 0) {
        const previous = command[offset - 1];
        const next = command[offset + candidate.length];
        const hasLeadingBoundary =
          previous === undefined || /[\s=\\"']/.test(previous);
        const hasTrailingBoundary =
          next === undefined || /[\s/\\"']/.test(next);
        if (hasLeadingBoundary && hasTrailingBoundary) return true;
        offset = command.indexOf(candidate, offset + 1);
      }
      return false;
    });
  };
  const selected = new Set(
    rows
      .filter(
        (row) => !protectedPids.has(row.pid) && referencesWorktree(row.command),
      )
      .map((row) => row.pid),
  );
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const depth = (pid: number): number => {
    let value = 0;
    let cursor = byPid.get(pid);
    const seen = new Set<number>();
    while (cursor && selected.has(cursor.parentPid) && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      value += 1;
      cursor = byPid.get(cursor.parentPid);
    }
    return value;
  };
  return Array.from(selected).sort((left, right) => depth(right) - depth(left));
}

export async function terminateProcessesReferencingPath(
  worktreePath: string,
  overrides: Partial<WorktreeProcessCleanupOps> = {},
): Promise<number> {
  const ops = { ...defaultOps, ...overrides };
  const rows = await ops.listProcesses();
  const worktreePaths = await resolveCleanupWorktreePaths(
    worktreePath,
    ops.resolveRealPath,
  );
  const owned = descendantPids(rows, ops.currentPid);
  const pids = selectProcessesReferencingPath(
    rows,
    worktreePaths,
    ops.protectedPids(rows),
  ).filter((pid) => hostOperatingSystem() !== 'linux' || owned.has(pid));
  const initialRows = new Map(rows.map((row) => [row.pid, row]));
  const initialIdentities = new Map(
    await Promise.all(
      pids.map(
        async (pid): Promise<[number, string | undefined]> => [
          pid,
          await ops.processIdentity(pid),
        ],
      ),
    ),
  );
  for (const pid of pids) ops.kill(pid, 'SIGTERM');
  if (pids.length === 0) return 0;
  await ops.delay(TERMINATION_GRACE_MS);
  const remainingRows = new Map(
    (await ops.listProcesses()).map((row) => [row.pid, row]),
  );
  for (const pid of pids) {
    const initial = initialRows.get(pid);
    const remaining = remainingRows.get(pid);
    if (
      initial &&
      remaining &&
      initial.command === remaining.command &&
      (await ops.isAlive(pid)) &&
      (initialIdentities.get(pid) === undefined ||
        initialIdentities.get(pid) === (await ops.processIdentity(pid)))
    ) {
      ops.kill(pid, 'SIGKILL');
    }
  }
  if (hostOperatingSystem() === 'linux') {
    const deadline = Date.now() + 2_000;
    for (let check = 0; ; check += 1) {
      const alive: number[] = [];
      for (const pid of pids) {
        const initial = initialRows.get(pid);
        const remaining = remainingRows.get(pid);
        if (
          initial &&
          remaining &&
          initial.command === remaining.command &&
          (await ops.isAlive(pid)) &&
          (initialIdentities.get(pid) === undefined ||
            initialIdentities.get(pid) === (await ops.processIdentity(pid)))
        )
          alive.push(pid);
      }
      if (alive.length === 0) break;
      if (check >= EXIT_CHECK_COUNT || Date.now() >= deadline) {
        throw new WorktreeProcessCleanupError(
          `Worktree processes are still alive after termination (${alive.join(', ')}).`,
          'WORKTREE_PROCESSES_ALIVE',
        );
      }
      await ops.delay(EXIT_CHECK_DELAY_MS);
    }
  }
  return pids.length;
}
