/**
 * What a move of a workflow schedule to the cloud reads on this computer
 * (CAN-6917, cloud pipelines CP-47): the GitHub repository and branch the
 * schedule's project and task run in, to find the matching cloud project and
 * task, and the reviewed version of a shared workflow.
 */
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type {
  AutomationAction,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import type { PipelineShareInstallPin } from '@canopy/protocol/pipelines';
import { getCurrentBranch } from '@canopy/desktop-shared/lib/git';
import { getRemoteUrl } from '../lib/git';
import {
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../lib/paths';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { getSharedPipeline } from '../pipelines/canopy-server-client';
import { githubRepositoryOfRemote } from '../pipelines/cloud-run-local-checkout';
import { assertSharedPipelineMatchesAutomationInstallPin } from '../pipelines/pipeline-package-service';
import type { CloudScheduleHost } from './cloud-schedules';
import type { LocalSchedulePlace } from './cloud-schedule-destinations';

type PipelineAction = Extract<AutomationAction, { type: 'worktree_pipeline' }>;

/** The folder a project-level run of `repoId` works in; null for none. */
function projectFolder(
  workspace: SidebarItem,
  repoId: string | undefined,
): string | null {
  if (workspace.type === 'cowork') return null;
  if (workspace.type === 'single-repo') return workspace.repoPath;
  if (repoId && repoId !== WORKSPACE_ROOT_REPO_ID)
    return workspace.repos.find((repo) => repo.id === repoId)?.repoPath ?? null;
  return workspace.sourceRepoPath ?? null;
}

function worktreeFolder(
  workspaceId: string,
  worktreeId: string,
  repoId: string | undefined,
): string {
  return !repoId || repoId === WORKSPACE_ROOT_REPO_ID
    ? getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId)
    : getWorkspaceWorktreeRepoDir(workspaceId, worktreeId, repoId);
}

async function repositoryAt(folder: string | null): Promise<string | null> {
  if (folder === null) return null;
  const url = await getRemoteUrl(folder).catch(() => null);
  return url === null ? null : githubRepositoryOfRemote(url);
}

async function branchAt(folder: string): Promise<string | null> {
  const branch = (await getCurrentBranch(folder).catch(() => '')).trim();
  return branch === '' || branch === 'HEAD' ? null : branch;
}

async function localPlace(
  action: PipelineAction,
): Promise<LocalSchedulePlace | null> {
  const { workspaceId } = action;
  if (workspaceId === undefined) return null;
  const { items } = await readAllSidebarItems();
  const workspace = items.find((item) => item.id === workspaceId);
  if (workspace === undefined) return null;
  if (workspace.type === 'cowork')
    return { kind: 'cowork', repository: null, branch: null };
  const target = action.target;
  const task =
    target?.kind === 'task'
      ? target.taskId
      : target === undefined || target.kind === 'new_worktree'
        ? action.baseWorktreeId
        : undefined;
  if (task === undefined)
    return {
      kind: 'git',
      repository: await repositoryAt(projectFolder(workspace, action.repoId)),
      branch: null,
    };
  const folder = worktreeFolder(workspaceId, task, action.repoId);
  return {
    kind: 'git',
    repository: await repositoryAt(folder),
    branch: await branchAt(folder),
  };
}

/** Main's host: this computer's projects, and the shared catalog. */
export const DESKTOP_CLOUD_SCHEDULE_HOST: CloudScheduleHost = {
  localPlace,
  async pinnedSharedDocument(
    remoteId: string,
    pin: PipelineShareInstallPin,
  ): Promise<string> {
    const detail = await getSharedPipeline(remoteId);
    assertSharedPipelineMatchesAutomationInstallPin(detail, pin);
    return detail.rawPipeline;
  },
};
