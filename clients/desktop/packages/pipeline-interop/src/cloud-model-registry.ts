import {
  AI_GATEWAY_CUSTOM_MODEL_FAMILY,
  isAiGatewayModelFamily,
  isAiGatewayThinkingLevel,
  type AiGatewayThinkingLevel,
} from '@canopy/protocol/ai-gateway-models';
import {
  WorkerPipelineModelCatalogSchema,
  type CloudModelHarness,
  type CloudModelOption,
  type WorkerPipelineHostLaunch,
} from '@canopy/protocol/canopy-core';
import {
  CLOUD_DEFAULT_STEP_MODEL,
  CLOUD_NATIVE_MODEL_ALIASES,
  CLOUD_NATIVE_MODEL_GATEWAY_IDS,
  CLOUD_NATIVE_MODEL_HARNESSES,
  cloudModelGatewayIdOf,
  type CloudModelContext,
} from './cloud-model-preflight';
import { CLOUD_RUN_REPOSITORY_MODEL_INPUTS } from './cloud-preflight';
import { STATIC_MODEL_REFERENCE_ALIASES } from './static-model-reference-aliases';

/*
 * A cloud run's model registry snapshot (CAN-6747): the `modelCatalog` its
 * portable start carries, which the pipeline host resolves the run's model
 * steps against (CAN-5095). Without it the host refuses every run with a
 * model step.
 *
 * It is what desktop's `buildModelRegistrySnapshot` sends for the same
 * models, built from the run owner's cloud catalog with its model policy
 * applied, as cloud model preflight and the run's model routes read it:
 *
 * - A catalog model a desktop model pins (`CLOUD_NATIVE_MODEL_GATEWAY_IDS`,
 *   on the harness its package section names) is listed as that desktop
 *   model, with a gateway route to the catalog id, and desktop's aliases of
 *   it. Its catalog id is an alias of it too: a replacement the user
 *   confirmed names the catalog id, and runs as the desktop model it is.
 * - Any other catalog model is an AI Gateway model under its catalog id, as
 *   cloud preflight and routes name it. When it is one a desktop model pins
 *   on another harness, that desktop model and desktop's aliases of it are
 *   aliases of it: preflight and routes map them to the catalog id.
 * - Each model's harness is the catalog's, never overridden: the run's
 *   routes are issued only on it.
 * - A model the owner's policy blocks is left out, as desktop leaves out
 *   what an enforcing organization's policy filters.
 *
 * The snapshot stays within `WORKER_PIPELINE_MODEL_CATALOG_MAX_BYTES`, and
 * each of its values within `CLOUD_RUN_MODEL_REGISTRY_VALUE_MAX_BYTES`: the
 * step runner gives every action subprocess the values as environment
 * variables, and Linux refuses to start a process with one longer than
 * 128 KiB. A catalog too large for either keeps the models the run's
 * definition names (and the defaults its steps run) first, then the rest in
 * catalog order while they fit.
 */

/**
 * The most one snapshot value may hold, in UTF-8 bytes: under Linux's
 * 128 KiB limit for one environment entry (`MAX_ARG_STRLEN`), with room for
 * its branded name.
 */
export const CLOUD_RUN_MODEL_REGISTRY_VALUE_MAX_BYTES = 120 * 1024;

/** A launch's model registry snapshot. */
export type CloudRunModelRegistry = NonNullable<
  WorkerPipelineHostLaunch['modelCatalog']
>;

/** What the cloud catalog knows of a model besides its id and harness. */
export interface CloudModelDetails {
  /** Its context window in tokens. */
  readonly contextWindow?: number;
  /** The thinking levels it takes; unknown levels are dropped. */
  readonly thinkingLevels?: readonly string[];
  /** Its AI Gateway family key. */
  readonly family?: string;
}

/** One catalog model and the desktop models it is. */
interface Listed {
  readonly option: CloudModelOption;
  /** The desktop models it is, on the catalog's harness. */
  readonly natives: readonly string[];
  /** The desktop models that pin it on another harness: aliases of it. */
  readonly aliased: readonly string[];
}

/** Every string in a parsed definition, its model names among them. */
function stringsOf(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 64) return;
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value))
    for (const entry of value) stringsOf(entry, into, depth + 1);
  else if (typeof value === 'object' && value !== null)
    for (const entry of Object.values(value)) stringsOf(entry, into, depth + 1);
}

