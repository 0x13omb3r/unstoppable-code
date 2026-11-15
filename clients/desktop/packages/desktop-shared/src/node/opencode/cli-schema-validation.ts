import { join } from 'node:path';
import {
  createOpenCodeSchemaValidator,
  type OpenCodeSchemaValidator,
} from './schema-validation';

declare const __CANOPY_OPENCODE_SCHEMA_WORKER_SOURCE__: string | undefined;

/** The SEA embeds a trusted worker bundle; source CLI uses its development loader. */
export function createCliOpenCodeSchemaValidator(): OpenCodeSchemaValidator {
  if (typeof __CANOPY_OPENCODE_SCHEMA_WORKER_SOURCE__ !== 'undefined')
    return createOpenCodeSchemaValidator(
      __CANOPY_OPENCODE_SCHEMA_WORKER_SOURCE__,
      { eval: true },
    );
  const loader = require.resolve('tsx/cjs');
  const entry = join(__dirname, 'schema-validation-worker.ts');
  return createOpenCodeSchemaValidator(
    `require(${JSON.stringify(loader)});require(${JSON.stringify(entry)});`,
    { eval: true },
  );
}
