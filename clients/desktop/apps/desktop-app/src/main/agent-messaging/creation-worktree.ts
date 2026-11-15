import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { AgentChatSendError } from './send-orchestration';
import { getMainWindow } from '../lib/main-window-focus';
import { startProjectWorktreePostCreateSetup } from '../lib/project-worktree-runtime';
import { IdentifierValidationError } from '../lib/validation';
import { sendToWindow } from '../lib/window-send';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { startWorkspaceWorktreePostCreateSetup } from '../lib/workspace-worktree-runtime';
import { createWorktreeFromSelection } from '../lib/worktree-creation';
import { WorktreeCreationRefusedError } from '../lib/worktree-creation-selection';

/**
 * Create a code task's worktree through the main-owned creation boundary, as
 * the renderer's own create does: Git setup and setup scripts finish in the
 * background, and the window hears about the new row and its readiness.
 */
export async function createAgentTaskWorktree(input: {
  projectId: string;
  workspaceKind: 'single-repo' | 'multi-repo';
  branchName?: string;
  baseBranch?: string;
  baseTaskId?: string;
}): Promise<string> {
  let outcome;
  try {
    outcome = await createWorktreeFromSelection({
      workspaceId: input.projectId,
      workspaceKind: input.workspaceKind,
      branch: input.branchName
        ? { kind: 'new', branchName: input.branchName }
        : { kind: 'default' },
      base: input.baseTaskId
        ? { kind: 'worktree', baseWorktreeId: input.baseTaskId }
        : input.baseBranch
          ? { kind: 'branch', baseBranch: input.baseBranch }
          : { kind: 'repository-default' },
      startPostCreateSetup: true,
      startProjectPostCreateSetup: startProjectWorktreePostCreateSetup,
      startWorkspacePostCreateSetup: startWorkspaceWorktreePostCreateSetup,
      getWindow: getMainWindow,
      deferGitSetup: true,
      onGitReady: (payload) =>
        sendToWindow(getMainWindow(), IPC_CHANNELS.worktreeGitReady, payload),
      onGitFailed: (payload) =>
        sendToWindow(getMainWindow(), IPC_CHANNELS.worktreeGitFailed, payload),
      onNeedsRepair: (payload) =>
        sendToWindow(
          getMainWindow(),
          IPC_CHANNELS.worktreeNeedsRepair,
          payload,
        ),
    });
  } catch (error) {
    if (
      error instanceof WorktreeCreationRefusedError ||
      error instanceof IdentifierValidationError
    )
      throw new AgentChatSendError('validation_failed', error.message);
    throw error;
  }
  if (outcome.status === 'needs-repair')
    throw new AgentChatSendError(
      'target_not_ready',
      'The project needs repair before a task can be created.',
    );
  sendToWindow(getMainWindow(), IPC_CHANNELS.workspaceWorktreesUpdated, {
    workspaceId: input.projectId,
    worktrees: await readWorkspaceWorktrees(input.projectId),
  });
  return outcome.record.worktreeId;
}
