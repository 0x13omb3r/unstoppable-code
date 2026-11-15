import type { AgentExecutionHarness } from './index';

export interface AgentCatalogSelection {
  preferredModel?: string;
  supportedModels: readonly {
    modelId: string;
    harnesses: readonly AgentExecutionHarness[];
  }[];
}

export function isConcreteAgentModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value !== 'auto' &&
    value !== 'default' &&
    !value.startsWith('agent_model_') &&
    !value.startsWith('$')
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function harness(value: unknown): value is AgentExecutionHarness {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode' ||
    value === 'antigravity'
  );
}

/** Absent means legacy/unknown; a malformed declaration fails closed. */
export function readAgentSelection(
  value: unknown,
): AgentCatalogSelection | undefined {
  if (value === undefined) return undefined;
  if (
    !record(value) ||
    !Array.isArray(value.supportedModels) ||
    (value.preferredModel !== undefined &&
      !isConcreteAgentModel(value.preferredModel))
  )
    return { supportedModels: [] };
  const supportedModels: AgentCatalogSelection['supportedModels'][number][] =
    [];
  for (const row of value.supportedModels) {
    if (
      !record(row) ||
      !isConcreteAgentModel(row.modelId) ||
      !Array.isArray(row.harnesses) ||
      !row.harnesses.length ||
      !row.harnesses.every(harness)
    )
      return { supportedModels: [] };
    supportedModels.push({ modelId: row.modelId, harnesses: row.harnesses });
  }
  return {
    ...(value.preferredModel === undefined
      ? {}
      : { preferredModel: value.preferredModel }),
    supportedModels,
  };
}
