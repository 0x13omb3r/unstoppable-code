import type { AgentDelegationResult } from './index';

export type ManagedDelegationSurface =
  | 'worktree-chat'
  | 'cowork-chat'
  | 'app-advisor-chat';

export type ManagedDelegationChildProfile =
  | 'managed-delegate'
  | 'managed-delegate-cowork'
  | 'managed-delegate-app-advisor';

export interface ManagedDelegationSurfacePolicy {
  readonly childProfile: ManagedDelegationChildProfile;
  readonly allowWorktree: boolean;
  readonly allowGitObservation: boolean;
}

const MANAGED_DELEGATION_SURFACE_POLICIES: Readonly<
  Record<ManagedDelegationSurface, ManagedDelegationSurfacePolicy>
> = Object.freeze({
  'worktree-chat': Object.freeze({
    childProfile: 'managed-delegate',
    allowWorktree: true,
    allowGitObservation: true,
  } satisfies ManagedDelegationSurfacePolicy),
  'cowork-chat': Object.freeze({
    childProfile: 'managed-delegate-cowork',
    allowWorktree: false,
    allowGitObservation: false,
  } satisfies ManagedDelegationSurfacePolicy),
  'app-advisor-chat': Object.freeze({
    childProfile: 'managed-delegate-app-advisor',
    allowWorktree: false,
    allowGitObservation: false,
  } satisfies ManagedDelegationSurfacePolicy),
});

export function getManagedDelegationSurfacePolicy(
  surface: ManagedDelegationSurface,
): ManagedDelegationSurfacePolicy {
  return MANAGED_DELEGATION_SURFACE_POLICIES[surface];
}

/** Remove only the Code-only worktree capability on non-Code surfaces. */
export function filterManagedDelegationCapabilities<T extends string>(
  surface: ManagedDelegationSurface,
  capabilities: readonly T[],
): T[] {
  return getManagedDelegationSurfacePolicy(surface).allowWorktree
    ? [...capabilities]
    : capabilities.filter((capability) => capability !== 'worktree');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/**
 * Enforce a managed surface's isolation policy before caller-supplied values
 * are bound to a provider request. Other validation remains parser-owned.
 */
export function validateManagedDelegationSurfaceIsolation(
  surface: ManagedDelegationSurface,
  input: unknown,
): AgentDelegationResult<void> {
  if (
    !getManagedDelegationSurfacePolicy(surface).allowWorktree &&
    isRecord(input) &&
    input.isolation === 'worktree'
  )
    return {
      ok: false,
      error: {
        code: 'capability_unavailable',
        message:
          'This delegation surface supports only a shared working folder; isolated worktrees are unavailable.',
        retryable: false,
      },
    };

  return { ok: true, value: undefined };
}
