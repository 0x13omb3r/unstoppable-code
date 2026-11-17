import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';

const UNSUPPORTED_SESSION_TRANSFER_TARGETS = new Set([
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
]);

/** Real git-backed and Cowork workspaces can create private session exports. */
export function canTransferChatSession(projectId: string): boolean {
  return (
    !isBotProjectId(projectId) &&
    !UNSUPPORTED_SESSION_TRANSFER_TARGETS.has(projectId)
  );
}