/** The catalog ids `definition` may run: what it names and the step defaults. */
function namedModelIds(definition: unknown): Set<string> {
  const strings = new Set<string>([
    CLOUD_DEFAULT_STEP_MODEL,
    ...Object.values(CLOUD_RUN_REPOSITORY_MODEL_INPUTS).map(
      (input) => input.runnerDefault,
    ),
  ]);
  stringsOf(definition, strings);
  const ids = new Set<string>();
  for (const value of strings) {
    const trimmed = value.trim();
    const model = Object.prototype.hasOwnProperty.call(
      STATIC_MODEL_REFERENCE_ALIASES,
      trimmed,
    )
      ? (STATIC_MODEL_REFERENCE_ALIASES[trimmed] ?? trimmed)
      : trimmed;
    ids.add(cloudModelGatewayIdOf(model));
  }
  return ids;
}

/** A catalog model and the desktop models that pin it. */
function listedOf(option: CloudModelOption): Listed {
  const pinning = Object.keys(CLOUD_NATIVE_MODEL_GATEWAY_IDS).filter(
    (modelId) => CLOUD_NATIVE_MODEL_GATEWAY_IDS[modelId] === option.modelId,
  );
  const natives = pinning.filter(
    (modelId) => CLOUD_NATIVE_MODEL_HARNESSES[modelId] === option.harness,
  );
  return {
    option,
    natives,
    aliased: pinning.filter((modelId) => !natives.includes(modelId)),
  };
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

function familyOf(gatewayId: string, details?: CloudModelDetails): string {
  const family = details?.family;
  if (isAiGatewayModelFamily(family)) return family;
  const vendor = gatewayId.split('/')[0]?.toLowerCase();
  return gatewayId.includes('/') && isAiGatewayModelFamily(vendor)
    ? vendor
    : AI_GATEWAY_CUSTOM_MODEL_FAMILY;
}

function thinkingLevelsOf(
  details?: CloudModelDetails,
): AiGatewayThinkingLevel[] {
  return [
    ...new Set(
      (details?.thinkingLevels ?? []).filter((level) =>
        isAiGatewayThinkingLevel(level),
      ),
    ),
  ];
}

function sourceOf(
  harness: CloudModelHarness,
): 'claude-managed' | 'codex-managed' {
  return harness === 'claude' ? 'claude-managed' : 'codex-managed';
}

/** The snapshot listing `listed`, as `buildModelRegistrySnapshot` serializes it. */
function snapshotOf(
  listed: readonly Listed[],
  details: ReadonlyMap<string, CloudModelDetails>,
): CloudRunModelRegistry {
  const claudeModels: string[] = [];
  const codexModels: string[] = [];
  const aiGatewayModels: string[] = [];
  const gatewayRoutes: object[] = [];
  const assignments: object[] = [];
  const thinkingLevels: Record<string, AiGatewayThinkingLevel[]> = {};
  const modelAliases: Record<string, string> = {};
  /** Desktop models pinning a listed catalog model on another harness. */
  const aliasedTo = new Map<string, string>();
  for (const { option, natives, aliased } of listed) {
    const { modelId: gatewayId, harness } = option;
    const detail = details.get(gatewayId);
    const levels = thinkingLevelsOf(detail);
    const contextWindow = detail?.contextWindow;
    // Every field the host fills in, as desktop sends them and the host
    // exports them again: the size checks measure what subprocesses get.
    const route = (modelId: string, gatewayOnly: boolean): object => ({
      modelId,
      gatewayId,
      family: familyOf(gatewayId, detail),
      recommendedHarness: harness,
      gatewayOnly,
      contextWindow:
        contextWindow !== undefined &&
        Number.isSafeInteger(contextWindow) &&
        contextWindow > 0
          ? contextWindow
          : 0,
      supportsPromptCaching: false,
      supportedThinkingLevels: levels,
      toolSchemaProfile: 'standard',
    });
    const ids = natives.length > 0 ? natives : [gatewayId];
    for (const modelId of ids) {
      if (natives.length > 0)
        (harness === 'claude' ? claudeModels : codexModels).push(modelId);
      else aiGatewayModels.push(modelId);
      gatewayRoutes.push(route(modelId, natives.length === 0));
      assignments.push(
        natives.length > 0
          ? {
              modelId,
              source: sourceOf(harness),
              harness,
              defaultHarness: harness,
              configurable: false,
              overridden: false,
              availableHarnesses: [harness],
            }
          : {
              modelId,
              source: 'ai-gateway',
              harness,
              defaultHarness: harness,
              configurable: true,
              overridden: false,
              availableHarnesses: ['claude', 'codex'],
            },
      );
      if (levels.length > 0) thinkingLevels[modelId] = levels;
    }
    // A confirmed replacement names the catalog id: it runs as its desktop model.
    const [first] = natives;
    if (first !== undefined && !natives.includes(gatewayId))
      modelAliases[gatewayId] = first;
    // A desktop model on another harness runs as the catalog model, as
    // preflight and the run's routes map it.
    for (const modelId of aliased) aliasedTo.set(modelId, first ?? gatewayId);
  }
  // Desktop's aliases of the models listed, as desktop keeps them. An alias
  // resolves in one step, so an alias of a desktop model that is itself an
  // alias names that alias's target.
  const native = new Set([...claudeModels, ...codexModels]);
  for (const [modelId, target] of aliasedTo)
    if (!native.has(modelId)) modelAliases[modelId] = target;
  for (const [alias, modelId] of Object.entries(CLOUD_NATIVE_MODEL_ALIASES)) {
    if (native.has(alias)) continue;
    if (native.has(modelId)) modelAliases[alias] = modelId;
    else {
      const target = aliasedTo.get(modelId);
      if (target !== undefined) modelAliases[alias] = target;
    }
  }
  return {
    ...(claudeModels.length > 0 && {
      CLAUDE_MODELS: JSON.stringify(claudeModels),
    }),
    ...(codexModels.length > 0 && {
      CODEX_MODELS: JSON.stringify(codexModels),
    }),
    ...(Object.keys(modelAliases).length > 0 && {
      MODEL_ALIASES: JSON.stringify(modelAliases),
    }),
    MODEL_CATALOG: JSON.stringify({
      version: 1,
      claudeModels,
      codexModels,
      ollamaModels: [],
      aiGatewayModels,
      gatewayRoutes,
      modelAliases,
    }),
    MODEL_HARNESS_ASSIGNMENTS: JSON.stringify({ revision: 0, assignments }),
    ...(Object.keys(thinkingLevels).length > 0 && {
      MODEL_THINKING_LEVELS: JSON.stringify(thinkingLevels),
    }),
  };
}

/**
 * The model registry snapshot a cloud run's start carries: the owner's
 * cloud catalog less what its policy blocks, within the launch limit.
 * `definition` is the run's pinned definition; when the catalog is too
 * large, the models it names are kept first.
 */
export function cloudRunModelRegistry(
  models: CloudModelContext,
  details: ReadonlyMap<string, CloudModelDetails> = new Map(),
  definition: unknown = null,
): CloudRunModelRegistry {
  const allowed: Listed[] = models.catalog
    .filter((option) => !models.isBlocked(option.modelId))
    .map(listedOf);
  const fits = (listed: readonly Listed[]): CloudRunModelRegistry | null => {
    const parsed = WorkerPipelineModelCatalogSchema.safeParse(
      snapshotOf(listed, details),
    );
    return parsed.success &&
      Object.values(parsed.data).every(
        (value) =>
          value === undefined ||
          utf8Bytes(value) <= CLOUD_RUN_MODEL_REGISTRY_VALUE_MAX_BYTES,
      )
      ? parsed.data
      : null;
  };
  const whole = fits(allowed);
  if (whole !== null) return whole;
  const named = namedModelIds(definition);
  const ordered = [
    ...allowed.filter(({ option }) => named.has(option.modelId)),
    ...allowed.filter(({ option }) => !named.has(option.modelId)),
  ];
  // The longest prefix that fits; an empty registry always does.
  let low = 0;
  let high = ordered.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(ordered.slice(0, middle)) !== null) low = middle;
    else high = middle - 1;
  }
  return fits(ordered.slice(0, low)) ?? snapshotOf([], details);
}
