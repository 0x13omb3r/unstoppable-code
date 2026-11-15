/**
 * Mod pane panels ⇄ each chat's Claude Mod pane roster, for any host whose
 * panels live in the shared panel layout store.
 *
 * A pane a Mod opens in a chat opens (or reveals) a `mod-pane` panel in that
 * chat's layout family, and a pane the Mod closes closes its panel. When the
 * person closes a pane's panel, the chat's session gets the pane's own close
 * control (its `role: dismiss` button) or, without one, `ui_close`.
 *
 * A restored tab whose chat has no live session keeps its place and shows
 * the pane closed; it closes only when a live roster drops its pane, never
 * when the session's surface ends, so a relaunch or a restart never costs
 * the person a layout. A tab is closed by the person when its binding leaves
 * a layout that still exists and appears in no other once the layout store
 * settles: a pop-out commits its source and window layouts one after the
 * other, so layout changes are reconciled a microtask later, and a layout
 * torn down with its worktree is not a close.
 *
 * A pane that asks for the keyboard (`focus_requested_id`) gets it only
 * while its chat's composer is empty and idle and no dialog is up: its panel
 * is revealed and focused, and the session is told (`ui_pane_focus`).
 * Otherwise a host that settles the session's asks (the desktop that runs it)
 * refuses the request, so typing is never taken from the person; a host that
 * only mirrors the session (a paired Portal) leaves it to that one.
 *
 * A pane whose panel cannot be placed yet, because its worktree's layout or
 * its chat's panel has not loaded, is placed when the layouts next change.
 *
 * The host supplies what differs between desktop and the web Portal: its
 * client, how a chat maps to a layout key, where a new panel is placed, and
 * what makes its composer busy.
 */
import type { CanopyClient } from '@canopy/app-core';
import {
  clampPanelTitle,
  isModPanePanelInstance,
  type PanelKind,
} from '@canopy/protocol';
import {
  findExtensionUiDismiss,
  type ClaudeModPane,
  type ClaudeModPaneRoster,
  type ClaudeModSurfaceCommand,
} from '@canopy/protocol/extension-ui';
import {
  findPanelByInstanceKey,
  getAuxPanelLayoutOwnerKey,
  getPanelInstanceKey,
  usePanelLayoutStore,
  type PanelInstanceLocation,
  type WorktreePanelLayout,
} from '../../code/panels/panel-layout-store';
import {
  focusClaudeModPane,
  readClaudeModSurface,
  watchClaudeModPaneRosters,
  type ClaudeModSurfaceChat,
} from './ClaudeModSurface';

/** The name of a pane's tab before its Mod gives it a title. */
export const MOD_PANE_PANEL_NAME = 'Mod pane';

const KIND = 'mod-pane' satisfies PanelKind;

/** The tab a pane opens as. */
export interface ClaudeModPanePanelSeed {
  readonly kind: 'mod-pane';
  readonly panelId: string;
  readonly title: string;
  readonly instance: { readonly chatId: string; readonly paneId: string };
}

/**
 * `revealed`: the pane's tab was already open and was brought into view.
 * `placed`: a new tab was added and revealed. `unavailable`: the chat's
 * worktree has no panel layout. `failed`: no group accepted the tab.
 */
export type ClaudeModPanePanelOpenResult =
  | {
      readonly status: 'revealed' | 'placed';
      readonly location: PanelInstanceLocation;
    }
  | { readonly status: 'unavailable' | 'failed' };

