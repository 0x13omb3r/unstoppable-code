import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  isWebCoreCoworkOnline,
  subscribeWebCoreCoworkDirectory,
} from '@/lib/cowork-directory';

/**
 * This window's web core connection as the relay's `describe` reads it: the
 * account `core.runtime.initialize` named (CAN-6828) and the minor schema
 * revisions the connection's manifest advertises (CAN-6841). It is the one
 * reader of `describe`: a send's account binding and the sandbox states
 * snapshots carry both follow it.
 *
 * Null until the connection is described, while the cloud is offline, and
 * when `describe` fails or answers something else: a caller then assumes
 * nothing the description would have told it.
 */
export interface WebCoreDescription {
  readonly principalId: string | null;
  readonly schemaRevisions: Readonly<Record<string, number>>;
}

let description: WebCoreDescription | null = null;
let generation = 0;
let following = false;
const listeners = new Set<() => void>();

function isDescription(value: unknown): value is WebCoreDescription {
  if (typeof value !== 'object' || value === null) return false;
  const principalId: unknown = Reflect.get(value, 'principalId');
  const revisions: unknown = Reflect.get(value, 'schemaRevisions');
  return (
    (principalId === null || typeof principalId === 'string') &&
    typeof revisions === 'object' &&
    revisions !== null
  );
}

function settle(next: WebCoreDescription | null): void {
  if (next === description) return;
  description = next;
  for (const listener of [...listeners]) listener();
}

async function describeConnection(): Promise<void> {
  const relay = typeof window === 'undefined' ? undefined : window.canopyCore;
  if (relay === undefined) return;
  const asked = ++generation;
  const reply = await relay.invoke({ kind: 'describe', authority: 'web-core' });
  if (asked !== generation || !isWebCoreCoworkOnline()) return;
  settle(reply.ok && isDescription(reply.value) ? reply.value : null);
}

function refresh(): void {
  if (!isWebCoreCoworkOnline()) {
    generation += 1;
    settle(null);
    return;
  }
  void describeConnection().catch((error: unknown) => {
    // Undescribed until the connection is described again.
    settle(null);
    reportClientAppError(error);
  });
}

/** Follows the cloud connection; idempotent. */
export function followWebCoreDescription(): void {
  if (following) return;
  following = true;
  let online = isWebCoreCoworkOnline();
  subscribeWebCoreCoworkDirectory(() => {
    const now = isWebCoreCoworkOnline();
    if (now === online) return;
    online = now;
    refresh();
  });
  refresh();
}

/** The connection as last described, or null; see `WebCoreDescription`. */
export function webCoreDescription(): WebCoreDescription | null {
  followWebCoreDescription();
  return description;
}

/**
 * Whether the described connection advertises `method` at `revision` or
 * later; false while it is undescribed.
 */
export function webCoreAdvertises(method: string, revision: number): boolean {
  const advertised: unknown =
    webCoreDescription()?.schemaRevisions[method] ?? undefined;
  return typeof advertised === 'number' && advertised >= revision;
}

/** Calls `listener` each time the description changes. */
export function subscribeWebCoreDescription(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test seam: forgets the description; the connection is described again the
 * next time the cloud comes online.
 */
export function resetWebCoreDescription(): void {
  generation += 1;
  settle(null);
}
