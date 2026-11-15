import { isBillingRequestId, isBillingWebReturnPath } from './top-up-intent';

/**
 * Whose payment settings a desktop handoff opens. Always explicit: a handoff
 * never infers an organization from membership order or the selected
 * workspace context.
 */
export type SettingsPaymentOwner =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly organizationId: string };

/**
 * The financial modals a billing page can open on arrival.
 *
 * `subscription` was retired with subscription tiers. Shipped desktop builds
 * can still open `?paymentModal=subscription&plan=…`; it is no longer a known
 * modal, so it parses as no intent and the page loads without a modal.
 */
export const BILLING_PAYMENT_MODALS = [
  'payment-method',
  'auto-top-up',
] as const;

export type BillingPaymentModal = (typeof BILLING_PAYMENT_MODALS)[number];

/**
 * A one-shot request to open a billing modal after the page loads. Opening a
 * modal never submits a financial mutation; the modal keeps its own explicit
 * confirmation.
 */
export type BillingPaymentModalIntent =
  | { modal: 'payment-method'; requestId: string }
  | { modal: 'auto-top-up'; requestId: string };

export const BILLING_PAYMENT_MODAL_PARAM = 'paymentModal';
export const BILLING_PAYMENT_REQUEST_ID_PARAM = 'paymentRequestId';
// compat: the retired subscription intent carried `plan`. A link that still
// carries it parses as no intent, so it is never consumed and stays in the URL;
// it is kept in the strip list only for intents that are consumed.
const PLAN_PARAM = 'plan';
const TOP_UP_PARAM = 'topUp';

/** Parameters a consumed modal intent strips from the URL. */
export const BILLING_PAYMENT_MODAL_INTENT_PARAMS: readonly string[] = [
  BILLING_PAYMENT_MODAL_PARAM,
  BILLING_PAYMENT_REQUEST_ID_PARAM,
  PLAN_PARAM,
];

export function isBillingPaymentModal(
  value: unknown,
): value is BillingPaymentModal {
  return BILLING_PAYMENT_MODALS.some((modal) => modal === value);
}

/**
 * Parse a modal intent from billing page query parameters. Returns `null`
 * when no intent is present and for every malformed or conflicting intent:
 * duplicate parameters, an unknown modal (including the retired
 * `subscription`), an invalid request id, a `plan` parameter, or a `topUp`
 * intent alongside `paymentModal`.
 */
export function parseBillingPaymentModalIntent(
  params: URLSearchParams,
): BillingPaymentModalIntent | null {
  if (
    [BILLING_PAYMENT_MODAL_PARAM, BILLING_PAYMENT_REQUEST_ID_PARAM, PLAN_PARAM]
      .map((key) => params.getAll(key).length)
      .some((count) => count > 1)
  )
    return null;
  const modal = params.get(BILLING_PAYMENT_MODAL_PARAM);
  if (modal === null || !isBillingPaymentModal(modal)) return null;
  if (params.has(TOP_UP_PARAM)) return null;
  const requestId = params.get(BILLING_PAYMENT_REQUEST_ID_PARAM);
  if (!isBillingRequestId(requestId)) return null;
  if (params.has(PLAN_PARAM)) return null;
  return { modal, requestId };
}

/**
 * Append a modal intent to an owner-specific billing path such as
 * `accountBillingPath()` or `organizationBillingPath(id)`, retaining unrelated
 * query parameters and the hash. Throws when the result would not parse back
 * to the same intent (for example a path that already carries `topUp` or
 * `plan`).
 */
export function buildBillingPaymentModalIntentPath(
  billingPath: string,
  intent: BillingPaymentModalIntent,
): string {
  if (!isBillingWebReturnPath(billingPath))
    throw new Error('Invalid billing path');
  const url = new URL(billingPath, 'https://billing.invalid');
  url.searchParams.delete(BILLING_PAYMENT_MODAL_PARAM);
  url.searchParams.delete(BILLING_PAYMENT_REQUEST_ID_PARAM);
  url.searchParams.set(BILLING_PAYMENT_MODAL_PARAM, intent.modal);
  url.searchParams.set(BILLING_PAYMENT_REQUEST_ID_PARAM, intent.requestId);
  const parsed = parseBillingPaymentModalIntent(url.searchParams);
  if (
    parsed === null ||
    parsed.modal !== intent.modal ||
    parsed.requestId !== intent.requestId
  )
    throw new Error('Invalid payment modal intent');
  return url.pathname + url.search + url.hash;
}

/**
 * Remove a consumed modal intent's parameters from a URL, keeping every
 * unrelated parameter and the hash. Returns the relative path to pass to a
 * history replacement.
 */
export function stripBillingPaymentModalIntentParams(href: string): string {
  const url = new URL(href, 'https://billing.invalid');
  for (const key of BILLING_PAYMENT_MODAL_INTENT_PARAMS)
    url.searchParams.delete(key);
  return url.pathname + url.search + url.hash;
}