export interface ClaudeModPanePanelHost {
  readonly client: CanopyClient;
  /** The layout family a chat's panels live in. */
  readonly layoutKeyFor: (chat: ClaudeModSurfaceChat) => string;
  /**
   * The chat a tab in the layout family `ownerKey` is bound to, or null
   * when that family is not one this host draws.
   */
  readonly chatFor: (
    ownerKey: string,
    chatId: string,
  ) => ClaudeModSurfaceChat | null;
  /** Opens, or reveals, a pane's tab beside its chat. */
  readonly openPanel: (
    chat: ClaudeModSurfaceChat,
    seed: ClaudeModPanePanelSeed,
  ) => Promise<ClaudeModPanePanelOpenResult>;
  /** The chat's composer holds nothing and no turn runs, and no dialog is up. */
  readonly composerIsIdle: (chat: ClaudeModSurfaceChat) => boolean;
  /**
   * Calls `onEnd` once the chat's turn has ended, at once when none runs,
   * and returns a cancel. A Mod usually asks for the keyboard from inside a
   * turn (a command or a hook), so a host that offers this lets the ask wait
   * for the turn instead of refusing it.
   */
  readonly whenTurnEnds?: (
    chat: ClaudeModSurfaceChat,
    onEnd: () => void,
  ) => () => void;
  /**
   * Whether this host answers every ask for the keyboard, refusing the ones
   * it cannot grant. Only one host may: two refusing hosts would undo each
   * other's grants.
   */
  readonly settlesFocusRequests: boolean;
  /** A surface command the host refused. */
  readonly reportError: (error: unknown) => void;
}

function paneTitle(pane: Pick<ClaudeModPane, 'title'>): string {
  const title = pane.title.trim();
  return clampPanelTitle(title.length > 0 ? title : MOD_PANE_PANEL_NAME);
}

/** The layout store's family-wide identity key for one pane of a chat. */
export function modPanePanelInstanceKey(
  chatId: string,
  paneId: string,
): string {
  return getPanelInstanceKey({ kind: KIND, instance: { chatId, paneId } });
}

/** The tab one pane of `chat` opens as, or null when the binding is not valid. */
export function modPanePanelSeed(
  chat: ClaudeModSurfaceChat,
  pane: Pick<ClaudeModPane, 'id' | 'title'>,
): ClaudeModPanePanelSeed | null {
  const instance = { chatId: chat.chatId, paneId: pane.id };
  if (!isModPanePanelInstance(instance)) return null;
  return {
    kind: KIND,
    panelId: `panel-mod-pane-${chat.chatId.replace(/[^A-Za-z0-9_-]/g, '_')}-${pane.id}`,
    title: paneTitle(pane),
    instance,
  };
}

interface ModPaneBinding {
  readonly layoutKey: string;
  readonly chat: ClaudeModSurfaceChat;
  readonly paneId: string;
}

/** Every `mod-pane` tab of the host's layouts, by its family-wide identity key. */
function collectBindings(
  host: ClaudeModPanePanelHost,
  layouts: Readonly<Record<string, WorktreePanelLayout>>,
): Map<string, ModPaneBinding> {
  const bindings = new Map<string, ModPaneBinding>();
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
    for (const group of Object.values(layout.groups)) {
      for (const tab of group.tabs) {
        if (tab.kind !== KIND || !isModPanePanelInstance(tab.instance)) {
          continue;
        }
        const chat = host.chatFor(ownerKey, tab.instance.chatId);
        if (chat === null) continue;
        bindings.set(getPanelInstanceKey(tab), {
          layoutKey,
          chat,
          paneId: tab.instance.paneId,
        });
      }
    }
  }
  return bindings;
}

/**
 * Installs the bridge for one host and returns its uninstall. A host
 * installs it once for its client.
 */
