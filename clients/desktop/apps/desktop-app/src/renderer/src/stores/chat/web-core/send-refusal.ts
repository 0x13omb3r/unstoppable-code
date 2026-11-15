import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';

/** The kinds with which the web core turns a send away before posting it. */
const REFUSAL_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'invalid_argument',
  'unauthenticated',
  'permission_denied',
  'not_found',
  'already_exists',
  'conflict',
  'failed_precondition',
  'capability_unavailable',
  'resource_exhausted',
]);

/**
 * A cloud send the web core refused outright, with no retry: nothing was
 * posted, so the composer may take the message back (CAN-6364). A send whose
 * outcome is unknown, such as one that timed out and whose receipt could not
 * be read, is never one.
 */
export class WebCoreSendRefusedError extends CoreCoworkRequestError {}

/**
 * Whether the web core refused a send because it was pressed under another
 * account (CAN-6828): its text belongs to neither chat now, so it is neither
 * sent nor put back in any composer.
 */
export function isAccountChangedRefusal(error: unknown): boolean {
  return (
    error instanceof CoreCoworkRequestError &&
    error.payload.code === 'core.chat.message.accountChanged'
  );
}

/** The error a send the web core answered with `payload`, and no retry, throws. */
export function sendFailure(
  payload: CanopyErrorPayload,
): CoreCoworkRequestError {
  return REFUSAL_KINDS.has(payload.kind)
    ? new WebCoreSendRefusedError(payload)
    : new CoreCoworkRequestError(payload);
}
