import type { PendingSystemInstruction } from '../types';
import { sanitizeSystemInstructionText } from './pending-system-instructions';
import type { ProjectChatAddress } from './project-discovery';
import type { BotChatAddress } from './bot-discovery';

const CHAT_ADDRESS_CHANGED_INSTRUCTION_ID = 'chat-address-changed';

function formatAddress(address: ProjectChatAddress | BotChatAddress): string {
  const owner =
    'botId' in address
      ? `botId ${JSON.stringify(address.botId)}`
      : `projectId ${JSON.stringify(address.projectId)}`;
  return `${owner}, taskId ${JSON.stringify(address.taskId)}, chatId ${JSON.stringify(address.chatId)}`;
}

/**
 * The system prompt line that tells a chat its own address. Stable for the
 * chat's lifetime, so it never changes the prompt between ordinary turns.
 */
export function chatAddressPrompt(
  address: ProjectChatAddress | BotChatAddress,
): string {
  return `This chat's own address: ${formatAddress(address)}. Use these IDs when an action needs this chat's project, task or chat. This address is current: it replaces any different address for this chat named earlier in the conversation.`;
}

/**
 * The system prompt line for a managed delegate, which acts for its root chat
 * and has no address of its own in the action surface.
 */
export function rootChatAddressPrompt(
  address: ProjectChatAddress | BotChatAddress,
): string {
  return `The root chat you work for has the address: ${formatAddress(address)}.`;
}

/**
 * Replace any unconsumed address note with the latest one, for a chat that was
 * moved, forked or branched under new IDs. A provider session keeps the
 * conversation it saw before, so this one-shot instruction makes the new IDs
 * authoritative over any earlier address.
 */
export function withChatAddressChangedInstruction(
  instructions: PendingSystemInstruction[] | undefined,
  current: ProjectChatAddress | BotChatAddress,
  previous: ProjectChatAddress | BotChatAddress,
): PendingSystemInstruction[] {
  const retained = (instructions ?? []).filter(
    (instruction) => instruction.id !== CHAT_ADDRESS_CHANGED_INSTRUCTION_ID,
  );
  if (formatAddress(current) === formatAddress(previous)) return retained;
  return [
    ...retained,
    {
      id: CHAT_ADDRESS_CHANGED_INSTRUCTION_ID,
      text: sanitizeSystemInstructionText(
        `This chat has a new address: ${formatAddress(current)}. These IDs replace any address for this chat shown earlier in this conversation. The chat it came from has the address ${formatAddress(previous)}; use that only to refer to that chat.`,
      ),
    },
  ];
}
