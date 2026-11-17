import { destroyWorktreeSessions } from '../agents/session-manager';
import { getObservabilityService } from '../observability';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { stopTracking } from './github-poller';
import { cancelScheduledGeneration } from './worktree-summary-scheduler';
import { workerTerminal } from '../terminal/worker-terminal';
import { getClaudeTerminalSessionService } from '../integration/claude-terminal-session-service';
import { drainWorktreeShellScripts } from './script-runner';
import { drainWorktreePipelines } from '../pipelines/worktree-cleanup';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { getWorktreeDir } from './paths';
import { captureLinuxWorktreeWriterVerification } from './worktree-process-cleanup';
import { destructiveFailureCode } from './destructive-failure-context';
import { logMainProcessWarn } from './main-process-logging';

type LiveStateOwner =
  | 'writer-check'
  | 'pipelines'
  | 'shell-scripts'
  | 'sessions'
  | 'claude-terminal'
  | 'worker-terminal';

/**
 * A live-state owner failed without a code of its own. Its code names the
 * owner, so the journal and telemetry say which one; the original error is
 * the cause and stays local.
 */
export class LiveStateTeardownError extends Error {
  readonly code: `live-state:${LiveStateOwner}`;
  constructor(
    owner: LiveStateOwner,
    readonly failure: unknown,
  ) {
    super(`Worktree live-state teardown failed at ${owner}.`);
    this.code = `live-state:${owner}`;
  }
}

function attributed(owner: LiveStateOwner, error: unknown): unknown {
  const code = destructiveFailureCode(error);
  return code === 'Error' || code === 'unknown'
    ? new LiveStateTeardownError(owner, error)
    : error;
}

/**
 * Stops everything in this process that can write into a worktree, in a fixed
 * order: first the work that produces output (pipelines, then shell scripts),
 * then `destroyWorktreeSessions`, which destroys agent providers and drains
 * their final events and transcript entries, then Claude terminal settlement
 * before releasing terminals. Pipeline or script work cannot emit after the
 * session event drain, and nothing is closed under a live producer.
 *
 * Every step runs even when an earlier one fails, so one stuck owner does not
 * leave the others running. The first failure, starting with writer capture,
 * is rethrown once all steps settle, and no caller proceeds to removal.
 *
 * On Linux the writers present before cancellation are captured first and
 * verified gone afterwards, which also catches a provider child that outlived
 * its parent and left the process subtree.
 */
export async function cleanupLiveWorktreeState(
  projectId: string,
  worktreeId: string,
  onSessionsDestroyed?: () => void,
): Promise<void> {
  const failures: unknown[] = [];
  let verifyWritersGone: (() => Promise<void>) | undefined;
  try {
    verifyWritersGone = await captureLinuxWorktreeWriterVerification(
      getWorktreeDir(projectId, worktreeId),
    );
  } catch (error) {
    failures.push(attributed('writer-check', error));
  }
  stopTracking(projectId, worktreeId);
  cancelScheduledGeneration(projectId, worktreeId);

  const steps: Array<[LiveStateOwner, () => Promise<void>]> = [
    [
      'pipelines',
      () =>
        drainWorktreePipelines(
          projectId,
          worktreeId,
          createElectronExecutionRuntime(),
        ),
    ],
    ['shell-scripts', () => drainWorktreeShellScripts(projectId, worktreeId)],
    [
      'sessions',
      async (): Promise<void> => {
        await destroyWorktreeSessions(projectId, worktreeId);
        onSessionsDestroyed?.();
      },
    ],
    // Terminal release fires an exit event that drops Claude runtime records.
    // Drain their transcript/watcher settlement while those records still exist.
    [
      'claude-terminal',
      () =>
        getClaudeTerminalSessionService().cleanupWorktree(
          projectId,
          worktreeId,
        ),
    ],
    [
      'worker-terminal',
      () => workerTerminal.releaseWorktree({ projectId, worktreeId }),
    ],
  ];
  for (const [owner, step] of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(attributed(owner, error));
    }
  }
  if (failures.length > 0) {
    reportLiveStateFailures(projectId, worktreeId, failures);
    const [failed] = failures;
    throw failed instanceof Error
      ? failed
      : new Error('Worktree resource cleanup failed.');
  }
  try {
    await verifyWritersGone?.();
  } catch (error) {
    const failed = attributed('writer-check', error);
    reportLiveStateFailures(projectId, worktreeId, [failed]);
    throw failed;
  }
}

/** The raw errors stay in this computer's log; the journal keeps only codes. */
function reportLiveStateFailures(
  projectId: string,
  worktreeId: string,
  failures: readonly unknown[],
): void {
  logMainProcessWarn('Worktree live-state teardown failed', {
    projectId,
    worktreeId,
    failures: failures.map((failure) => {
      const reported =
        failure instanceof LiveStateTeardownError ? failure.failure : failure;
      return {
        code: destructiveFailureCode(failure),
        message:
          reported instanceof Error ? reported.message : String(reported),
      };
    }),
  });
}

export async function purgeLiveWorktreeObservabilityData(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  // Drain pending telemetry for this worktree before its audit/transcript
  // sidecars are purged (CAN-402), then drop it from the queue and sync-map.
  await getTelemetrySyncService()
    .drainWorktreeForDeletion(projectId, worktreeId)
    .catch(() => undefined);
  await getObservabilityService().purgeWorktreeData(projectId, worktreeId);
}
