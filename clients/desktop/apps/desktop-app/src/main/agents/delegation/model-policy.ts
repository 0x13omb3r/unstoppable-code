import {
  evaluateManagedDelegationModelPolicy,
  managedDelegationBillingGroup,
  managedDelegationBillingKind,
  managedDelegationModelPolicyRefusal,
  MANAGED_DELEGATION_MODEL_POLICY_SETTINGS_LOCATION,
  managedDelegationRouteKey,
  normalizeManagedDelegationModelPolicy,
  FAIL_CLOSED_MANAGED_DELEGATION_MODEL_POLICY,
  type ManagedDelegationBillingKind,
  type ManagedDelegationModelPolicy,
  type ManagedDelegationPolicyBillingGroup,
  type ManagedDelegationPolicyCatalog,
  type ManagedDelegationPolicyModel,
  type ManagedDelegationPolicyRoute,
  type ManagedDelegationRouteAvailability,
} from '@canopy/protocol/delegation/model-policy';
import type { ResolvedAgentRouteSnapshot } from '@canopy/desktop-shared/node/delegation';
import { getManagedModelVendor } from '@canopy/desktop-shared/lib/managed-model-vendor';
import {
  getAiGatewayModelEntry,
  getCanonicalPickerModel,
  getExecutionHarnessForModel,
  isAgentModel,
  resolveRuntimeModel,
} from '@canopy/desktop-shared/types';
import { getModelFamilyMetadata } from '@canopy/desktop-shared/model-config';
import { resolveGatewayModelEntry } from '@canopy/execution-engine/lib/gateway-model-availability';
import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import { peekCursorAccount } from '../../cursor/connection';
import { peekFreshProviderNativeAuthAvailability } from '../../auth/provider-auth-state';
import { readPreferencesFileDetailed } from '../../lib/preferences-store';
import {
  listAuthoritativeConfiguredModels,
  type AuthoritativeConfiguredModel,
} from '../../lib/model-config';

/**
 * Cursor picks the concrete model for this choice, so it can't be held to a
 * Selected models allowlist. Shortcut: the only known auto alias today; move
 * to a registry flag when another provider adds one.
 */
const AUTO_MODEL_IDS: readonly string[] = ['cursor-default'];
const AUTO_MODEL_REASON =
  'The provider chooses the model, so it can’t be limited to selected models.';

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
};
const ACCOUNT_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude account',
  codex: 'ChatGPT account',
  cursor: 'Cursor account',
  copilot: 'GitHub account',
};

function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness] ?? harness;
}

function billingLabel(
  harness: string,
  billing: ManagedDelegationBillingKind,
): string {
  switch (billing) {
    case 'ai-credits':
      return 'AI Credits';
    case 'org-gateway':
      return 'Organization gateway';
    case 'api-key':
      return 'API key';
    default:
      return ACCOUNT_LABELS[harness] ?? 'Provider account';
  }
}

function parseBillingKind(value: string): ManagedDelegationBillingKind {
  return value === 'ai-credits' ||
    value === 'org-gateway' ||
    value === 'api-key'
    ? value
    : 'account';
}

export function managedDelegationRouteLabel(routeKey: string): string {
  const split = routeKey.lastIndexOf(':');
  const harness = routeKey.slice(0, split);
  const billing = parseBillingKind(routeKey.slice(split + 1));
  return `${harnessLabel(harness)} · ${billingLabel(harness, billing)}`;
}

function billingGroupFor(groupId: string): ManagedDelegationPolicyBillingGroup {
  if (groupId === 'ai-credits')
    return {
      id: groupId,
      label: 'AI Credits',
      description: 'Uses AI Credits across supported providers',
    };
  if (groupId === 'org-gateway')
    return {
      id: groupId,
      label: 'Organization gateway',
      description: 'Uses your organization’s AI gateway',
    };
  const harness = groupId.slice(0, groupId.lastIndexOf(':'));
  return {
    id: groupId,
    label: managedDelegationRouteLabel(groupId),
    description: groupId.endsWith(':api-key')
      ? `Uses an API key from your environment with ${harnessLabel(harness)}`
      : `Uses your signed-in ${ACCOUNT_LABELS[harness] ?? 'provider account'}`,
  };
}

function gatewayBilling(modelId: string): ManagedDelegationBillingKind | null {
  const entry = resolveGatewayModelEntry(modelId);
  if (!entry) return null;
  return entry.origin === 'org-gateway' ? 'org-gateway' : 'ai-credits';
}

/**
 * Billing kinds a model can be routed through on this device, from catalog
 * facts only. Never probes a provider or allocates a billing route.
 */
/**
 * The harness a delegate of this model runs on: the user's saved harness
 * assignment when there is one, the same resolution route capture uses.
 */
function effectiveHarness(model: AuthoritativeConfiguredModel): string {
  return getExecutionHarnessForModel(model.id) ?? model.defaultHarness;
}

