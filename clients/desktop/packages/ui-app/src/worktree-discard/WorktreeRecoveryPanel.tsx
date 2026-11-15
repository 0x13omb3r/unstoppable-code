import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { CanopyClient, SessionViewModel } from '@canopy/app-core';
import { offerWorktreeDiscard } from '@canopy/app-state';
import { worktreeDiscardStoreFor } from '@canopy/app-state/worktree-discard';
import type { WorktreeRecoveryListResult } from '@canopy/protocol/canopy-core';
import type { W5RecoveryStatus } from '@canopy/protocol/portal';
import { formatWorktreeRecoveryReason } from '@canopy/protocol/portal/worktree-recovery';
import {
  Button,
  ConfirmDialog,
  DialogModal,
  Disclosure,
  ErrorBanner,
  Heading,
  ListRowStatic,
  LoadingButton,
  Stack,
  W5RecoveryNotice,
} from '@canopy/ui-shared/components';
import {
  worktreeRecoveryResultCopy,
  worktreeRecoveryUnconfirmedCopy,
} from '@canopy/ui-shared/lib/worktree-discard-copy';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export type RecoveryProject = WorktreeRecoveryListResult & {
  workspaceId: string;
  name: string;
  worktrees: SessionViewModel['worktrees'];
};
export type RecoveryHold = NonNullable<
  WorktreeRecoveryListResult['resolutions']
>[number] & { workspaceId: string };

function needsRecoveryReview(
  hold: NonNullable<WorktreeRecoveryListResult['resolutions']>[number],
): boolean {
  return (
    hold.retention !== 'deleted' &&
    (hold.stage !== 'completed' ||
      hold.retention === 'deleting' ||
      hold.retainedSnapshots > 0 ||
      hold.retainedPayload)
  );
}

function recoveryName(
  project: RecoveryProject,
  recovery: WorktreeRecoveryListResult['entries'][number],
): string {
  const row = project.worktrees.find(
    (worktree) => worktree.localId === recovery.subject.worktreeId,
  );
  if (!row) return 'Unlisted worktree';
  if (row.createdAt !== recovery.subject.createdAt)
    return 'Earlier archive attempt';
  return row.label || row.branch;
}

function archiveReference(
  recovery: WorktreeRecoveryListResult['entries'][number],
): string | undefined {
  const reference =
    recovery.diagnosis?.operationId ??
    (recovery.evidence.kind === 'journal'
      ? recovery.evidence.operationId
      : undefined);
  return reference &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      reference,
    )
    ? reference
    : undefined;
}

function shortArchiveReference(
  operationId: string | undefined,
  references: readonly string[],
): string | undefined {
  if (!operationId) return undefined;
  // Keep both ends and grow the suffix only when two attempts would look alike.
  let length = 8;
  while (
    length < operationId.length - 4 &&
    references.some(
      (reference) =>
        reference !== operationId &&
        reference.slice(0, 4) === operationId.slice(0, 4) &&
        reference.slice(-length) === operationId.slice(-length),
    )
  )
    length += 1;
  return length < operationId.length - 4
    ? `${operationId.slice(0, 4)}…${operationId.slice(-length)}`
    : operationId;
}

function recoveryCreatedAt(createdAt: string | null): string | undefined {
  return createdAt && Number.isFinite(Date.parse(createdAt))
    ? `Worktree created ${new Date(createdAt).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })}`
    : undefined;
}

function RecoveryReference({
  operationId,
  reason,
}: {
  readonly operationId?: string;
  readonly reason: string;
}): JSX.Element {
  return (
    <Disclosure label="Details">
      <p className="text-pretty">{reason}</p>
      {operationId ? (
        <p className="text-pretty break-words">
          Archive reference: {operationId}
        </p>
      ) : null}
    </Disclosure>
  );
}

