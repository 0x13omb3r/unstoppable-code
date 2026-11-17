'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  WorkflowsPanelScope,
  WorkflowsPanelSnapshot,
} from '@canopy/app-core';
import {
  useCanopyClient,
  useWorkspaceCapabilities,
} from './CanopyClientProvider';

type WorkflowsPanelHeader = Pick<
  WorkflowsPanelSnapshot,
  'workspaceLabel' | 'worktreeLabel' | 'hasWorktrees' | 'canCreate'
>;

/** Never subscribes on hosts that cannot provide the workspace feed. */
export function useWorkflowsPanelFeed(scope: WorkflowsPanelScope): {
  readonly available: boolean;
  readonly header: WorkflowsPanelHeader | null;
  readonly snapshot: WorkflowsPanelSnapshot | null;
} {
  const client = useCanopyClient();
  const capabilities = useWorkspaceCapabilities(scope.projectId);
  const feed =
    capabilities.workflowsPanel === true ? client.workflowsPanel : undefined;
  const { panelId, projectId, worktreeId, worktreeOnly } = scope;
  const request = useMemo(
    () => ({ panelId, projectId, worktreeId, worktreeOnly }),
    [panelId, projectId, worktreeId, worktreeOnly],
  );
  const [loaded, setLoaded] = useState<{
    readonly feed: typeof feed;
    readonly request: WorkflowsPanelScope;
    readonly snapshot: WorkflowsPanelSnapshot;
  } | null>(null);
  useEffect(() => {
    if (!feed) return;
    let active = true;
    const release = feed.subscribe(request, (snapshot) => {
      if (active) setLoaded({ feed, request, snapshot });
    });
    return (): void => {
      active = false;
      release();
    };
  }, [feed, request]);
  // Keep header controls mounted across filter changes. Rows still require
  // the exact request, so a scope change never displays stale rows.
  const header =
    loaded !== null &&
    loaded.feed === feed &&
    loaded.request.panelId === panelId &&
    loaded.request.projectId === projectId &&
    loaded.request.worktreeId === worktreeId
      ? {
          workspaceLabel: loaded.snapshot.workspaceLabel,
          worktreeLabel: loaded.snapshot.worktreeLabel,
          hasWorktrees: loaded.snapshot.hasWorktrees,
          canCreate: loaded.snapshot.canCreate,
        }
      : null;
  return {
    header,
    available: feed !== undefined,
    snapshot:
      loaded?.feed === feed && loaded?.request === request
        ? loaded.snapshot
        : null,
  };
}
