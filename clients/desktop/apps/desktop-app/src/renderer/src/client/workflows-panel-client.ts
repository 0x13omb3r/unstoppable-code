import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { create } from 'zustand';
import type {
  WorkflowsPanelClient,
  WorkflowsPanelIntent,
  WorkflowsPanelLibraryRow,
  WorkflowsPanelScope,
  WorkflowsPanelSnapshot,
} from '@canopy/app-core';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { getAutomationTriggerLabel } from '@canopy/desktop-shared/lib/automations';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import {
  describePipelineTriggers,
  pipelineTriggerKinds,
} from '@canopy/ui-app/workflows';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { isCoworkChatTarget } from '@/lib/cowork';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import {
  useExecutionFeedStore,
  retainExecutionFeed,
} from '@/lib/workflows/execution-feed';
import {
  buildWorkflowRunRows,
  mergeAutomationRuns,
} from '@/lib/workflows/run-feed';
import { pipelineLibraryKey } from '@/lib/workflows/library-projection';
import { pipelineEditLinkFromLocator } from '@/lib/workflows/edit-target';
import { pipelineInfoToDocumentLocator } from '@/lib/pipelineDocument';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import {
  triggerTitle,
  watcherStatusLabelWithFailure,
  watcherTargetDisplay,
} from '@/components/watchers/watcherDisplay';
import { visibleWatchers } from '@/components/watchers/watcherFilters';
import {
  buildLibraryRows,
  buildUpcomingEntries,
  filterActivitiesForScope,
  filterWatchersForScope,
  getAutomationNextRun,
  panelRunFeedPredicates,
  RUNS_MAX_ROWS,
} from '@/components/panels/automations/automations-panel-data';

/** Host-owned watcher management remains beside the desktop's management dialog. */
export const useWorkflowsPanelWatcherStore = create<{
  readonly selected: Readonly<Record<string, string | undefined>>;
  readonly select: (panelId: string, watcherId: string | undefined) => void;
}>((set) => ({
  selected: {},
  select: (panelId, watcherId): void =>
    set((state) => {
      if (state.selected[panelId] === watcherId) return state;
      const selected = { ...state.selected };
      if (watcherId === undefined) delete selected[panelId];
      else selected[panelId] = watcherId;
      return { selected };
    }),
}));

function scopeKey(scope: WorkflowsPanelScope): string {
  return JSON.stringify([
    scope.panelId,
    scope.projectId,
    scope.worktreeId,
    scope.worktreeOnly,
  ]);
}

