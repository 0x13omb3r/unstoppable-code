import type { CanopyProxyError } from '../llm-gateway';
import { createAppError, type CreateAppErrorOptions } from './create';
import type { AppErrorCode } from './catalog';
import type { AppError } from './types';

export const AI_CREDITS_REFUSAL_ERROR_SOURCE = 'chat:ai-credits-refusal';

export function isExpectedCanopyProxyAppError(error: AppError): boolean {
  return (
    error.kind === 'external' &&
    error.source === AI_CREDITS_REFUSAL_ERROR_SOURCE
  );
}

/** Raw provider messages never become catalog copy or exported detail. */
export function createCanopyProxyAppError(
  error: CanopyProxyError,
  options: Pick<CreateAppErrorOptions, 'clock' | 'randomBytes'> = {},
): AppError {
  let code: AppErrorCode;
  switch (error.code) {
    case 'credentials_unavailable':
      code = 'external.sign_in_required';
      break;
    case 'no_billing_source':
      code = 'external.ai_credits_required';
      break;
    case 'session_budget_exhausted':
      code = 'external.ai_credits_budget_exhausted';
      break;
    case 'guest_model_not_allowed':
    case 'model_locked':
      code = 'external.ai_credits_access_required';
      break;
    case 'work_owner_not_member':
      code = 'external.ai_credits_owner_unavailable';
      break;
    case 'invalid_request':
      // The proxy also uses this for generated requests and missing routes;
      // its code alone is not evidence of user-correctable input.
      code = 'app.unexpected';
      break;
    default:
      code = 'external.service_unavailable';
  }
  return createAppError(code, {
    ...options,
    source: AI_CREDITS_REFUSAL_ERROR_SOURCE,
  });
}
