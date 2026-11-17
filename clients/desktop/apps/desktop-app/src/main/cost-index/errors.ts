import type { CostViewUnavailableReason } from '@canopy/protocol/cost-view';

/** The local cost service serves every read, so it is never `not_served`. */
export type CostServiceErrorReason =
  | Exclude<CostViewUnavailableReason, 'not_served'>
  | 'NOT_FOUND'
  | 'SCOPE_SEALED'
  | 'UNKNOWN';

/** A stable, typed failure for the main-process cost service boundary. */
export class CostServiceError extends Error {
  public readonly reason: CostServiceErrorReason;

  public constructor(reason: CostServiceErrorReason, message?: string) {
    super(message ?? reason);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'CostServiceError';
    this.reason = reason;
  }
}