/** Existing renderer stores/IPC only: no new operation, channel or writer. */
export function createDesktopWorkflowsPanelClient(): WorkflowsPanelClient {
  // A scope-toggle resubscription retains the same checkout read, as the old
  // hook did. A genuine unmount releases it; reopening discovers afresh.
  const checkouts = new Map<
    string,
    {
      pipelines: readonly PipelineInfo[];
      cwd: string | undefined;
      readonly listeners: Set<() => void>;
    }
  >();
  const dispatchers = new Map<string, (intent: WorkflowsPanelIntent) => void>();
  return {
    dispatch: (scope, intent): void =>
      dispatchers.get(scopeKey(scope))?.(intent),
    subscribe: (request, listener): (() => void) => {
      let disposed = false;
      const checkoutKey = JSON.stringify([
        request.panelId,
        request.projectId,
        request.worktreeId,
      ]);
      let checkout = checkouts.get(checkoutKey);
      if (checkout === undefined) {
        checkout = { pipelines: [], cwd: undefined, listeners: new Set() };
        checkouts.set(checkoutKey, checkout);
        const source = checkout;
        void (async (): Promise<void> => {
          try {
            const path = await window.api.getWorktreePath({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
            });
            if (checkouts.get(checkoutKey) !== source) return;
            if (path) {
              const result = await window.pipelines.discoverProject(path);
              if (checkouts.get(checkoutKey) !== source) return;
              source.cwd = path;
              source.pipelines =
                result.success && result.data ? result.data : [];
            }
          } catch (error) {
            // Failed discovery still lists no project workflows, as before.
            reportClientAppError(error);
          }
          source.listeners.forEach((notify) => notify());
        })();
      }
      const projectPipelines = checkout;
      let now = new Date();
      // Portable opaque keys: the desktop file locator never leaves this adapter.
      const pipelineKeys = new Map<string, string>();
      const pipelineKey = (pipeline: PipelineInfo): string => {
        const locator = pipelineLibraryKey(pipeline);
        const existing = pipelineKeys.get(locator);
        if (existing !== undefined) return existing;
        const key = `pipeline:project:${pipelineKeys.size}`;
        pipelineKeys.set(locator, key);
        return key;
      };
      const publish = (): void => {
        if (disposed) return;
        const automations = useAutomationsStore.getState();
        const watchers = useAppAdvisorWatchersStore.getState();
        const projects = useProjectsStore.getState().projects;
        const executionFeed = useExecutionFeedStore.getState();
        const project = projects.find(
          (entry) => entry.id === request.projectId,
        );
        const isCowork =
          project?.type === 'cowork' || isCoworkChatTarget(request.projectId);
        const scope = {
          ...request,
          worktreeOnly: isCowork ? false : request.worktreeOnly,
        };
        const worktree =
          project && project.type !== 'cowork'
            ? project.worktrees.find((entry) => entry.id === request.worktreeId)
            : undefined;
        const scopedActivities = filterActivitiesForScope(
          automations.activities,
          scope,
        );
        const scopedWatchers = filterWatchersForScope(
          visibleWatchers(watchers.watchers),
          scope,
          automations.activities,
        );
        const selectedWatcher =
          useWorkflowsPanelWatcherStore.getState().selected[request.panelId];
        if (
          selectedWatcher !== undefined &&
          ![
            ...scopedWatchers,
            ...filterWatchersForScope(
              watchers.completedWatchers,
              scope,
              automations.activities,
            ),
          ].some((watcher) => watcher.id === selectedWatcher)
        ) {
          useWorkflowsPanelWatcherStore
            .getState()
            .select(request.panelId, undefined);
        }
        const library = buildLibraryRows({
          activities: scopedActivities,
          pipelines: projectPipelines.pipelines,
          watchers: scopedWatchers,
          typeFilter: 'all',
          search: '',
        });
        const seen = new Set<string>();
        const allWatchers = [
          ...watchers.watchers,
          ...watchers.completedWatchers,
        ].filter((watcher) => {
          if (seen.has(watcher.id)) return false;
          seen.add(watcher.id);
          return true;
        });
        const runs = buildWorkflowRunRows({
          activities: automations.activities,
          runs: mergeAutomationRuns(automations.recentRuns),
          executions: executionFeed.executions,
          executionsKnown:
            executionFeed.loaded &&
            !executionFeed.loading &&
            executionFeed.error === null,
          watchers: allWatchers,
          ...panelRunFeedPredicates(scope, automations.activities),
          // The panel renders no row actions or destinations. The row builder's
          // status/folding/name/sort logic is still the page's existing projection.
          executionActions: () => [],
          automationRunResult: () => ({ available: true }),
          names: {
            project: (id) => {
              const item = projects.find((entry) => entry.id === id);
              return item ? getWorkspaceDisplayName(item) : undefined;
            },
            worktree: () => undefined,
            chat: () => undefined,
            watcherDestination: () => undefined,
          },
        }).slice(0, RUNS_MAX_ROWS);
        const loadErrors = [automations.error, watchers.error].filter(
          (message): message is string => Boolean(message),
        );
        const snapshot: WorkflowsPanelSnapshot = {
          workspaceLabel: project
            ? getWorkspaceDisplayName(project)
            : request.projectId,
          worktreeLabel: worktree
            ? getWorktreeBranchDisplayName({
                rawBranch: worktree.branchName,
                worktreeId: worktree.id,
                hasMultipleBranches: false,
                getBranchDisplayName: (branch) => branch,
              })
            : request.worktreeId,
          hasWorktrees: !isCowork,
          canCreate: !isBotProjectId(request.projectId),
          now: now.getTime(),
          upcoming: buildUpcomingEntries(scopedActivities, now).map(
            (entry) => ({
              key: entry.key,
              activityId: entry.activity.id,
              name: entry.activity.name || 'Untitled workflow',
              occursAt: entry.occursAt.getTime(),
              withinSoonWindow: entry.withinSoonWindow,
            }),
          ),
          library: library.map((row): WorkflowsPanelLibraryRow => {
            if (row.kind === 'automation') {
              const next = getAutomationNextRun(row.activity, new Date());
              return {
                key: `automation-${row.activity.id}`,
                id: row.activity.id,
                kind: row.kind,
                name: row.activity.name || 'Untitled workflow',
                searchName: row.activity.name,
                trigger: getAutomationTriggerLabel(row.activity.schedule),
                status: row.activity.sharedPipelineReview
                  ? 'Review needed'
                  : !row.activity.enabled
                    ? 'Disabled'
                    : next
                      ? next.toLocaleString()
                      : 'Enabled',
                reviewNeeded: Boolean(row.activity.sharedPipelineReview),
              };
            }
            if (row.kind === 'pipeline')
              return {
                key: pipelineKey(row.pipeline),
                id: row.pipeline.id,
                kind: row.kind,
                name: row.pipeline.name || 'Untitled workflow',
                searchName: row.pipeline.name,
                trigger: describePipelineTriggers(
                  pipelineTriggerKinds(row.pipeline.triggerTypes ?? []),
                ),
                status: '',
              };
            const target = watcherTargetDisplay(row.watcher.target);
            return {
              key: `watcher-${row.watcher.id}`,
              id: row.watcher.id,
              kind: row.kind,
              name: row.watcher.label,
              searchName: row.watcher.label,
              trigger: triggerTitle(row.watcher.trigger),
              status: watcherStatusLabelWithFailure(
                row.watcher.status,
                row.watcher.failureKind,
              ),
              title: `${target.title} — ${target.subtitle}`,
            };
          }),
          runs: runs.map((row) => ({
            key: row.key,
            name: row.name,
            kind: row.kind,
            status: row.status,
            ...(row.startedAt !== undefined
              ? { startedAt: row.startedAt }
              : {}),
            ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
          })),
          loadErrors,
          loading:
            loadErrors.length === 0 &&
            (automations.loading ||
              watchers.loading ||
              !automations.hydrated ||
              !watchers.hydrated),
          runsLoading: !executionFeed.loaded || !automations.hydrated,
          runsError: executionFeed.error,
        };
        const openActivity = (id: string): void =>
          useNavigationStore
            .getState()
            .openAutomationEdit({ activityId: id, section: 'runs' });
        const openWatcher = (id: string): void =>
          useWorkflowsPanelWatcherStore.getState().select(request.panelId, id);
        dispatchers.set(scopeKey(request), (intent): void => {
          switch (intent.kind) {
            case 'retry':
              if (!automations.hydrated || automations.error)
                void useAutomationsStore.getState().hydrate();
              if (!watchers.hydrated || watchers.error)
                void useAppAdvisorWatchersStore.getState().hydrate();
              return;
            case 'retry-runs':
              void useExecutionFeedStore.getState().load();
              return;
            case 'create':
              if (!snapshot.canCreate) return;
              automations.clearMutationError();
              useNavigationStore.getState().openAutomationDraft({
                projectId: request.projectId,
                isCowork,
                ...(!isCowork
                  ? { existingWorktreeId: request.worktreeId }
                  : {}),
              });
              return;
            case 'activity':
              openActivity(intent.id);
              return;
            case 'library': {
              const row = library.find((entry) =>
                entry.kind === 'pipeline'
                  ? pipelineKey(entry.pipeline) === intent.key
                  : `${entry.kind}-${entry.kind === 'automation' ? entry.activity.id : entry.watcher.id}` ===
                    intent.key,
              );
              if (!row) return;
              if (row.kind === 'automation') openActivity(row.activity.id);
              else if (row.kind === 'watcher') openWatcher(row.watcher.id);
              else
                useNavigationStore.getState().openPipelineEdit({
                  ...pipelineEditLinkFromLocator(
                    pipelineInfoToDocumentLocator(
                      row.pipeline,
                      projectPipelines.cwd,
                    ),
                  ),
                  worktree: {
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                  },
                });
              return;
            }
            case 'run': {
              const row = runs.find((entry) => entry.key === intent.key);
              if (!row) return;
              if (row.kind === 'watcher') {
                openWatcher(row.watcherId);
                return;
              }
              const executionId =
                row.kind === 'pipeline'
                  ? row.summary.id
                  : row.linkedExecutionId !== undefined &&
                      executionFeed.executions.some(
                        (entry) => entry.id === row.linkedExecutionId,
                      )
                    ? row.linkedExecutionId
                    : undefined;
              if (executionId !== undefined)
                void openPipelineExecutionFromUi({ executionId });
              else if (
                row.kind === 'automation' &&
                automations.activities.some(
                  (entry) => entry.id === row.activityId,
                )
              )
                openActivity(row.activityId);
              return;
            }
          }
        });
        listener(snapshot);
      };
      const subscriptions = [
        useAutomationsStore.subscribe((state, previous) => {
          if (
            state.activities !== previous.activities ||
            state.recentRuns !== previous.recentRuns ||
            state.loading !== previous.loading ||
            state.hydrated !== previous.hydrated ||
            state.error !== previous.error
          )
            publish();
        }),
        useAppAdvisorWatchersStore.subscribe((state, previous) => {
          if (
            state.watchers !== previous.watchers ||
            state.completedWatchers !== previous.completedWatchers ||
            state.loading !== previous.loading ||
            state.hydrated !== previous.hydrated ||
            state.error !== previous.error
          )
            publish();
        }),
        useProjectsStore.subscribe((state, previous) => {
          if (state.projects !== previous.projects) publish();
        }),
        useExecutionFeedStore.subscribe((state, previous) => {
          if (
            state.executions !== previous.executions ||
            state.loaded !== previous.loaded ||
            state.loading !== previous.loading ||
            state.error !== previous.error
          )
            publish();
        }),
        useAutomationsStore.getState().subscribeBridge(),
        useAppAdvisorWatchersStore.getState().subscribeBridge(),
        retainExecutionFeed(),
      ];
      const hydrate = (): void => {
        const automations = useAutomationsStore.getState();
        const watchers = useAppAdvisorWatchersStore.getState();
        if (!automations.hydrated && !automations.loading)
          void automations.hydrate();
        if (!watchers.hydrated && !watchers.loading) void watchers.hydrate();
      };
      hydrate();
      let interval: ReturnType<typeof setInterval> | undefined;
      const tick = (): void => {
        now = new Date();
        publish();
      };
      const timeout = setTimeout(
        () => {
          tick();
          interval = setInterval(tick, 60_000);
        },
        60_000 - (Date.now() % 60_000),
      );
      projectPipelines.listeners.add(publish);
      publish();
      return (): void => {
        disposed = true;
        subscriptions.forEach((unsubscribe) => unsubscribe());
        clearTimeout(timeout);
        if (interval !== undefined) clearInterval(interval);
        dispatchers.delete(scopeKey(request));
        projectPipelines.listeners.delete(publish);
        queueMicrotask(() => {
          if (
            projectPipelines.listeners.size === 0 &&
            checkouts.get(checkoutKey) === projectPipelines
          )
            checkouts.delete(checkoutKey);
        });
      };
    },
  };
}
