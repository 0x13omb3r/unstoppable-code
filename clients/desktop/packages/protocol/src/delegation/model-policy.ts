/**
 * Allowed models for managed delegation: a device-level policy that narrows
 * which model and billing route a managed delegate may start on. It grants no
 * access; it intersects every existing auth, organization and billing check.
 *
 * Identity: a model is its exact configured runtime model ID (an Agent is
 * evaluated by its resolved base model). A route key is `<harness>:<billing>`,
 * built only from non-secret catalog facts. Global billing groups address
 * every route that bills the same way, including routes added later.
 */

export type ManagedDelegationBillingKind =
  | 'account'
  | 'api-key'
  | 'ai-credits'
  | 'org-gateway';

export type ManagedDelegationModelPolicyMode = 'all' | 'selected';

export interface ManagedDelegationModelPolicy {
  readonly version: 1;
  readonly mode: ManagedDelegationModelPolicyMode;
  /** All models: billing groups switched off. Anything else is allowed. */
  readonly disabledBillingGroups: readonly string[];
  /** Selected models: active membership only. */
  readonly selectedModelIds: readonly string[];
  /**
   * Allowed route keys per model, kept for deselected models too so a
   * reselection restores the earlier choice. Never grants access by itself.
   */
  readonly modelRoutes: Readonly<Record<string, readonly string[]>>;
}

export const MANAGED_DELEGATION_MODEL_POLICY_LIMITS = Object.freeze({
  models: 4096,
  routesPerModel: 64,
  billingGroups: 256,
  idLength: 1024,
});

/** Policy that admits nothing; used when a saved policy cannot be read. */
export const FAIL_CLOSED_MANAGED_DELEGATION_MODEL_POLICY: ManagedDelegationModelPolicy =
  Object.freeze({
    version: 1,
    mode: 'selected',
    disabledBillingGroups: [],
    selectedModelIds: [],
    modelRoutes: {},
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedIds(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > MANAGED_DELEGATION_MODEL_POLICY_LIMITS.idLength
    )
      return undefined;
    if (!ids.includes(item)) ids.push(item);
  }
  return ids;
}

/**
 * `undefined` (no saved policy) is the legacy default: All models, every
 * route allowed. A present but malformed policy fails closed, so the user sees
 * "No models are allowed" and can repair it, instead of silently widening.
 */
export function normalizeManagedDelegationModelPolicy(
  value: unknown,
): ManagedDelegationModelPolicy | undefined {
  // Only an absent policy is the legacy default; an explicit null is malformed.
  if (value === undefined) return undefined;
  if (!isRecord(value)) return FAIL_CLOSED_MANAGED_DELEGATION_MODEL_POLICY;
  const record = value;
  const limits = MANAGED_DELEGATION_MODEL_POLICY_LIMITS;
  const disabled = boundedIds(
    record.disabledBillingGroups,
    limits.billingGroups,
  );
  const selected = boundedIds(record.selectedModelIds, limits.models);
  const routesValue = record.modelRoutes;
  if (
    record.version !== 1 ||
    (record.mode !== 'all' && record.mode !== 'selected') ||
    !disabled ||
    !selected ||
    !isRecord(routesValue)
  )
    return FAIL_CLOSED_MANAGED_DELEGATION_MODEL_POLICY;
  const entries = Object.entries(routesValue);
  if (entries.length > limits.models)
    return FAIL_CLOSED_MANAGED_DELEGATION_MODEL_POLICY;
  const modelRoutes: Record<string, readonly string[]> = {};
  for (const [modelId, routes] of entries) {
    const keys = boundedIds(routes, limits.routesPerModel);
    if (!keys || modelId.length === 0 || modelId.length > limits.idLength)
      return FAIL_CLOSED_MANAGED_DELEGATION_MODEL_POLICY;
    modelRoutes[modelId] = keys;
  }
  return {
    version: 1,
    mode: record.mode,
    disabledBillingGroups: disabled,
    selectedModelIds: selected,
    modelRoutes,
  };
}

/**
 * True when the policy survives normalization, so a settings surface can
 * refuse an edit instead of saving one that would read back fail-closed.
 */
export function managedDelegationModelPolicyFitsLimits(
  policy: ManagedDelegationModelPolicy,
): boolean {
  return (
    normalizeManagedDelegationModelPolicy(policy) !==
    FAIL_CLOSED_MANAGED_DELEGATION_MODEL_POLICY
  );
}

/** Maps a captured route's `billingAuthority` onto the policy's billing kinds. */
export function managedDelegationBillingKind(
  billingAuthority: string,
): ManagedDelegationBillingKind {
  switch (billingAuthority) {
    case 'ai-credits':
      return 'ai-credits';
    case 'org-gateway':
    case 'org_gateway':
    case 'organization-gateway':
    case 'model-gateway':
      return 'org-gateway';
    case 'user-credential':
      return 'api-key';
    // native, account-proxy (the user's own accounts) and the E2E mock.
    default:
      return 'account';
  }
}

