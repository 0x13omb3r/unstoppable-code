import type { ResourceContextDecision } from '@canopy/execution-engine/lib/resource-context-policy';

type RefusalReason = Extract<
  ResourceContextDecision,
  { allow: false }
>['reason'];

/**
 * An expected background-execution policy refusal, such as arming a watcher
 * whose delivery would be denied. Its message is fixed product copy from
 * `automation-context-copy` with at most a normalized subject name, never a
 * path or id, so it is safe to return to the model as a tool error.
 */
export class BackgroundExecutionRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: RefusalReason,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'BackgroundExecutionRefusedError';
  }
}

/** The tool error for an expected refusal; undefined for any other failure. */
export function backgroundRefusalToolResult(
  error: unknown,
): { text: string; isError: true } | undefined {
  return error instanceof BackgroundExecutionRefusedError
    ? { text: error.message, isError: true }
    : undefined;
}
