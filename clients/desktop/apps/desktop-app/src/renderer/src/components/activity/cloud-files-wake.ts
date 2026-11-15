import { useEffect, useRef, useState } from 'react';
import type { FileTreeSandboxNotAwake } from '@/stores/fileListStore';
import type { CloudSandboxState } from '@/stores/chat/web-core/sandbox-states';
import { bareScope, qualifiedId } from '@/stores/chat/web-core/translate';

/*
 * A cloud chat's Files panel while its sandbox wakes (CAN-6724).
 *
 * Opening Files on a sleeping sandbox that a read can wake asks main to wake
 * it, once per open; the renderer relay can't wake it (it strips `wake`). A
 * wake is under way while that call runs and after it succeeds, and while a
 * turn runs in the worktree, since a turn wakes the sandbox too. Until the
 * sandbox answers, the panel says it is waking and lists its folders again,
 * a little later each time. It says the sandbox is sleeping only once the
 * wake failed: main refused it, the turn ended, or main's wake succeeded but
 * the sandbox still hadn't answered within a couple of minutes.
 */

/** The waits between two listings while a wake is under way. */
export const CLOUD_FILES_WAKE_RETRY_DELAYS_MS: readonly number[] = [
  1_500, 3_000, 5_000,
];
/** The longest wait between two listings while a wake is under way. */
export const CLOUD_FILES_WAKE_RETRY_MAX_MS = 5_000;
/** How long the panel keeps listing after main's wake, with no turn running. */
export const CLOUD_FILES_WAKE_WINDOW_MS = 120_000;

type FilesWake =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waking' }
  | { readonly kind: 'woken'; readonly at: number }
  | { readonly kind: 'done' };

const IDLE: FilesWake = { kind: 'idle' };

/** Whether a read that asks to wake can wake this sandbox (CAN-6654). */
function readCanWake(notAwake: FileTreeSandboxNotAwake): boolean {
  return (
    notAwake.code === 'SANDBOX_STOPPING' ||
    (notAwake.code === 'SANDBOX_NOT_READY' && notAwake.wakeAllowed)
  );
}

export interface CloudFilesWakeInput {
  /** A cloud chat's Files panel, showing now. */
  readonly active: boolean;
  readonly projectId: string | null;
  readonly worktreeId: string | null;
  /** The sandbox's last not-awake answer for this worktree, if any. */
  readonly notAwake: FileTreeSandboxNotAwake | undefined;
  /** A turn runs in the worktree. */
  readonly busy: boolean;
  /**
   * The worktree's sandbox as the web core reports it (CAN-6766), or null
   * before it has. Waking means a wake is under way, from anywhere; ready
   * means the sandbox answers. Otherwise the panel infers it as above.
   */
  readonly sandbox: CloudSandboxState | null;
  /** Lists the panel's visible folders again. */
  readonly relist: () => Promise<void>;
}

/** Whether a wake is under way, so the panel says waking, not sleeping. */
export function useCloudFilesWake({
  active,
  projectId,
  worktreeId,
  notAwake,
  busy,
  sandbox,
  relist,
}: CloudFilesWakeInput): boolean {
  // Each time the panel shows a chat's files is one open: one wake at most.
  const scope =
    active && projectId !== null && worktreeId !== null
      ? `${projectId}/${worktreeId}`
      : null;
  const [open, setOpen] = useState<{
    readonly scope: string | null;
    readonly generation: number;
  }>({ scope, generation: 0 });
  if (open.scope !== scope) setOpen({ scope, generation: open.generation + 1 });
  const [wake, setWake] = useState<{
    readonly generation: number;
    readonly state: FilesWake;
  }>({ generation: 0, state: IDLE });
  const filesWake = wake.generation === open.generation ? wake.state : IDLE;
  const triedRef = useRef<number | null>(null);
  const relistRef = useRef(relist);
  useEffect(() => {
    relistRef.current = relist;
  });

  const asleep = scope !== null && notAwake !== undefined;
  const reportedWaking = sandbox === 'waking';
  const wakeUnderWay =
    scope !== null &&
    (busy ||
      reportedWaking ||
      filesWake.kind === 'waking' ||
      filesWake.kind === 'woken');

  // The one wake of this open, when nothing else is waking the sandbox.
  useEffect(() => {
    if (
      scope === null ||
      projectId === null ||
      worktreeId === null ||
      notAwake === undefined ||
      triedRef.current === open.generation
    )
      return;
    // A turn waking the sandbox is this open's one wake: if it ends with the
    // sandbox still asleep, the wake failed and Files doesn't start another.
    if (busy) {
      triedRef.current = open.generation;
      return;
    }
    if (!readCanWake(notAwake)) return;
    const generation = open.generation;
    triedRef.current = generation;
    setWake({ generation, state: { kind: 'waking' } });
    const target = bareScope({ projectId, worktreeId });
    const settle = (state: FilesWake): void =>
      setWake((current) =>
        current.generation === generation ? { generation, state } : current,
      );
    void Promise.resolve()
      .then(() =>
        window.api.cloudChats.wakeFiles({
          key: qualifiedId(target.worktreeId),
          ...target,
        }),
      )
      .then(
        (result: unknown) => {
          if (
            typeof result === 'object' &&
            result !== null &&
            'ok' in result &&
            result.ok === true
          ) {
            settle({ kind: 'woken', at: Date.now() });
            void relistRef.current();
          } else settle({ kind: 'done' });
        },
        () => settle({ kind: 'done' }),
      );
  }, [busy, notAwake, open.generation, projectId, scope, worktreeId]);

  // Once the sandbox answers, main's wake has done its work.
  useEffect(() => {
    if (notAwake === undefined && filesWake.kind === 'woken')
      setWake({ generation: open.generation, state: { kind: 'done' } });
  }, [filesWake.kind, notAwake, open.generation]);

  // Once the web core reports the sandbox ready, the panel lists again.
  const reportedReady = asleep && sandbox === 'ready';
  useEffect(() => {
    if (reportedReady) void relistRef.current();
  }, [reportedReady]);

  // List again while a turn or main's wake is waking the sandbox, until it
  // answers. The in-flight wake call itself answers once it is awake.
  const [attempt, setAttempt] = useState(0);
  const retrying =
    asleep &&
    (busy || reportedWaking || filesWake.kind === 'woken') &&
    wakeUnderWay;
  useEffect(() => {
    if (!retrying) {
      setAttempt(0);
      return;
    }
    const delay =
      CLOUD_FILES_WAKE_RETRY_DELAYS_MS[
        Math.min(attempt, CLOUD_FILES_WAKE_RETRY_DELAYS_MS.length - 1)
      ] ?? CLOUD_FILES_WAKE_RETRY_MAX_MS;
    const timer = setTimeout(() => {
      if (
        !busy &&
        filesWake.kind === 'woken' &&
        Date.now() - filesWake.at > CLOUD_FILES_WAKE_WINDOW_MS
      ) {
        setWake({ generation: open.generation, state: { kind: 'done' } });
        return;
      }
      void relistRef.current().finally(() => setAttempt((n) => n + 1));
    }, delay);
    return (): void => clearTimeout(timer);
  }, [attempt, busy, filesWake, open.generation, retrying]);

  return wakeUnderWay;
}