export function managedDelegationRouteKey(
  harnessId: string,
  billing: ManagedDelegationBillingKind,
): string {
  return `${harnessId}:${billing}`;
}

/**
 * Hosted funding applies across harnesses, so one switch covers every
 * current and future route funded that way. Provider-account and API-key
 * routes are grouped per harness.
 */
export function managedDelegationBillingGroup(routeKey: string): string {
  const billing = routeKey.slice(routeKey.lastIndexOf(':') + 1);
  return billing === 'ai-credits' || billing === 'org-gateway'
    ? billing
    : routeKey;
}

export type ManagedDelegationModelPolicyDenial =
  | 'model_not_selected'
  | 'route_not_allowed'
  | 'billing_disabled';

export type ManagedDelegationModelPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: ManagedDelegationModelPolicyDenial;
    };

export function evaluateManagedDelegationModelPolicy(
  policy: ManagedDelegationModelPolicy | undefined,
  modelId: string,
  routeKey: string,
): ManagedDelegationModelPolicyDecision {
  if (!policy) return { allowed: true };
  if (policy.mode === 'all')
    return policy.disabledBillingGroups.includes(
      managedDelegationBillingGroup(routeKey),
    )
      ? { allowed: false, reason: 'billing_disabled' }
      : { allowed: true };
  if (!policy.selectedModelIds.includes(modelId))
    return { allowed: false, reason: 'model_not_selected' };
  return policy.modelRoutes[modelId]?.includes(routeKey) === true
    ? { allowed: true }
    : { allowed: false, reason: 'route_not_allowed' };
}

/** True when at least one of the given routes passes the policy. */
export function managedDelegationModelHasAllowedRoute(
  policy: ManagedDelegationModelPolicy | undefined,
  modelId: string,
  routeKeys: readonly string[],
): boolean {
  return routeKeys.some(
    (key) => evaluateManagedDelegationModelPolicy(policy, modelId, key).allowed,
  );
}

/**
 * Route keys a newly selected model starts with: its known routes that the
 * saved All models choices permit. Remembered choices win when present.
 */
export function initialManagedDelegationModelRoutes(
  policy: ManagedDelegationModelPolicy | undefined,
  modelId: string,
  routeKeys: readonly string[],
): readonly string[] {
  const remembered = policy?.modelRoutes[modelId];
  if (remembered) return remembered;
  const disabled = policy?.disabledBillingGroups ?? [];
  return routeKeys.filter(
    (key) => !disabled.includes(managedDelegationBillingGroup(key)),
  );
}

export const MANAGED_DELEGATION_MODEL_POLICY_SETTINGS_LOCATION =
  'Settings → Labs → Managed delegation → Allowed models';

export function managedDelegationModelPolicyRefusal(
  reason: ManagedDelegationModelPolicyDenial,
  modelLabel: string,
  routeLabel: string,
): string {
  const subject =
    reason === 'model_not_selected'
      ? `${modelLabel} is not an allowed model`
      : `${modelLabel} through ${routeLabel} is not allowed`;
  return `${subject} for subagents. Change this in ${MANAGED_DELEGATION_MODEL_POLICY_SETTINGS_LOCATION}.`;
}

/** Settings catalog: one row per exact model, with its known routes. */
export type ManagedDelegationRouteAvailability =
  | 'available'
  | 'unavailable'
  | 'unknown';

export interface ManagedDelegationPolicyRoute {
  readonly key: string;
  readonly billingGroup: string;
  readonly label: string;
  readonly availability: ManagedDelegationRouteAvailability;
  readonly reason?: string;
}

export interface ManagedDelegationPolicyModel {
  readonly modelId: string;
  readonly label: string;
  /** Model author or vendor, when the catalog knows it. */
  readonly vendor?: string;
  /** Model family for filtering, when the catalog declares one. */
  readonly family?: { readonly id: string; readonly label: string };
  /** The provider (harness) the model runs on, for filtering. */
  readonly provider?: { readonly id: string; readonly label: string };
  readonly routes: readonly ManagedDelegationPolicyRoute[];
  /** Set when the model itself cannot run, such as a disabled model. */
  readonly unavailableReason?: string;
}

export interface ManagedDelegationPolicyBillingGroup {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ManagedDelegationPolicyCatalog {
  readonly models: readonly ManagedDelegationPolicyModel[];
  readonly billingGroups: readonly ManagedDelegationPolicyBillingGroup[];
}

export type ManagedDelegationPolicyCatalogResult =
  | { readonly ok: true; readonly catalog: ManagedDelegationPolicyCatalog }
  | { readonly ok: false; readonly error: string };