export function installClaudeModPanePanelSync(
  host: ClaudeModPanePanelHost,
): () => void {
  const { client } = host;
  let stopped = false;
  /** The bindings as of the last settled layout. */
  let bindings = collectBindings(host, usePanelLayoutStore.getState().layouts);
  /** Panels this bridge closed because their Mod closed the pane. */
  const closedByMod = new Set<string>();
  /**
   * Panes a live roster dropped while they had no tab, such as one still
   * opening; a surface reset never adds to it.
   */
  const droppedByMod = new Set<string>();
  /** Panes the Mod opened whose panel could not be placed yet, by identity key. */
  const unplaced = new Map<
    string,
    { readonly chat: ClaudeModSurfaceChat; readonly paneId: string }
  >();
  let pendingSweep = false;

  const send = (
    chat: ClaudeModSurfaceChat,
    command: ClaudeModSurfaceCommand,
  ): void => {
    // A session that is gone, or no longer draws its surface, ignores it;
    // only a command the host refuses fails.
    client
      .command('claudeMods.surfaceCommand', { ...chat, command })
      .catch(host.reportError);
  };

  const openModPanePanel = (
    chat: ClaudeModSurfaceChat,
    pane: ClaudeModPane,
  ): Promise<ClaudeModPanePanelOpenResult> => {
    const seed = modPanePanelSeed(chat, pane);
    return seed === null
      ? Promise.resolve({ status: 'failed' })
      : host.openPanel(chat, seed);
  };

  /** The person closed a pane's panel: close the pane the way its Mod asks. */
  const closePane = (binding: ModPaneBinding): void => {
    const tree = readClaudeModSurface(client, binding.chat).panes[
      binding.paneId
    ];
    send(
      binding.chat,
      findExtensionUiDismiss(tree ?? null) ?? {
        kind: 'pane-close',
        paneId: binding.paneId,
      },
    );
  };

  const sweepLayouts = (): void => {
    const { layouts } = usePanelLayoutStore.getState();
    const next = collectBindings(host, layouts);
    for (const [key, binding] of bindings) {
      if (next.has(key) || closedByMod.has(key)) continue;
      if (layouts[binding.layoutKey] !== undefined) closePane(binding);
    }
    bindings = next;
    closedByMod.clear();
    // A layout that loaded may now take a pane that could not be placed.
    for (const [key, { chat, paneId }] of unplaced) {
      unplaced.delete(key);
      const pane = readClaudeModSurface(client, chat).roster.panes.find(
        (open) => open.id === paneId,
      );
      if (pane !== undefined) openFromRoster(chat, pane);
    }
  };

  const scheduleSweep = (): void => {
    if (pendingSweep) return;
    pendingSweep = true;
    queueMicrotask((): void => {
      if (!pendingSweep || stopped) return;
      pendingSweep = false;
      sweepLayouts();
    });
  };

  /**
   * Opens a pane the Mod just opened. If the Mod closed it again while the
   * layout was loading, the panel this placed closes with it; a surface that
   * ended meanwhile leaves it, like every other pane tab.
   */
  const openFromRoster = (
    chat: ClaudeModSurfaceChat,
    pane: ClaudeModPane,
  ): void => {
    const instanceKey = modPanePanelInstanceKey(chat.chatId, pane.id);
    droppedByMod.delete(instanceKey);
    void openModPanePanel(chat, pane).then((opened): void => {
      if (stopped) return;
      if (opened.status !== 'placed' && opened.status !== 'revealed') {
        // Unless the Mod closed it meanwhile, place it once a layout can.
        if (!droppedByMod.delete(instanceKey)) {
          unplaced.set(instanceKey, { chat, paneId: pane.id });
        }
        return;
      }
      // A restored tab the open revealed closes as well as one it placed.
      if (!droppedByMod.delete(instanceKey)) return;
      closedByMod.add(instanceKey);
      const { location } = opened;
      usePanelLayoutStore
        .getState()
        .closeTab(location.layoutKey, location.groupId, location.panelId);
    });
  };

  /**
   * Refuses a pane's ask for the keyboard. Any `ui_pane_focus` settles the
   * ask, and `null` would also take the keyboard from a pane that holds it,
   * so the refusal names the holder.
   */
  const refuseFocusRequest = (chat: ClaudeModSurfaceChat): void => {
    if (!host.settlesFocusRequests) return;
    const { roster } = readClaudeModSurface(client, chat);
    send(chat, { kind: 'pane-focus', paneId: roster.focusedId });
  };

  // Asks waiting for their chat's turn to end, by chat.
  const turnWaits = new Map<string, () => void>();
  const chatWaitKey = (chat: ClaudeModSurfaceChat): string =>
    [chat.projectId, chat.worktreeId, chat.chatId].join('\u0000');
  const cancelTurnWait = (chat: ClaudeModSurfaceChat): void => {
    const key = chatWaitKey(chat);
    turnWaits.get(key)?.();
    turnWaits.delete(key);
  };

  /** Judges a pane's standing ask for the keyboard. */
  const answerFocusRequest = (
    chat: ClaudeModSurfaceChat,
    pane: ClaudeModPane,
    afterTurn = false,
  ): void => {
    cancelTurnWait(chat);
    if (!host.composerIsIdle(chat)) {
      if (!afterTurn && host.whenTurnEnds) {
        // Judged again once the turn ends; the person's draft or a dialog
        // still refuses it then.
        const key = chatWaitKey(chat);
        let settled = false;
        const cancel = host.whenTurnEnds(chat, (): void => {
          settled = true;
          turnWaits.delete(key);
          if (stopped) return;
          const { roster } = readClaudeModSurface(client, chat);
          if (roster.focusRequestedId === pane.id) {
            answerFocusRequest(chat, pane, true);
          }
        });
        if (!settled) turnWaits.set(key, cancel);
        return;
      }
      refuseFocusRequest(chat);
      return;
    }
    void openModPanePanel(chat, pane).then((opened): void => {
      if (stopped) return;
      // Opening can wait on the layout: the ask may be settled by then, and
      // the person may have started typing.
      const { roster } = readClaudeModSurface(client, chat);
      if (roster.focusRequestedId !== pane.id) return;
      if (
        (opened.status !== 'placed' && opened.status !== 'revealed') ||
        !host.composerIsIdle(chat)
      ) {
        refuseFocusRequest(chat);
        return;
      }
      // The pane's view reports the hold itself once it takes the keyboard.
      focusClaudeModPane(client, chat, pane.id);
    });
  };

  const onRoster = (
    chat: ClaudeModSurfaceChat,
    roster: ClaudeModPaneRoster,
    previous: ClaudeModPaneRoster,
    reset: boolean,
  ): void => {
    const asked = roster.panes.find(
      (pane) => pane.id === roster.focusRequestedId,
    );
    if (
      asked !== undefined &&
      roster.focusRequestedId !== previous.focusRequestedId
    ) {
      answerFocusRequest(chat, asked);
    } else if (asked === undefined) {
      cancelTurnWait(chat);
    }
    const worktreeKey = host.layoutKeyFor(chat);
    const before = new Map(previous.panes.map((pane) => [pane.id, pane]));
    const now = new Set(roster.panes.map((pane) => pane.id));
    for (const pane of roster.panes) {
      const listed = before.get(pane.id);
      if (listed === undefined) {
        // A pane the person closed while its Mod kept it open stays closed.
        openFromRoster(chat, pane);
        continue;
      }
      if (listed.title === pane.title) continue;
      const location = findPanelByInstanceKey(
        worktreeKey,
        modPanePanelInstanceKey(chat.chatId, pane.id),
      );
      if (location === null) continue;
      usePanelLayoutStore
        .getState()
        .updateTabInstanceTitle(worktreeKey, location.panelId, paneTitle(pane));
    }
    // The surface ended: its panes' tabs stay, showing the panes closed.
    if (reset) {
      for (const paneId of before.keys()) {
        if (!now.has(paneId)) {
          unplaced.delete(modPanePanelInstanceKey(chat.chatId, paneId));
        }
      }
      return;
    }
    for (const paneId of before.keys()) {
      if (now.has(paneId)) continue;
      const instanceKey = modPanePanelInstanceKey(chat.chatId, paneId);
      if (unplaced.delete(instanceKey)) continue;
      const location = findPanelByInstanceKey(worktreeKey, instanceKey);
      if (location === null) {
        droppedByMod.add(instanceKey);
        continue;
      }
      closedByMod.add(instanceKey);
      usePanelLayoutStore
        .getState()
        .closeTab(location.layoutKey, location.groupId, location.panelId);
    }
  };

  let previousLayouts = usePanelLayoutStore.getState().layouts;
  const unsubscribers = [
    watchClaudeModPaneRosters(client, onRoster),
    usePanelLayoutStore.subscribe((state) => {
      if (state.layouts === previousLayouts) return;
      previousLayouts = state.layouts;
      scheduleSweep();
    }),
  ];
  return (): void => {
    stopped = true;
    pendingSweep = false;
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const cancel of turnWaits.values()) cancel();
    turnWaits.clear();
  };
}
