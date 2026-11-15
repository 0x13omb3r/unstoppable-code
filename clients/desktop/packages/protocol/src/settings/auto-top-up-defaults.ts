/**
 * Automatic top-up defaults for AI Credits wallets (personal and org pool).
 *
 * Browser-safe: the web auto top-up engine and the shared wallet UI read these
 * on both hosts. Independent of any billing plan.
 */

/**
 * Default per-refill increment (USD) used when auto-top-up is enabled without an
 * explicit `amountUsd`. The auto-top-up UX (CAN-1040 / T17) deliberately hides
 * this tuning field; on first enable the engine falls back to this catalog
 * default so it has a valid charge amount without asking the user. Must sit
 * inside `[AI_CREDIT_TOP_UP_MIN_USD, AI_CREDIT_TOP_UP_MAX_USD]`.
 */
export const AI_CREDIT_AUTO_TOP_UP_DEFAULT_AMOUNT_USD: number = 25;

/**
 * Default low-balance trigger (in credits) used when auto-top-up is enabled
 * without an explicit `thresholdCredits`. Hidden from the auto-top-up UX
 * (CAN-1040 / T17); the engine fires a refill once the spendable balance drops
 * below this many credits.
 */
export const AI_CREDIT_AUTO_TOP_UP_DEFAULT_THRESHOLD_CREDITS: number = 10;

/**
 * Default monthly auto-top-up spend cap (USD) armed when a user enables
 * auto-top-up from the wallet UI without an explicit cap. We deliberately do NOT
 * default to unlimited (CAN-1040 feedback): the first-enable experience sets a
 * sane ceiling the user can raise or clear from "Adjust limit".
 */
export const AI_CREDIT_AUTO_TOP_UP_DEFAULT_MONTHLY_CAP_USD: number = 500;

/**
 * Org credit-pool variant of {@link AI_CREDIT_AUTO_TOP_UP_DEFAULT_MONTHLY_CAP_USD}.
 * Higher because it covers a whole team rather than one person.
 */
export const AI_CREDIT_AUTO_TOP_UP_DEFAULT_ORG_MONTHLY_CAP_USD: number = 1000;
