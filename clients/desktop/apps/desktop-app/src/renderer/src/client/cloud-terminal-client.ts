import type { TerminalClient } from '@canopy/app-core';
import {
  createDurableTerminalClient,
  createScopedTerminalClient,
} from '@canopy/app-state/core-cowork';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';
import { getTerminalPanelBindings } from '@/lib/panels/terminal-panel-activation';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import { webCorePanelLayouts } from '@/lib/panels/panel-layout-storage';
import { createCloudTerminalRecordStore } from './cloud-terminal-records';
import { isWebCoreScope, webCoreLocalId } from '@/lib/chat-authority';

/**
 * Cloud terminals per window. Each holds one relay stream of the relay's 16,
 * which cloud chats use up to 10 of (one task stream, eight chat streams and
 * one live stream).
 */
const MAX_CLOUD_TERMINALS = 4;
/** As `DurablePtyClient` keeps reading after a kill for the exit it causes. */
const KILL_DRAIN_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The terminal ids a saved panel layout's terminal tabs bind. */
function savedTerminalBindings(layout: unknown, depth = 0): string[] {
  if (depth > 32) return [];
  if (Array.isArray(layout))
    return layout.flatMap((item) => savedTerminalBindings(item, depth + 1));
  if (!isRecord(layout)) return [];
  const { instance } = layout;
  const own =
    layout.kind === 'terminal' &&
    isRecord(instance) &&
    typeof instance.terminalId === 'string'
      ? [instance.terminalId]
      : [];
  return [
    ...own,
    ...Object.values(layout).flatMap((value) =>
      savedTerminalBindings(value, depth + 1),
    ),
  ];
}

/**
 * The desktop's terminal client with cloud chat terminals (CAN-6175 R10):
 * local work entries keep `local`; a cloud chat's terminals run as durable
 * shells in its sandbox over the web core relay. `dispose` kills them.
 */
export function createDesktopCloudTerminalClient(local: TerminalClient): {
  readonly client: TerminalClient;
  readonly dispose: () => void;
} {
  const lifetime = new AbortController();
  const connection = {
    invoker: createRelayCoreCoworkInvoker(window.canopyCore),
    signal: lifetime.signal,
  };
  const cloud = createDurableTerminalClient({
    connection: () => (lifetime.signal.aborted ? undefined : connection),
    chatIdOf: webCoreLocalId,
    maxTerminals: MAX_CLOUD_TERMINALS,
    records: createCloudTerminalRecordStore(),
    boundTerminalIds: (projectId, worktreeId) => [
      ...new Set([
        ...getTerminalPanelBindings(
          makeWorktreePanelKey(projectId, worktreeId),
        ),
        // Saved: hydration can run before the saved layout is restored.
        ...savedTerminalBindings(
          webCorePanelLayouts.loadLayout({ projectId, worktreeId }).layout,
        ),
      ]),
    ],
  });
  return {
    client: createScopedTerminalClient({
      local,
      cloud,
      isCloudScope: isWebCoreScope,
    }),
    dispose: (): void => {
      cloud.dispose();
      // The kills go out on this connection; end it once they have drained.
      setTimeout(() => lifetime.abort(), KILL_DRAIN_MS);
    },
  };
}