/** Live archive records are available even when cold W5 recovery is unavailable. */
export function WorktreeRecoveryPanel({
  client,
  status,
  canRecover,
  onRecover,
  coldBusy,
}: {
  readonly client: CanopyClient;
  readonly status?: W5RecoveryStatus;
  readonly canRecover?: boolean;
  readonly onRecover?: () => void;
  readonly coldBusy?: boolean;
}): JSX.Element {
  const supported = client.capabilities.worktreeRecoveryResolution === true;
  const [projects, setProjects] = useState<RecoveryProject[]>([]);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RecoveryHold | null>(null);
  const active = useRef(0);
  const reading = useRef(false);
  const queued = useRef(false);
  const refresh: () => Promise<void> = useCallback(async (): Promise<void> => {
    if (!supported) return;
    if (reading.current) {
      queued.current = true;
      return;
    }
    const generation = active.current;
    reading.current = true;
    setChecking(true);
    try {
      const snapshot = await client.query('session.snapshot', {});
      const next: RecoveryProject[] = [];
      let incomplete = false;
      for (const workspace of snapshot.workspaces) {
        if (
          workspace.placeholder ||
          workspace.sharedFrom ||
          workspace.backend === 'cloud' ||
          workspace.type === 'cowork'
        )
          continue;
        try {
          const result = await client.command('worktree.recovery.list', {
            workspaceId: workspace.localId,
          });
          next.push({
            ...result,
            workspaceId: workspace.localId,
            name: workspace.name,
            worktrees: snapshot.worktrees.filter(
              (worktree) => worktree.workspaceLocalId === workspace.localId,
            ),
          });
          incomplete ||= result.check !== 'ok';
        } catch {
          incomplete = true;
        }
        if (generation !== active.current) return;
      }
      if (generation === active.current) {
        setProjects(next);
        setError(incomplete);
      }
    } catch {
      if (generation === active.current) setError(true);
    } finally {
      if (generation === active.current) {
        reading.current = false;
        setChecking(false);
        if (queued.current) {
          queued.current = false;
          queueMicrotask(() => {
            void refresh();
          });
        }
      }
    }
  }, [client, supported]);
  useEffect(() => {
    active.current += 1;
    reading.current = false;
    queued.current = false;
    setProjects([]);
    setOpen(false);
    setMessage(null);
    setDeleting(null);
    setBusy(false);
    if (!supported) return;
    void refresh();
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    const unsubscribeSnapshot = client.subscribe(
      'session.snapshot-stale',
      onFocus,
    );
    // Reconcile live incidents after a listed-row action without clearing cold incidents.
    const unsubscribe = worktreeDiscardStoreFor(client).subscribe(
      (state, previous) => {
        if (
          (state.view.phase === 'closed' && previous.view.phase !== 'closed') ||
          (state.view.phase === 'recovery' &&
            state.view.outcome &&
            (previous.view.phase !== 'recovery' ||
              state.view.outcome !== previous.view.outcome))
        )
          void refresh();
      },
    );
    return (): void => {
      active.current += 1;
      window.removeEventListener('focus', onFocus);
      unsubscribeSnapshot();
      unsubscribe();
    };
  }, [client, refresh, supported]);
  const count = projects.reduce(
    (total, project) =>
      total +
      project.entries.length +
      (project.resolutions?.filter(needsRecoveryReview).length ?? 0),
    0,
  );
  const resolveHold = async (
    hold: RecoveryHold,
    action: 'keep-worktree' | 'release' | 'delete-hold',
  ): Promise<void> => {
    if (busy || checking || error) return;
    const generation = active.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = await client.command('worktree.recovery.resolve', {
        workspaceId: hold.workspaceId,
        operationId: hold.operationId,
        revision: hold.revision,
        action,
      });
      if (generation !== active.current) return;
      setMessage(worktreeRecoveryResultCopy(result, action));
      setDeleting(null);
      await refresh();
    } catch {
      if (generation === active.current) {
        setMessage(worktreeRecoveryUnconfirmedCopy(action));
        setError(true);
        setDeleting(null);
      }
    } finally {
      if (generation === active.current) setBusy(false);
    }
  };
  return (
    <>
      <W5RecoveryNotice
        status={status}
        canRecover={canRecover}
        onRecover={onRecover}
        busy={coldBusy}
        archiveRecovery={
          supported && (count > 0 || error || open)
            ? {
                unavailable: error,
                onReview: () => {
                  setOpen(true);
                  void refresh();
                },
              }
            : undefined
        }
      />
      {open || deleting ? (
        <WorktreeRecoveryListDialog
          projects={projects}
          checking={checking}
          error={error}
          busy={busy}
          message={message}
          deleting={deleting}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          onRefresh={() => {
            void refresh();
          }}
          onReview={(project, recovery) => {
            setOpen(false);
            offerWorktreeDiscard({
              workspaceId: project.workspaceId,
              worktreeId: recovery.subject.worktreeId,
              worktreeName: `${recoveryName(project, recovery)} (${project.name})`,
              message: formatWorktreeRecoveryReason(recovery),
              recovery,
            });
          }}
          onDelete={setDeleting}
          onResolve={(hold, action) => {
            void resolveHold(hold, action);
          }}
          onCancelDelete={() => {
            if (!busy) setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}

/** Shared presentation kept separate from live reads and recovery commands. */
export function WorktreeRecoveryListDialog({
  projects,
  checking,
  error,
  busy,
  message,
  deleting,
  onClose,
  onRefresh,
  onReview,
  onDelete,
  onResolve,
  onCancelDelete,
}: {
  readonly projects: readonly RecoveryProject[];
  readonly checking: boolean;
  readonly error: boolean;
  readonly busy: boolean;
  readonly message?: string | null;
  readonly deleting?: RecoveryHold | null;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onReview: (
    project: RecoveryProject,
    recovery: WorktreeRecoveryListResult['entries'][number],
  ) => void;
  readonly onDelete: (hold: RecoveryHold) => void;
  readonly onResolve: (
    hold: RecoveryHold,
    action: 'keep-worktree' | 'release' | 'delete-hold',
  ) => void;
  readonly onCancelDelete: () => void;
}): JSX.Element {
  const count = projects.reduce(
    (total, project) =>
      total +
      project.entries.length +
      (project.resolutions?.filter(needsRecoveryReview).length ?? 0),
    0,
  );
  return (
    <>
      {!deleting ? (
        <DialogModal
          title="Archive recovery"
          onClose={onClose}
          closeButtonDisabled={busy}
          closeOnEscape={!busy}
          closeOnBackdrop={!busy}
          trapFocus
          maxWidth="lg"
          dataTestId="worktree-live-recovery-panel"
          footer={
            <LoadingButton
              variant="primary"
              loading={checking}
              loadingLabel="Checking…"
              disabled={busy || checking}
              onClick={onRefresh}
            >
              Check again
            </LoadingButton>
          }
        >
          <p className="text-pretty">
            Review unfinished archives, including those no longer in the
            worktree list. Other workspace recovery issues must be resolved
            separately.
          </p>
          {error ? (
            <ErrorBanner
              errorSource="worktree-recovery-panel"
              error="Couldn't check all recovery records. Check again before continuing."
            />
          ) : null}
          {message ? (
            <p role="status" className="text-pretty">
              {message}
            </p>
          ) : null}
          {!count && !checking && !error ? (
            <p>No unfinished archives or retained recovery material.</p>
          ) : null}
          {projects.map((project) => {
            const references = [
              ...project.entries.flatMap(
                (entry) => archiveReference(entry) ?? [],
              ),
              ...(project.resolutions?.map((hold) => hold.operationId) ?? []),
            ];
            return (
              <Stack as="section" key={project.workspaceId} gap="inline">
                {project.entries.length > 0 ||
                project.resolutions?.some(needsRecoveryReview) ? (
                  <Heading level={3} variant="label">
                    <span className={REPLAY_MASK_CLASS}>{project.name}</span>
                  </Heading>
                ) : null}
                {project.entries.map((recovery) => (
                  <Stack
                    data-testid="worktree-live-recovery-entry"
                    data-worktree-id={recovery.subject.worktreeId}
                    key={
                      archiveReference(recovery) ?? recovery.subject.worktreeId
                    }
                    gap="tight"
                  >
                    <ListRowStatic
                      size="lg"
                      description={recoveryCreatedAt(
                        recovery.subject.createdAt,
                      )}
                      trailing={shortArchiveReference(
                        archiveReference(recovery),
                        references,
                      )}
                      actions={
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy || checking || error}
                          onClick={() => onReview(project, recovery)}
                        >
                          Review archive
                        </Button>
                      }
                    >
                      <span className={REPLAY_MASK_CLASS}>
                        {recoveryName(project, recovery)}
                      </span>
                    </ListRowStatic>
                    <RecoveryReference
                      operationId={archiveReference(recovery)}
                      reason={formatWorktreeRecoveryReason(recovery)}
                    />
                  </Stack>
                ))}
                {project.resolutions
                  ?.filter(needsRecoveryReview)
                  .map((hold) => (
                    <Stack key={hold.operationId} gap="tight">
                      <ListRowStatic
                        size="lg"
                        description={recoveryCreatedAt(hold.createdAt)}
                        trailing={shortArchiveReference(
                          hold.operationId,
                          references,
                        )}
                        actions={
                          hold.stage === 'completed' ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy || checking || error}
                              onClick={() =>
                                onDelete({
                                  ...hold,
                                  workspaceId: project.workspaceId,
                                })
                              }
                            >
                              Delete recovery material
                            </Button>
                          ) : (
                            <LoadingButton
                              variant="secondary"
                              size="sm"
                              loading={busy}
                              loadingLabel="Continuing recovery…"
                              disabled={busy || checking || error}
                              onClick={() => {
                                onResolve(
                                  { ...hold, workspaceId: project.workspaceId },
                                  hold.action,
                                );
                              }}
                            >
                              {hold.action === 'keep-worktree'
                                ? 'Keep worktree'
                                : 'Release'}
                            </LoadingButton>
                          )
                        }
                      >
                        {hold.stage === 'completed'
                          ? 'Retained recovery material'
                          : 'Unfinished recovery'}
                      </ListRowStatic>
                      <RecoveryReference
                        operationId={hold.operationId}
                        reason={
                          hold.stage === 'completed'
                            ? `${hold.retainedSnapshots} saved Git ${hold.retainedSnapshots === 1 ? 'snapshot' : 'snapshots'}. ${hold.retainedPayload ? 'A saved working-file copy is also retained.' : 'No working-file copy is retained.'}`
                            : 'Recovery has not finished. Continue the same choice to check and resume it.'
                        }
                      />
                    </Stack>
                  ))}
              </Stack>
            );
          })}
        </DialogModal>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete retained recovery material?"
          message="Permanently delete the saved Git snapshots and working-file copy for this archive attempt. This does not delete a live worktree."
          confirmLabel="Delete recovery material"
          busyLabel="Deleting recovery material…"
          destructive
          busy={busy}
          confirmDisabled={checking || error}
          onConfirm={() => {
            onResolve(deleting, 'delete-hold');
          }}
          onCancel={onCancelDelete}
          dataTestId="worktree-recovery-delete-hold"
        />
      ) : null}
    </>
  );
}
