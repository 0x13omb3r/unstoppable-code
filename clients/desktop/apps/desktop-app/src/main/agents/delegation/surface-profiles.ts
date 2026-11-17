import type { ManagedDelegationSurface } from '@canopy/protocol/delegation';

interface ManagedDelegationSurfaceProfile {
  readonly enabled: boolean;
}

/**
 * Product enablement stays independent of persisted workspace classification.
 * Only Code (worktree-chat) is enabled. The phase that enables Cowork or
 * Advisor also resolves each root's surface from its canonical workspace
 * identity and wires that into the broker.
 */
const MANAGED_DELEGATION_SURFACE_PROFILES: Readonly<
  Record<ManagedDelegationSurface, ManagedDelegationSurfaceProfile>
> = Object.freeze({
  'worktree-chat': Object.freeze({ enabled: true }),
  'cowork-chat': Object.freeze({ enabled: false }),
  'app-advisor-chat': Object.freeze({ enabled: false }),
});

export function isManagedDelegationSurfaceEnabled(
  surface: ManagedDelegationSurface,
): boolean {
  return MANAGED_DELEGATION_SURFACE_PROFILES[surface].enabled;
}
