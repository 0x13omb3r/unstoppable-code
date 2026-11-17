import type { ResourceContextDecision } from '@canopy/execution-engine/lib/resource-context-policy';

/**
 * Waits between asks while a watcher's authorization can't be checked yet,
 * such as an inventory mid-write after a restart (CAN-6900). Bounded: once
 * spent, the last refusal is reported.
 */
export const WATCHER_AUTHORIZATION_RETRY_DELAYS_MS = [250, 500, 1_000];

export async function retryTransientAuthorization(
  decide: () => Promise<ResourceContextDecision>,
  sleep: (ms: number) => Promise<void>,
): Promise<ResourceContextDecision> {
  let authorization = await decide();
  for (const delay of WATCHER_AUTHORIZATION_RETRY_DELAYS_MS) {
    if (authorization.allow || !authorization.transient) return authorization;
    await sleep(delay);
    authorization = await decide();
  }
  // Still damaged after the budget: not a write in progress, so it stands.
  if (!authorization.allow && authorization.reason === 'plugin-catalog-damaged')
    return { allow: false, reason: 'plugin-catalog-damaged' };
  return authorization;
}
