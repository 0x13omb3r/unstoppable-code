import type { ClaudeModSurfaceRelayEvent } from '@canopy/protocol/extension-ui';
import {
  capturePortalEmissionContext,
  createPortalEvent,
  enqueuePortalEventIfCurrent,
  type PortalEmissionContext,
} from './portal-event-bus';

/**
 * Relays Claude chats' Mod surfaces to the paired web Portal as
 * `portal.claude_mods.surface` events. The server stores every event, so
 * within a short window a chat's roster and each site's tree, scroll and
 * focus keep only their latest update, in the place their first one took,
 * except that rosters go first, so a roster arrives before the trees of the
 * panes it lists. Toasts, status lines and log lines all go, in order. Each
 * update goes only to the Portal session it was queued for: one that ends
 * meanwhile gets nothing more.
 */
const RELAY_DELAY_MS = 250;
const SEPARATOR = '\u0000';
// shortcut: a CLI tree is relayed unvalidated, so one past this many UTF-8
// bytes goes as an empty site rather than overflow the Portal's 1 MiB event
// batch; trim it to the validator's node budget if real Mods draw that much.
const TREE_MAX_BYTES = 512 * 1024;

interface Queued {
  readonly event: ClaudeModSurfaceRelayEvent;
  readonly context: PortalEmissionContext;
}

const queued = new Map<string, Queued>();
let timer: ReturnType<typeof setTimeout> | null = null;
let sequence = 0;

function latestOnlyKey(event: ClaudeModSurfaceRelayEvent): string | null {
  const chat = [event.projectId, event.worktreeId, event.chatId];
  const { push } = event;
  switch (push.kind) {
    case 'panes':
      return [...chat, push.kind].join(SEPARATOR);
    case 'tree':
    case 'scroll':
    case 'focus':
      return [...chat, push.kind, push.site, push.instanceId].join(SEPARATOR);
    default:
      return null;
  }
}

function flush(): void {
  timer = null;
  // Rosters first: a tree whose slot an earlier update took (a resend queues
  // its roster after it) would otherwise reach the Portal before the roster
  // that lists its pane, and be dropped.
  const entries = [...queued.values()].sort(
    (a, b) =>
      Number(b.event.push.kind === 'panes') -
      Number(a.event.push.kind === 'panes'),
  );
  queued.clear();
  for (const { event, context } of entries) {
    enqueuePortalEventIfCurrent(
      context,
      createPortalEvent('portal.claude_mods.surface', event),
    );
  }
}

/** Queues one update for the Portal; nothing while no browser can receive it. */
export function relayClaudeModSurfaceUpdate(
  update: ClaudeModSurfaceRelayEvent,
): void {
  const context = capturePortalEmissionContext();
  if (context === undefined) return;
  const event =
    update.push.kind === 'tree' &&
    Buffer.byteLength(JSON.stringify(update.push.tree) ?? '', 'utf8') >
      TREE_MAX_BYTES
      ? { ...update, push: { ...update.push, tree: null } }
      : update;
  sequence += 1;
  const key = latestOnlyKey(event) ?? `once${SEPARATOR}${String(sequence)}`;
  const earlier = queued.get(key);
  // A surface that ended in this window ended, whatever roster follows it.
  queued.set(key, {
    context,
    event:
      earlier?.context.generation === context.generation &&
      earlier.event.push.kind === 'panes' &&
      earlier.event.push.reset === true &&
      event.push.kind === 'panes'
        ? { ...event, push: { ...event.push, reset: true } }
        : event,
  });
  timer ??= setTimeout(flush, RELAY_DELAY_MS);
}
