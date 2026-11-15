import { TopUpCheckout, type TopUpCheckoutDeps } from '../top-up-checkout';

/**
 * How this host takes a credits purchase.
 *
 * - `inline`: the checkout runs in place ({@link TopUpCheckout}).
 * - `handoff`: billing opens elsewhere (the browser, or Settings) and the
 *   purchase store tracks the return.
 * - `unavailable`: this host cannot take a purchase at all.
 */
export type CreditsPurchaseMode = 'inline' | 'handoff' | 'unavailable';

/**
 * The purchase mode a host's capabilities give: inline checkout when the host
 * mounts it, else a hand-off when one can open now, else unavailable.
 * `handoff` is `null` while the host is still checking (the mode is then
 * `null` too), and `false` when the host has no hand-off at all.
 */
export function resolveCreditsPurchaseMode(input: {
  readonly inlineCheckout: boolean;
  readonly handoff: boolean | null;
}): CreditsPurchaseMode | null {
  if (input.inlineCheckout) return 'inline';
  if (input.handoff === null) return null;
  return input.handoff ? 'handoff' : 'unavailable';
}

/**
 * Where a hand-off went. `'settings'`: billing opened inside the app, so
 * there is no browser return to wait for. `'web'`: a browser page opened.
 * `'failed'`: nothing opened.
 */
export type CreditsHandoffOpenResult = 'settings' | 'web' | 'failed';

/**
 * Opens billing outside the purchase surface. The host owns where it goes;
 * the opener resolves where it went and never rejects.
 */
export type CreditsHandoffOpener<TRequest> = (
  request: TRequest,
) => Promise<CreditsHandoffOpenResult>;

/**
 * Wrap a host's hand-off so a throw or rejection is a `'failed'` open,
 * never an escaped error.
 */
export function createCreditsHandoffOpener<TRequest>(
  open: (request: TRequest) => Promise<CreditsHandoffOpenResult>,
): CreditsHandoffOpener<TRequest> {
  return async (request: TRequest): Promise<CreditsHandoffOpenResult> => {
    try {
      return await open(request);
    } catch {
      return 'failed';
    }
  };
}

/** The inline opener: the shared checkout machine, unchanged. */
export function createInlineCreditsCheckout(
  deps: TopUpCheckoutDeps,
): TopUpCheckout {
  return new TopUpCheckout(deps);
}
