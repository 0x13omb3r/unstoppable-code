import type { AgentSentSender, AgentSentSenderOpener } from '@canopy/ui-shared';
import { isBotId, projectIdForBotId } from '@canopy/protocol/chat-targets';
import { isArchivedChat } from '@/lib/chat-archive-status';
import { navigateToUnreadChat } from '@/stores/chat/notifications';

/**
 * Opens the sender's chat, or, once it is archived, its transcript read-only.
 * Pipeline and cloud-chat senders have no local chat to open.
 */
export async function openSender(sender: AgentSentSender): Promise<void> {
  if (sender.kind === 'pipeline' || sender.kind === 'cloud_chat') return;
  const projectId =
    sender.kind === 'project'
      ? sender.projectId
      : isBotId(sender.botId)
        ? projectIdForBotId(sender.botId)
        : undefined;
  if (projectId === undefined) return;
  const target = {
    projectId,
    worktreeId: sender.taskId,
    chatId: sender.chatId,
  };
  const archived =
    sender.kind === 'project' && (await isArchivedChat(target, target.chatId));
  await navigateToUnreadChat({
    ...target,
    ...(archived ? { openArchivedTranscript: true } : {}),
  });
}

function open(sender: AgentSentSender): void {
  void openSender(sender);
}

/** The main window opens project senders in place and Bots in the Bot renderer. */
export const mainWindowSenderOpener: AgentSentSenderOpener = {
  canOpen: (sender) =>
    sender.kind === 'project' ||
    (sender.kind === 'bot' && isBotId(sender.botId)),
  open,
};

/**
 * The Bot renderer opens chats for every Bot.
 * shortcut: project senders need an App Advisor to main window navigation
 * bridge; add one if the Bot renderer should open project chats.
 */
export const appAdvisorWindowSenderOpener: AgentSentSenderOpener = {
  canOpen: (sender) => sender.kind === 'bot' && isBotId(sender.botId),
  open,
};
