import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_BOT_ID,
  type BotChatAddress,
} from '@canopy/desktop-shared/lib/bot-discovery';
import type { ProjectChatAddress } from '@canopy/desktop-shared/lib/project-discovery';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';

/**
 * The address the agent actions use for a stored chat: a `botId` for App
 * Advisor, else the canonical project, with legacy Cowork ids resolved.
 */
export function agentChatAddress(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ProjectChatAddress | BotChatAddress {
  return projectId === APP_ADVISOR_PROJECT_ID
    ? { botId: APP_ADVISOR_BOT_ID, taskId: worktreeId, chatId }
    : {
        projectId: resolveCoworkWorkspaceId(projectId),
        taskId: worktreeId,
        chatId,
      };
}