function routeBillingKinds(
  model: AuthoritativeConfiguredModel,
): readonly ManagedDelegationBillingKind[] {
  const harness = effectiveHarness(model);
  const gateway = gatewayBilling(model.id);
  // A native OpenCode model runs on the user's own OpenCode providers, which
  // the route runtime captures as `native`; only gateway IDs are hosted.
  if (harness === 'opencode')
    return gateway && !getRawOpenCodeModelId(model.id)
      ? [gateway]
      : ['account'];
  if (harness !== 'claude' && harness !== 'codex') return ['account'];
  const kinds: ManagedDelegationBillingKind[] = [];
  if (model.modelSource !== 'ai-gateway') kinds.push('account');
  if (gateway) kinds.push(gateway);
  // Shortcut: only a key in the app's own environment is listed; a key set
  // only in a workspace environment is still enforced (it fails closed in
  // Selected models until listed here).
  if (
    harness === 'claude' &&
    (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  )
    kinds.push('api-key');
  return kinds;
}

/** Route keys the catalog knows for a runtime model; empty if unknown. */
export function managedDelegationRouteKeys(modelId: string): string[] {
  const model = listAuthoritativeConfiguredModels().find(
    (entry) => entry.id === modelId,
  );
  return model
    ? routeBillingKinds(model).map((billing) =>
        managedDelegationRouteKey(effectiveHarness(model), billing),
      )
    : [];
}

/**
 * Every route key route capture could record, for advisory checks that must
 * never refuse a route the exact captured-route check would admit: the
 * catalog's keys, plus a Claude API key set only in a workspace environment,
 * and an organization gateway an owner-scoped alias can route an OpenCode
 * gateway model to. Neither is visible to the device-level catalog.
 */
function possibleRouteKeys(modelId: string): string[] {
  const keys = managedDelegationRouteKeys(modelId);
  const extra: string[] = [];
  if (keys.some((key) => key.startsWith('claude:')))
    extra.push(managedDelegationRouteKey('claude', 'api-key'));
  if (keys.includes(managedDelegationRouteKey('opencode', 'ai-credits')))
    extra.push(managedDelegationRouteKey('opencode', 'org-gateway'));
  return [...keys, ...extra.filter((key) => !keys.includes(key))];
}

interface RouteState {
  readonly availability: ManagedDelegationRouteAvailability;
  readonly reason?: string;
}

function accountAvailability(harness: string): RouteState {
  if (harness === 'claude' || harness === 'codex') {
    const signedIn = peekFreshProviderNativeAuthAvailability()[harness];
    if (signedIn === true) return { availability: 'available' };
    if (signedIn === false)
      return {
        availability: 'unavailable',
        reason: `Not connected. Sign in to ${harnessLabel(harness)}; your choice is kept.`,
      };
  }
  if (harness === 'cursor') {
    const account = peekCursorAccount();
    if (account) return { availability: 'available' };
    if (account === null)
      return {
        availability: 'unavailable',
        reason: 'Not connected. Sign in to Cursor; your choice is kept.',
      };
  }
  return {
    availability: 'unknown',
    reason: 'Availability is checked when a subagent starts.',
  };
}

function vendorFor(model: AuthoritativeConfiguredModel): string | undefined {
  const managed = getManagedModelVendor(model.id);
  if (managed) return managed;
  if (model.modelSource === 'ai-gateway') return undefined;
  return model.defaultHarness === 'claude'
    ? 'Anthropic'
    : model.defaultHarness === 'codex'
      ? 'OpenAI'
      : undefined;
}

/** The family the model picker groups this model under, if declared. */
function familyFor(
  modelId: string,
): ManagedDelegationPolicyModel['family'] | undefined {
  const canonical = getCanonicalPickerModel(modelId);
  const declared = getModelFamilyMetadata(canonical);
  if (declared) return { id: declared.family, label: declared.familyLabel };
  const gateway = getAiGatewayModelEntry(canonical);
  return gateway?.family && gateway.familyLabel
    ? { id: gateway.family, label: gateway.familyLabel }
    : undefined;
}

/** Side-effect free: reads the cached registry and cached auth state only. */
export function buildManagedDelegationPolicyCatalog(): ManagedDelegationPolicyCatalog {
  const groups = new Map<string, ManagedDelegationPolicyBillingGroup>();
  const models: ManagedDelegationPolicyModel[] = [];
  for (const model of listAuthoritativeConfiguredModels()) {
    if (!model.selectable && model.enabled) continue;
    const harness = effectiveHarness(model);
    const routes = routeBillingKinds(model).map(
      (billing): ManagedDelegationPolicyRoute => {
        const key = managedDelegationRouteKey(harness, billing);
        const billingGroup = managedDelegationBillingGroup(key);
        if (!groups.has(billingGroup))
          groups.set(billingGroup, billingGroupFor(billingGroup));
        // An API-key route is listed only when the key is present.
        const state: RouteState =
          billing === 'account'
            ? accountAvailability(harness)
            : billing === 'api-key'
              ? { availability: 'available' }
              : {
                  availability: 'unknown',
                  reason:
                    'Billing availability is checked when a subagent starts.',
                };
        return {
          key,
          billingGroup,
          label: managedDelegationRouteLabel(key),
          ...state,
        };
      },
    );
    const vendor = vendorFor(model);
    const family = familyFor(model.id);
    models.push({
      modelId: model.id,
      label: model.label,
      ...(vendor ? { vendor } : {}),
      ...(family ? { family } : {}),
      provider: { id: harness, label: harnessLabel(harness) },
      routes,
      ...(!model.enabled
        ? { unavailableReason: 'This model is disabled.' }
        : AUTO_MODEL_IDS.includes(model.id)
          ? { unavailableReason: AUTO_MODEL_REASON }
          : {}),
    });
  }
  return { models, billingGroups: Array.from(groups.values()) };
}

export async function readManagedDelegationModelPolicy(): Promise<
  ManagedDelegationModelPolicy | undefined
> {
  // Unreadable preferences fail closed; only absent ones mean the legacy
  // All models default.
  const read = await readPreferencesFileDetailed();
  if (read.authority === 'unreadable')
    return FAIL_CLOSED_MANAGED_DELEGATION_MODEL_POLICY;
  return normalizeManagedDelegationModelPolicy(
    read.preferences.managedDelegationModelPolicy,
  );
}

/** Advisory discovery: whether any known route of this model is allowed. */
export function managedDelegationModelPolicyDiscoveryReason(
  policy: ManagedDelegationModelPolicy | undefined,
  runtimeModelId: string,
): string | undefined {
  if (!policy) return undefined;
  if (policy.mode === 'selected' && AUTO_MODEL_IDS.includes(runtimeModelId))
    return AUTO_MODEL_REASON;
  const allowed = possibleRouteKeys(runtimeModelId).some(
    (key) =>
      evaluateManagedDelegationModelPolicy(policy, runtimeModelId, key).allowed,
  );
  return allowed
    ? undefined
    : `Not allowed in Settings → Labs → Managed delegation → Allowed models.`;
}

/**
 * Before route allocation: refuses a model none of whose known routes the
 * policy allows. An Agent is judged by its base model when that resolves
 * without I/O; anything the catalog doesn't know is left to the exact
 * captured-route check, which always runs afterwards.
 */
export function managedDelegationModelPolicyPrecheck(
  policy: ManagedDelegationModelPolicy | undefined,
  modelId: string,
): string | undefined {
  if (!policy) return undefined;
  const runtimeModelId = isAgentModel(modelId)
    ? resolveRuntimeModel(modelId)
    : modelId;
  if (!runtimeModelId) return undefined;
  const model = listAuthoritativeConfiguredModels().find(
    (entry) => entry.id === runtimeModelId,
  );
  if (!model) return undefined;
  return managedDelegationModelPolicyDiscoveryReason(policy, runtimeModelId)
    ? `${model.label} has no allowed provider or billing option for subagents. Change this in ${MANAGED_DELEGATION_MODEL_POLICY_SETTINGS_LOCATION}.`
    : undefined;
}

/**
 * Funding of the invocation actually resolved: an organization gateway
 * substituted at routing time is reported by the router, never inferred from
 * the requested model's catalog entry.
 */
function capturedBillingKind(
  route: ResolvedAgentRouteSnapshot,
  orgGatewayRouted: boolean,
): ManagedDelegationBillingKind {
  return orgGatewayRouted
    ? 'org-gateway'
    : managedDelegationBillingKind(route.billingAuthority);
}

/**
 * Admission check against the exact captured route. Runs once per new
 * invocation (spawn, follow-up, resume), so a policy change never stops a
 * running turn but applies to its next one. Returns the refusal, if any.
 */
export function managedDelegationModelPolicyRefusalFor(
  policy: ManagedDelegationModelPolicy | undefined,
  route: ResolvedAgentRouteSnapshot,
  orgGatewayRouted: boolean,
): string | undefined {
  if (!policy) return undefined;
  const modelLabel = route.runtimeModelLabel ?? route.runtimeModelId;
  if (
    policy.mode === 'selected' &&
    AUTO_MODEL_IDS.includes(route.runtimeModelId)
  )
    return managedDelegationModelPolicyRefusal(
      'model_not_selected',
      modelLabel,
      '',
    );
  const key = managedDelegationRouteKey(
    route.harnessId,
    capturedBillingKind(route, orgGatewayRouted),
  );
  const decision = evaluateManagedDelegationModelPolicy(
    policy,
    route.runtimeModelId,
    key,
  );
  return decision.allowed
    ? undefined
    : managedDelegationModelPolicyRefusal(
        decision.reason,
        modelLabel,
        managedDelegationRouteLabel(key),
      );
}
