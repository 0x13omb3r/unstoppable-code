import { useEffect, useMemo, useRef, type JSX } from 'react';
import {
  AutomationsPanel as SharedAutomationsPanel,
  type AutomationsPanelProps,
} from '@canopy/ui-app/workflows';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useWorkflowsPanelWatcherStore } from '@/client/workflows-panel-client';
import { visibleWatchers } from '@/components/watchers/watcherFilters';
import { WatcherManagementModal } from '@/components/watchers/WatcherManagementModal';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { bringMainWindowForward } from '@/lib/panels/main-window-focus';
import { filterWatchersForScope } from './automations-panel-data';
import { useAutomationsStore } from '@/stores/automationsStore';

/** Desktop presentation host; shared panel owns all Workflows rendering. */
export function AutomationsPanel(props: AutomationsPanelProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const watcherId = useWorkflowsPanelWatcherStore(
    (state) => state.selected[props.panelId],
  );
  const active = useAppAdvisorWatchersStore((state) => state.watchers);
  const completed = useAppAdvisorWatchersStore(
    (state) => state.completedWatchers,
  );
  const activities = useAutomationsStore((state) => state.activities);
  const watcher = useMemo(
    () =>
      filterWatchersForScope(
        [...visibleWatchers(active), ...completed],
        { ...props, worktreeOnly: false },
        activities,
      ).find((entry) => entry.id === watcherId),
    [active, completed, activities, props, watcherId],
  );
  useEffect(
    () => (): void =>
      useWorkflowsPanelWatcherStore.getState().select(props.panelId, undefined),
    [props.panelId],
  );
  useEffect(() => {
    if (watcherId !== undefined && !watcher)
      useWorkflowsPanelWatcherStore.getState().select(props.panelId, undefined);
  }, [watcher, watcherId, props.panelId]);
  useCurrentUiStateReporter(`automations.panel.${props.panelId}`, {
    panelId: props.panelId,
    variant: props.variant,
    projectId: props.projectId,
    worktreeId: props.worktreeId,
    detailsModalOpen: false,
    sharedPipelineReviewModalOpen: false,
    watcherModalOpen: watcher !== undefined,
    ...(watcher ? { watcherModalWatcherId: watcher.id } : {}),
    formOpen: false,
  });
  return (
    <div ref={rootRef} className="contents">
      <SharedAutomationsPanel
        {...props}
        onNavigate={(): void =>
          bringMainWindowForward(rootRef.current?.ownerDocument)
        }
      />
      {watcher && (
        <WatcherManagementModal
          title="Watcher"
          emptyMessage="This watcher is no longer available."
          watchers={[watcher]}
          onClose={(): void =>
            useWorkflowsPanelWatcherStore
              .getState()
              .select(props.panelId, undefined)
          }
          ownerDocument={rootRef.current?.ownerDocument}
        />
      )}
    </div>
  );
}
