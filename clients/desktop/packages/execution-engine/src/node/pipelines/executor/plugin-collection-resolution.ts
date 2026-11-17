import type {
  PipelinePluginCollectionPreference,
  ResolvedPipelinePluginCollectionSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import { resolvePipelinePluginCollections } from '@canopy/execution-engine/node/pipelines/plugin-collection-resolver';
import {
  loadPipelinePluginCollectionPreferences,
  normalizePipelinePluginCollectionPreferences,
} from '../plugin-collection-store';
import type { ExecutionOptions, NormalizedPipeline } from './types';

/*
 * A run's plugin collections as its executor resolves them at start: stored
 * preferences, then draft, through the runtime's resolver. A daemon launch
 * resolves them the same way in its core (CAN-5832).
 */

export async function resolveExecutionPluginCollections(
  normalizedPipeline: Pick<NormalizedPipeline, 'plugin_collections'>,
  options: ExecutionOptions,
  /** The execution starting; a host resolves a child's own for it (CAN-6868). */
  executionId?: string,
): Promise<
  | {
      preferences: Record<string, PipelinePluginCollectionPreference>;
      snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot>;
    }
  | undefined
> {
  if (!normalizedPipeline.plugin_collections) {
    return undefined;
  }

  const storedPreferences = options.pipelinePreferenceLocator
    ? loadPipelinePluginCollectionPreferences(options.pipelinePreferenceLocator)
    : {};
  const draftPreferences =
    options.pluginCollectionPreferences !== undefined
      ? normalizePipelinePluginCollectionPreferences(
          options.pluginCollectionPreferences,
        )
      : {};
  const preferences = {
    ...storedPreferences,
    ...draftPreferences,
  };
  // The host's resolver learns the execution; the default resolver's third
  // parameter is its catalog, so it is never handed one.
  const hostResolver = options.runtime.resolvePipelinePluginCollections;
  const resolution =
    hostResolver === undefined
      ? await resolvePipelinePluginCollections(
          normalizedPipeline.plugin_collections,
          preferences,
        )
      : await hostResolver(
          normalizedPipeline.plugin_collections,
          preferences,
          executionId === undefined ? undefined : { executionId },
        );
  const blockingErrors = Object.values(resolution.snapshots).flatMap(
    (snapshot) => snapshot.unresolvedRequiredDefaults,
  );
  if (blockingErrors.length > 0) {
    throw new Error(blockingErrors.map((entry) => entry.error).join('\n'));
  }

  return {
    preferences,
    snapshots: resolution.snapshots,
  };
}
