/**
 * Names the consolidation prompt, output schema and validation rules. Bump it
 * whenever a change could make the same input consolidate differently; a
 * revision records it so desktop and Cloud output can be compared.
 */
// Combines CAN-6047 specific-fact retention with CAN-6056 link health.
export const MEMORY_CONSOLIDATION_PROMPT_VERSION =
  'consolidation-v3-fact-retention-link-health';

/** This package's version, recorded on every consolidation revision. */
export const MEMORY_CONSOLIDATION_PACKAGE_VERSION = '1.1.0';
