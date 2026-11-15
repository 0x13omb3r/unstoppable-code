import { createContext } from 'react';
import type { CloudChatUploadTarget } from '@canopy/desktop-shared/types';
import { webCoreLocalId } from '@/lib/chat-authority';
import { webCoreChatId } from '@/stores/chat/web-core';
import { bareScope, qualifiedId } from '@/stores/chat/web-core/translate';

/**
 * The cloud chat a transcript shows, as main's file download names it
 * (CAN-6771): a sent attachment's chip saves through that chat's own web core
 * read, never through this computer's files. Null for a local chat.
 */
export const CloudChatFileTargetContext =
  createContext<CloudChatUploadTarget | null>(null);

/** The download target of a chat the store shows, or null for a local one. */
export function cloudChatFileTarget(
  target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  } | null,
): CloudChatUploadTarget | null {
  if (target === null || webCoreLocalId(target.worktreeId) === null)
    return null;
  const chatId = webCoreChatId(target.chatId);
  return chatId === null
    ? null
    : { key: qualifiedId(chatId), ...bareScope(target) };
}
