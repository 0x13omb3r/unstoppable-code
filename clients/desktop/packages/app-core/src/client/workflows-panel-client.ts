/** Portable read projection for the workspace Workflows panel (BOTS-18).
 * This is a renderer feed over existing host data, not a backend operation.
 * Hosts retain raw records, checkout paths, navigation and watcher management.
 */
export interface WorkflowsPanelScope {
  readonly panelId: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly worktreeOnly: boolean;
}

export type WorkflowsPanelKind = 'automation' | 'pipeline' | 'watcher';
export type WorkflowsPanelTypeFilter =
  | 'all'
  | 'automations'
  | 'pipelines'
  | 'watchers';
export type WorkflowsPanelRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'watching'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'canceled'
  | 'missed'
  | 'fired'
  | 'delivery-failed';

export interface WorkflowsPanelUpcomingEntry {
  readonly key: string;
  readonly activityId: string;
  readonly name: string;
  readonly occursAt: number;
  readonly withinSoonWindow: boolean;
}

export interface WorkflowsPanelLibraryRow {
  readonly key: string;
  readonly id: string;
  readonly kind: WorkflowsPanelKind;
  readonly name: string;
  /** Original name before the display fallback, preserving search behavior. */
  readonly searchName: string;
  readonly trigger: string;
  readonly status: string;
  readonly reviewNeeded?: boolean;
  readonly title?: string;
}

export interface WorkflowsPanelRunRow {
  readonly key: string;
  readonly kind: WorkflowsPanelKind;
  readonly name: string;
  readonly status: WorkflowsPanelRunStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface WorkflowsPanelSnapshot {
  readonly workspaceLabel: string;
  readonly worktreeLabel: string;
  readonly hasWorktrees: boolean;
  readonly canCreate: boolean;
  readonly now: number;
  readonly upcoming: readonly WorkflowsPanelUpcomingEntry[];
  readonly library: readonly WorkflowsPanelLibraryRow[];
  readonly runs: readonly WorkflowsPanelRunRow[];
  readonly loadErrors: readonly string[];
  readonly loading: boolean;
  readonly runsLoading: boolean;
  readonly runsError: string | null;
}

export type WorkflowsPanelIntent =
  | { readonly kind: 'create' }
  | { readonly kind: 'activity'; readonly id: string }
  | { readonly kind: 'library'; readonly key: string }
  | { readonly kind: 'run'; readonly key: string }
  | { readonly kind: 'retry' }
  | { readonly kind: 'retry-runs' };

export interface WorkflowsPanelClient {
  /** One retained, live feed per mounted scope; disposal releases its sources. */
  readonly subscribe: (
    scope: WorkflowsPanelScope,
    listener: (snapshot: WorkflowsPanelSnapshot) => void,
  ) => () => void;
  readonly dispatch: (
    scope: WorkflowsPanelScope,
    intent: WorkflowsPanelIntent,
  ) => void;
}
