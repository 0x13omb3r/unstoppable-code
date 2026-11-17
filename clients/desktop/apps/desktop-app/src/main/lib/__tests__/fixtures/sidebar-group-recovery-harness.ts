import type { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import { W5CommitRefusedError } from '@canopy/core-runtime/node/w5/commit-log/errors';
import { spawn } from 'node:child_process';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { basename, join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';

export const recoveryModes = [
  'saved-unapplied',
  'application-failure',
  'keyed-reserve-refusal',
  'keyed-reserve-lost',
  'keyed-lost-reply',
  'unkeyed-lost-reply',
  'lost-reply',
  'revision-refusal',
  'absent-unknown',
  'implicit-lost-reply',
  'implicit-refusal',
  'degraded-refusal',
  'composed-lost-reply',
  'composed-refusal',
] as const;
export type RecoveryMode = (typeof recoveryModes)[number];
export const disagreementModes = [
  'worktree-second-write',
  'entry-second-write',
  'worktree-rollback-write',
  'entry-rollback-write',
  'worktree-rollback-future',
  'entry-rollback-future',
  'worktree-cleanup-write',
  'entry-cleanup-write',
] as const;
export type DisagreementMode = (typeof disagreementModes)[number];
export const disagreementModeSchema = z.enum(disagreementModes);

export const mainModeSchema = z.enum([...recoveryModes, 'restart']);

export function appliedMode(mode: RecoveryMode | 'restart'): boolean {
  return mode.endsWith('lost-reply');
}

export function refusedMode(mode: RecoveryMode | 'restart'): boolean {
  return mode.endsWith('refusal');
}

export function composedMode(mode: RecoveryMode | 'restart'): boolean {
  return mode.startsWith('composed-');
}
const childEntry = join(__dirname, 'sidebar-group-main-child.ts');

export interface Checkpoint {
  checkpoint: string;
  pid: number;
  snapshot: Snapshot;
  beforeStartup?: Snapshot;
  [key: string]: unknown;
}
function isCheckpoint(value: unknown): value is Checkpoint {
  return (
    typeof value === 'object' &&
    value !== null &&
    'checkpoint' in value &&
    typeof value.checkpoint === 'string' &&
    'snapshot' in value &&
    'pid' in value
  );
}

export async function mainRole(
  root: string,
  socket: string,
  mode: RecoveryMode | DisagreementMode | 'restart',
  report: unknown[],
  observe: (checkpoint: Checkpoint) => Promise<void>,
  scenario: RecoveryMode | DisagreementMode | 'restart' = mode,
  sameProcessNoop = false,
): Promise<Checkpoint[]> {
  const entry = disagreementModes.some((candidate) => candidate === scenario)
    ? join(__dirname, 'sidebar-group-disagreement-child.ts')
    : childEntry;
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      require.resolve('jest/bin/jest'),
      '--runInBand',
      '--watchman=false',
      '--runTestsByPath',
      `--testMatch=**/__tests__/fixtures/${basename(entry)}`,
      '--',
      entry,
    ],
    {
      env: {
        ...process.env,
        CANOPY_DATA_DIR: root,
        CANOPY_SECURE_DATA_DIR: join(root, 'secure'),
        CAN4477_CHILD: mode,
        CAN4477_SCENARIO: scenario,
        CAN4477_SOCKET: socket,
        CAN4477_NOOP: sameProcessNoop ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  if (!child.stdout || !child.stderr) {
    child.kill('SIGKILL');
    throw new Error('Child output pipes required');
  }
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const checkpoints: Checkpoint[] = [];
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    const fail = (error: unknown): void => {
      failure ??= error instanceof Error ? error : new Error(String(error));
      child.kill('SIGKILL');
    };
    const deadline = setTimeout(
      () => fail(new Error(`Child deadline: ${output}`)),
      60_000,
    );
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('message', (value) => {
      if (!isCheckpoint(value)) {
        fail(new Error('Invalid child checkpoint'));
        return;
      }
      checkpoints.push(value);
      report.push(value);
      void observe(value)
        .then(() => {
          child.send('continue', (error) => {
            if (error) fail(error);
          });
        })
        .catch(fail);
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      report.push({
        childProcess: {
          pid: child.pid,
          elapsedMs: Date.now() - started,
          code,
          signal,
          output,
        },
      });
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`Child ${code}/${signal}: ${output}`));
    });
  });
  return checkpoints;
}
export interface LogState {
  decisions: Record<string, SQLOutputValue>[];
  revisions: Record<string, SQLOutputValue>[];
  reservations: Record<string, SQLOutputValue>[];
}

