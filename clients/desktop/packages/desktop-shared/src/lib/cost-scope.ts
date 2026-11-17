/**
 * Which `(projectId, worktreeId)` pairs keep cost: a Code worktree, or a
 * Cowork or Bot Work Entry. Reserved chat scopes, such as the
 * Pipeline Assistant's, the plan and review helpers' and the Cowork home
 * composer's, keep none and have no cost views.
 */
import {
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '../types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';

const SYNTHETIC_PROJECT_IDS: ReadonlySet<string> = new Set([
  STANDALONE_CHAT_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
]);

const SYNTHETIC_WORKTREE_IDS: ReadonlySet<string> = new Set([
  APP_ADVISOR_WORKTREE_ID,
  COWORK_HOME_WORKTREE_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
]);

/** Whether the pair names a scope the cost index keeps an entry for. */
export function isCostWorkScope(
  projectId: string,
  worktreeId: string,
): boolean {
  // Bot project IDs are reserved scope names, but their Work Entry IDs are
  // independently retained cost scopes. The legacy `global` slot is excluded.
  if (isBotProjectId(projectId)) {
    return worktreeId !== APP_ADVISOR_WORKTREE_ID;
  }

  return (
    !SYNTHETIC_PROJECT_IDS.has(projectId) &&
    !SYNTHETIC_WORKTREE_IDS.has(worktreeId)
  );
}
