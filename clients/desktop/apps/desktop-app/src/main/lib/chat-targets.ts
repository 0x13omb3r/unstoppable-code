import {
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type UsageLimitedChatTarget,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';

const USAGE_LIMIT_RESUME_EXCLUDED_PROJECT_IDS = new Set<string>([
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
]);

export function isRealWorkspaceTarget(target: UsageLimitedChatTarget): boolean {
  return (
    !isBotProjectId(target.projectId) &&
    !USAGE_LIMIT_RESUME_EXCLUDED_PROJECT_IDS.has(target.projectId)
  );
}

/** Whether the Chats preference should automatically retry this surface. */
export function isTransientRetryEligibleTarget(
  target: UsageLimitedChatTarget,
): boolean {
  return !isBotProjectId(target.projectId);
}
