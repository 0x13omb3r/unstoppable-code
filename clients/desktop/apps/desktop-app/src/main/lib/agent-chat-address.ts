import type { BotChatAddress } from '@canopy/desktop-shared/lib/bot-discovery';
import type { ProjectChatAddress } from '@canopy/desktop-shared/lib/project-discovery';
import { botIdForProjectId } from '@canopy/protocol/chat-targets';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';

/**
 * The address the agent actions use for a stored chat: a `botId` for any Bot,
 * else the canonical project, with legacy Cowork ids resolved.
 */
export function agentChatAddress(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ProjectChatAddress | BotChatAddress {
  const botId = botIdForProjectId(projectId);
  if (botId !== null) return { botId, taskId: worktreeId, chatId };
  return {
    projectId: resolveCoworkWorkspaceId(projectId),
    taskId: worktreeId,
    chatId,
  };
}
