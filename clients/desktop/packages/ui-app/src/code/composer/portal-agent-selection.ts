import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import {
  resolveModelSelectionMetadata,
  type ModelCatalog,
  type ModelCatalogOption,
} from '@canopy/protocol/models';
import { changeSelectedAgent, selectedAgentId } from '@canopy/ui-shared';
import type { AgentPickerOption } from '@canopy/ui-shared/components';

export function portalEffectiveModel(
  catalog: ModelCatalog,
  selection: string | undefined,
): string | undefined {
  return resolveModelSelectionMetadata({ catalog, selection }).concreteModelId;
}

export function portalAgentOptions(
  catalog: ModelCatalog,
  selection: string | undefined,
  effectiveModel: string | undefined,
): AgentPickerOption[] {
  return catalog
    .filter((row) => row.kind === 'agent')
    .map((row) => {
      const next = changeSelectedAgent(selection, row.id, effectiveModel);
      const model = portalEffectiveModel(catalog, next);
      const supported = row.agentSelection?.supportedModels;
      const unavailable =
        supported !== undefined
          ? !supported.some((choice) => choice.modelId === model)
          : !row.available && !(next && parseAgentRouteModelId(next));
      return {
        id: row.id,
        label: row.label,
        description: row.description,
        ...(unavailable
          ? { unavailableReason: 'Choose a supported model first' }
          : {}),
      };
    });
}

export function portalAgentModelRows(
  catalog: ModelCatalog,
  selection: string | undefined,
): ModelCatalog {
  const agent = catalog.find((row) => row.id === selectedAgentId(selection));
  const supported = agent?.agentSelection?.supportedModels;
  return catalog
    .filter((row) => row.kind !== 'agent')
    .map((row): ModelCatalogOption => {
      if (supported === undefined) return row;
      const choice = supported.find((item) => item.modelId === row.id);
      const metadata =
        resolveModelSelectionMetadata({
          catalog,
          selection: `${agent?.id}@${row.id}`,
        }).metadataRow ?? row;
      return {
        ...metadata,
        available: row.available && choice !== undefined,
        harnessChoices: row.harnessChoices?.filter((item) =>
          choice?.harnesses.includes(item.harness),
        ),
      };
    });
}
