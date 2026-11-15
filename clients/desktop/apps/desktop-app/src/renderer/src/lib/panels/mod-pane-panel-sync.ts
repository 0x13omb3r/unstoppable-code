/**
 * Desktop's host for the shared Mod pane panel bridge
 * (`installClaudeModPanePanelSync`): panes open through the content panel
 * placement beside their chat, a worktree's layouts are keyed
 * `projectId/worktreeId`, and the focus rule reads the chat store and every
 * open panel window.
 */
import {
  installClaudeModPanePanelSync,
  modPanePanelSeed,
  type ClaudeModPanePanelHost,
  type ClaudeModPanePanelSeed,
  type ClaudeModSurfaceChat,
} from '@canopy/ui-app';
import type { ClaudeModPane } from '@canopy/protocol/extension-ui';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { draftHasContent } from '@/lib/chat-draft-content';
import { composerTurnActivity } from '@/stores/chat/turn-activity';
import type { ChatTab } from '@/stores/chat/types';
import { useChatStore } from '@/stores/chatStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import {
  openContentPanel,
  type ContentPanelIntent,
  type ContentPanelOpenResult,
} from './chat-panel-sync';

export { MOD_PANE_PANEL_NAME, modPanePanelInstanceKey } from '@canopy/ui-app';

/**
 * Opens, or reveals, the panel of one pane a Mod opened in `chat`. Fails
 * before touching the layout when the binding is not valid.
 */
export function openModPanePanel(
  chat: ClaudeModSurfaceChat,
  pane: Pick<ClaudeModPane, 'id' | 'title'>,
  intent: ContentPanelIntent = { kind: 'auto' },
): Promise<ContentPanelOpenResult> {
  const seed = modPanePanelSeed(chat, pane);
  if (seed === null) return Promise.resolve({ status: 'failed' });
  return openSeed(chat, seed, intent);
}

function openSeed(
  chat: ClaudeModSurfaceChat,
  seed: ClaudeModPanePanelSeed,
  intent: ContentPanelIntent = { kind: 'auto' },
): Promise<ContentPanelOpenResult> {
  return openContentPanel(
    makeWorktreePanelKey(chat.projectId, chat.worktreeId),
    seed,
    // From its chat: placed beside the conversation, never over it.
    { intent, origin: { chatTabId: chat.chatId } },
  );
}

/** A modal dialog is open in the main window or a popped-out panel window. */
function modalDialogOpen(): boolean {
  const documents = [
    document,
    ...Object.values(usePanelWindowsStore.getState().auxWindows)
      .filter((record) => !record.childWindow.closed)
      .map((record) => record.childWindow.document),
  ];
  return documents.some(
    (owner) =>
      owner.querySelector('[role="dialog"][aria-modal="true"]') !== null,
  );
}

function chatTab(
  state: ReturnType<typeof useChatStore.getState>,
  chat: ClaudeModSurfaceChat,
): ChatTab | undefined {
  return state.worktreeChats[`${chat.projectId}/${chat.worktreeId}`]?.tabs.find(
    (candidate) => candidate.id === chat.chatId,
  );
}

/** No turn is in flight in the chat, and no send waits for main to take it. */
function turnIsIdle(
  state: ReturnType<typeof useChatStore.getState>,
  chat: ClaudeModSurfaceChat,
): boolean {
  const tab = chatTab(state, chat);
  return (
    tab !== undefined &&
    composerTurnActivity(
      tab,
      state.runtimeByChatId[chat.chatId],
      Date.now(),
    ) === 'idle'
  );
}

/** Calls `onEnd` once the chat's turn has ended; at once when none runs. */
function whenTurnEnds(
  chat: ClaudeModSurfaceChat,
  onEnd: () => void,
): () => void {
  if (turnIsIdle(useChatStore.getState(), chat)) {
    onEnd();
    return (): void => undefined;
  }
  const unsubscribe = useChatStore.subscribe((state) => {
    if (!turnIsIdle(state, chat)) return;
    unsubscribe();
    onEnd();
  });
  return unsubscribe;
}

/** The chat's composer holds nothing and no turn runs, and no dialog is up. */
function composerIsIdle(chat: ClaudeModSurfaceChat): boolean {
  const state = useChatStore.getState();
  const tab = chatTab(state, chat);
  if (tab === undefined) return false;
  // A turn in flight, or a send main has yet to take.
  if (!turnIsIdle(state, chat)) return false;
  if (state.composerTextPresent[chat.chatId] === true) return false;
  if ((tab.pendingAttachments?.length ?? 0) > 0) return false;
  const draft = state.tabDrafts[chat.chatId];
  if (draft !== undefined && draftHasContent(draft)) return false;
  return !modalDialogOpen();
}

const desktopHost: ClaudeModPanePanelHost = {
  client: ipcCanopyClient,
  layoutKeyFor: (chat) => makeWorktreePanelKey(chat.projectId, chat.worktreeId),
  chatFor: (ownerKey, chatId) => {
    const separator = ownerKey.indexOf('/');
    return separator === -1
      ? null
      : {
          projectId: ownerKey.slice(0, separator),
          worktreeId: ownerKey.slice(separator + 1),
          chatId,
        };
  },
  openPanel: (chat, seed) => openSeed(chat, seed),
  composerIsIdle,
  whenTurnEnds,
  // The desktop runs the session, so it answers every ask a paired Portal
  // cannot grant.
  settlesFocusRequests: true,
  reportError: (error) => {
    reportClientAppError(error);
  },
};

let uninstall: (() => void) | null = null;

/**
 * Installs the bridge (idempotent; called from `PanelGridSurface` beside the
 * other panel bridges).
 */
export function initModPanePanelSync(): void {
  uninstall ??= installClaudeModPanePanelSync(desktopHost);
}

/** Test-only: tears down the subscriptions and clears all module state. */
export function resetModPanePanelSyncForTests(): void {
  uninstall?.();
  uninstall = null;
}
