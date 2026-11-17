import { z } from 'zod';

import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { COST_GRANTS, CostQueryErrorSchema } from './operations';
import { PipelineRunCostViewSchema } from './schemas';

/**
 * A cloud run's cost (CAN-6881, cloud pipelines CP-52): the run's AI Credits
 * charges, its model calls and its sandbox compute, as the ledger recorded
 * them. A cloud run has no local cost scope, so it is named by its execution
 * id alone; the web core authorizes the read as it does the run's own reads.
 */
export const CostCloudRunRequestSchema = z.strictObject({
  executionId: z.string().min(1).max(512),
});

export const CostCloudRunGetResultSchema = PipelineRunCostViewSchema;

/**
 * Served by the web core only, behind the cloud pipelines rollout flag, and
 * not composed into the core registry: desktop and the daemon answer
 * `capability_unavailable`; a desktop showing a cloud run asks the web core.
 */
export const CORE_COST_CLOUD_RUN_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.cost.cloudRun.get': defineCanopyQuery({
      plane: 'core',
      domain: 'cost',
      version: 1,
      placement: 'core-only',
      params: CostCloudRunRequestSchema,
      result: CostCloudRunGetResultSchema,
      error: CostQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [COST_GRANTS.read],
    }),
  },
);