export function logState(dbPath: string): LogState {
  // W5 holds an EXCLUSIVE connection for the worker's lifetime, even for
  // read-only observers. Call only after shutdownW5BoundaryHost confirms exit.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      decisions: db
        .prepare(
          'SELECT commit_id, operation, state FROM w5_commits ORDER BY commit_id',
        )
        .all(),
      revisions: db
        .prepare('SELECT * FROM w5_revisions ORDER BY resource')
        .all(),
      reservations: db.prepare('SELECT * FROM w5_reservations').all(),
    };
  } finally {
    db.close();
  }
}

export async function liveAuthority(host: W5CommitLogHost): Promise<{
  position?: Awaited<ReturnType<W5CommitLogHost['snapshot']>>;
  snapshotRefusal?: W5CommitRefusedError['details'];
  recovery: Awaited<ReturnType<W5CommitLogHost['recoveryReport']>>;
}> {
  let position: Awaited<ReturnType<W5CommitLogHost['snapshot']>> | undefined;
  let snapshotRefusal: W5CommitRefusedError['details'] | undefined;
  try {
    position = await host.snapshot();
  } catch (error) {
    if (
      !(error instanceof W5CommitRefusedError) ||
      error.reason !== 'recovery-required'
    )
      throw error;
    snapshotRefusal = error.details;
  }
  return {
    ...(position ? { position } : {}),
    ...(snapshotRefusal ? { snapshotRefusal } : {}),
    recovery: await host.recoveryReport(),
  };
}

const rowsSchema = z
  .object({
    version: z.literal(1),
    worktrees: z.array(
      z
        .object({
          id: z.string(),
          creation: z.object({ state: z.string() }).passthrough().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const groupsSchema = z
  .object({
    version: z.number(),
    groups: z.array(
      z
        .object({ id: z.string(), memberIds: z.array(z.string()) })
        .passthrough(),
    ),
  })
  .passthrough();

/** Raw bytes are captured independently of all owner reads/recovery. */
export async function snapshot(
  root: string,
  workEntries = false,
  allowFuture = false,
): Promise<Snapshot> {
  const directory = join(root, 'workspaces', 'project');
  const registry = await readFile(
    join(directory, workEntries ? 'work-entries.json' : 'worktrees.json'),
    'utf8',
  );
  const entries = workEntries
    ? z
        .object({ version: z.literal(1), entries: rowsSchema.shape.worktrees })
        .parse(JSON.parse(registry))
    : undefined;
  const sidecar = await readFile(
    join(directory, 'sidebar-item-groups.json'),
    'utf8',
  );
  const groups = groupsSchema.parse(JSON.parse(sidecar));
  if (!allowFuture) z.literal(1).parse(groups.version);
  return {
    registry,
    sidecar,
    rows: entries
      ? { version: 1, worktrees: entries.entries }
      : rowsSchema.parse(JSON.parse(registry)),
    groups,
    metadata: (await readdir(join(directory, 'worktree-data'))).sort(),
    checkouts: (await readdir(join(directory, 'worktrees'))).sort(),
  };
}
export interface Snapshot {
  registry: string;
  sidecar: string;
  rows: z.infer<typeof rowsSchema>;
  groups: z.infer<typeof groupsSchema>;
  metadata: string[];
  checkouts: string[];
}
