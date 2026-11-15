'use client';

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  BillingClient,
  CanopyCapabilities,
  CreditsHandoffClient,
} from '@canopy/app-core';
import {
  resolveCreditsPurchaseMode,
  type CreditsPurchaseMode,
} from '@canopy/app-state/billing/credits';
import type {
  BillingTopUpIntent,
  SettingsPaymentOwner,
} from '@canopy/protocol/billing';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import type {
  SettingsPaymentHandoffIntent,
  SettingsPaymentHandoffResult,
} from '@canopy/protocol/settings/payment-handoff';
// Type only: the sheet's code (card capture and Stripe) comes from the host.
import type { TopUpSheetProps } from '../billing/TopUpSheet';

/**
 * The one AI Credits purchase action every surface starts a purchase with.
 *
 * The mode comes from the host's client, never from which host this is:
 *
 * - `inline` when the host mounts inline checkout
 *   (`capabilities.inlineCheckout`);
 * - `handoff` when the client has a `creditsHandoff` that can open now;
 * - `unavailable` otherwise.
 *
 * Availability is read only while a surface uses the action, and again when
 * the window regains focus, as the person may have signed in elsewhere.
 *
 * An inline host also supplies {@link CreditsCheckoutHost}, and the provider
 * mounts the one checkout sheet every inline start opens. Surfaces never
 * mount a checkout of their own.
 *
 * The sheet component is the host's ({@link CreditsCheckoutHost.Sheet}), so
 * this module never references the sheet's code: a host without inline
 * checkout (desktop) imports the provider without bundling card capture or
 * Stripe (`check:desktop-renderer-no-stripe`). An inline host passes a lazy
 * sheet, so card capture stays out of a surface's first bundle.
 */

/** What the purchase action needs from a host's `CanopyClient`. */
export interface CreditsPurchaseClient {
  readonly capabilities: Pick<CanopyCapabilities, 'inlineCheckout'>;
  readonly creditsHandoff?: CreditsHandoffClient;
}

/**
 * What an inline host gives the shared checkout sheet. The transport is the
 * host's; the provider binds it to the owner each checkout opens for.
 */
export interface CreditsCheckoutHost {
  /** The host's billing transport; the provider binds it to one wallet. */
  readonly billing: BillingClient;
  /** The top-up service fee, in percent. */
  readonly feePercent: number;
  readonly appName: string;
  /** The desktop app's link scheme, for the "Back to" return link. */
  readonly deepLinkScheme: string;
  /** Stripe publishable key, or `null` when card capture is unconfigured. */
  readonly publishableKey: string | null;
  /**
   * The checkout sheet (`TopUpSheet` from `@canopy/ui-app/billing`), usually
   * `React.lazy`, so it loads when a checkout first opens. The provider wraps
   * it in `Suspense`. Define it once at module scope: a new component type
   * remounts an open checkout and loses its card entry.
   */
  readonly Sheet: ComponentType<TopUpSheetProps>;
}

/**
 * One inline checkout opening: why it opened and what its caller hears back.
 * Every field is optional; {@link CreditsCheckoutHandle.update} changes them
 * while the sheet is open.
 */
export interface CreditsCheckoutOptions {
  /**
   * What the sheet opens with. Omitted, a top-up start that names a source
   * opens with its reason, source, model, chat and amount, and any other
   * start opens a plain purchase.
   */
  readonly intent?: BillingTopUpIntent;
  /**
   * The signed-in account the payment journal is bound to, with the owner.
   * A change remounts the sheet.
   */
  readonly accountKey?: string;
  /** The owner's per-credit sale price, for the estimate. */
  readonly creditPriceUsd?: number;
  /** Prefix for the sheet's test ids. */
  readonly testIdPrefix?: string;
  /** The owner's model-library access, refetched. Unlock checkouts only. */
  readonly fetchAccess?: () => Promise<ModelLibraryAccess | undefined>;
  /** Bumped when something suggests the owner's state moved. */
  readonly refreshSignal?: number;
  /** The server confirmed the payment. */
  readonly onPaid?: () => void;
  /** The refetched access answered `unlocked`. */
  readonly onUnlocked?: () => void;
  /** Payment, credits and any requested library access are confirmed. */
  readonly onComplete?: () => void;
  /** The person closed the sheet, or a settled purchase closed it. */
  readonly onClose?: () => void;
}

/** The open checkout a start returned. Stale handles do nothing. */
export interface CreditsCheckoutHandle {
  /** Replace some of the opening's options while it is open. */
  update(options: CreditsCheckoutOptions): void;
  /** Unmount the sheet without reporting a close, as unmounting did. */
  close(): void;
}

/** What starting a purchase did. */
export type CreditsPurchaseStart =
  /** The host checks out in place: the provider's sheet opened. */
  | { readonly mode: 'inline'; readonly checkout: CreditsCheckoutHandle }
  /** The owner's billing page is opening; never rejects for a known host. */
  | {
      readonly mode: 'handoff';
      readonly opened: Promise<SettingsPaymentHandoffResult>;
    }
  /** Nothing can take this purchase now (or the owner is not known yet). */
  | { readonly mode: 'unavailable' };

export interface CreditsPurchaseAction {
  /** `null` while the host is still checking whether a hand-off can open. */
  readonly mode: CreditsPurchaseMode | null;
  /**
   * Start a purchase. Inline, it opens the provider's checkout sheet for this
   * owner with `checkout`, replacing any open one; a hand-off ignores
   * `checkout`. A sheet a caller opened closes when that caller unmounts.
   */
  start(
    intent: SettingsPaymentHandoffIntent,
    checkout?: CreditsCheckoutOptions,
  ): CreditsPurchaseStart;
}

interface CheckoutOpening {
  readonly id: number;
  readonly organizationId: string | undefined;
  readonly options: CreditsCheckoutOptions;
}

interface CreditsPurchaseContextValue {
  readonly client: CreditsPurchaseClient | null;
  readonly accountId: string | null | undefined;
  readonly mode: CreditsPurchaseMode | null;
  /** A surface uses the action; the returned function releases it. */
  readonly retain: () => () => void;
  /** Opens the checkout sheet, or `null` when this host mounts none. */
  readonly openCheckout:
    | ((
        organizationId: string | undefined,
        options: CreditsCheckoutOptions,
      ) => CreditsCheckoutHandle)
    | null;
}

const CreditsPurchaseContext =
  createContext<CreditsPurchaseContextValue | null>(null);

export interface CreditsPurchaseProviderProps {
  /** The host's client; `null` when it has none, so nothing can be bought. */
  readonly client: CreditsPurchaseClient | null;
  /**
   * The signed-in account purchases act for. `null` means signed out, so
   * nothing can be handed off. Omitted, the client uses the account signed
   * in when the hand-off opens.
   */
  readonly accountId?: string | null;
  /**
   * What the checkout sheet needs on a host that checks out inline. Without
   * it no sheet mounts and an inline start is unavailable.
   */
  readonly checkout?: CreditsCheckoutHost;
  readonly children: ReactNode;
}

/** The sheet intent a start implies when its caller names none. */
function checkoutIntentOf(
  intent: SettingsPaymentHandoffIntent,
): BillingTopUpIntent | undefined {
  if (intent.kind !== 'top-up' || intent.source === undefined) return undefined;
  return {
    reason: intent.reason,
    source: intent.source,
    ...(intent.modelId === undefined ? {} : { modelId: intent.modelId }),
    ...(intent.chatId === undefined ? {} : { chatId: intent.chatId }),
    ...(intent.amountUsd === undefined ? {} : { amountUsd: intent.amountUsd }),
  };
}

/** Scope for every AI Credits purchase on one host surface. */
export function CreditsPurchaseProvider({
  client,
  accountId,
  checkout,
  children,
}: CreditsPurchaseProviderProps): JSX.Element {
  const inlineCheckout = client?.capabilities.inlineCheckout === true;
  const handoff = inlineCheckout ? undefined : client?.creditsHandoff;
  const [consumers, setConsumers] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);
  const reading = consumers > 0 && handoff !== undefined && accountId !== null;

  useEffect(() => {
    if (!reading || handoff === undefined) {
      // Unused: the next surface to use the action reads it afresh.
      setAvailable(null);
      return undefined;
    }
    let cancelled = false;
    let latest = 0;
    const request = accountId === undefined ? {} : { accountId };
    const check = (): void => {
      const attempt = ++latest;
      void handoff.availability(request).then(
        (result) => {
          if (!cancelled && attempt === latest) setAvailable(result.available);
        },
        () => {
          // The client never rejects; a broken one is an unavailable hand-off.
          if (!cancelled && attempt === latest) setAvailable(false);
        },
      );
    };
    check();
    window.addEventListener('focus', check);
    return (): void => {
      cancelled = true;
      window.removeEventListener('focus', check);
    };
  }, [accountId, handoff, reading]);

  const mode = resolveCreditsPurchaseMode({
    inlineCheckout,
    handoff: handoff === undefined || accountId === null ? false : available,
  });
  const retain = useCallback((): (() => void) => {
    setConsumers((count) => count + 1);
    return (): void => setConsumers((count) => count - 1);
  }, []);

  // The one checkout this provider shows. A new start replaces it.
  const [opening, setOpening] = useState<CheckoutOpening | null>(null);
  const sequenceRef = useRef(0);
  const hasCheckout = inlineCheckout && checkout !== undefined;
  const openCheckout = useMemo(
    () =>
      hasCheckout
        ? (
            organizationId: string | undefined,
            options: CreditsCheckoutOptions,
          ): CreditsCheckoutHandle => {
            sequenceRef.current += 1;
            const id = sequenceRef.current;
            setOpening({ id, organizationId, options });
            return {
              update: (next) =>
                setOpening((current) =>
                  current?.id === id
                    ? { ...current, options: { ...current.options, ...next } }
                    : current,
                ),
              close: () =>
                setOpening((current) => (current?.id === id ? null : current)),
            };
          }
        : null,
    [hasCheckout],
  );
  const closeOpening = useCallback((id: number): void => {
    setOpening((current) => (current?.id === id ? null : current));
  }, []);

  const value = useMemo<CreditsPurchaseContextValue>(
    () => ({ client, accountId, mode, retain, openCheckout }),
    [accountId, client, mode, openCheckout, retain],
  );
  return (
    <CreditsPurchaseContext.Provider value={value}>
      {children}
      {opening !== null && hasCheckout ? (
        <CreditsCheckoutSheet
          // Each opening, and each account and owner, is its own checkout:
          // they never share request ids or an in-flight answer.
          key={`${opening.id}:${checkoutContextKey(opening)}`}
          host={checkout}
          opening={opening}
          onClosed={closeOpening}
        />
      ) : null}
    </CreditsPurchaseContext.Provider>
  );
}

/** The account and owner a checkout's payment journal is bound to. */
function checkoutContextKey(opening: CheckoutOpening): string {
  return JSON.stringify([
    opening.options.accountKey ?? 'session',
    opening.organizationId ?? 'personal',
  ]);
}

function noop(): void {}

/** The open checkout, bound to its owner's wallet. */
function CreditsCheckoutSheet({
  host,
  opening,
  onClosed,
}: {
  readonly host: CreditsCheckoutHost;
  readonly opening: CheckoutOpening;
  readonly onClosed: (id: number) => void;
}): JSX.Element {
  const { id, organizationId, options } = opening;
  const { billing: hostBilling, Sheet } = host;
  const billing = useMemo<BillingClient>(() => {
    const wallet =
      organizationId === undefined ? undefined : { orgId: organizationId };
    return {
      ...hostBilling,
      createSetupIntent: (): ReturnType<BillingClient['createSetupIntent']> =>
        hostBilling.createSetupIntent(wallet),
      confirmPaymentMethod: (
        setupIntentId,
      ): ReturnType<BillingClient['confirmPaymentMethod']> =>
        hostBilling.confirmPaymentMethod(setupIntentId, wallet),
      topUp: (input): ReturnType<BillingClient['topUp']> =>
        hostBilling.topUp({ ...input, orgId: organizationId }),
    };
  }, [hostBilling, organizationId]);
  const createSetupIntent = useCallback(
    (): ReturnType<BillingClient['createSetupIntent']> =>
      billing.createSetupIntent(),
    [billing],
  );
  const confirmPaymentMethod = useCallback(
    (
      setupIntentId: string,
    ): ReturnType<BillingClient['confirmPaymentMethod']> =>
      billing.confirmPaymentMethod(setupIntentId),
    [billing],
  );
  const { onClose } = options;
  const close = useCallback((): void => {
    onClosed(id);
    onClose?.();
  }, [id, onClose, onClosed]);
  return (
    <Suspense fallback={null}>
      <Sheet
        billing={billing}
        contextKey={checkoutContextKey(opening)}
        feePercent={host.feePercent}
        appName={host.appName}
        deepLinkScheme={host.deepLinkScheme}
        orgId={organizationId}
        publishableKey={host.publishableKey}
        createSetupIntent={createSetupIntent}
        confirmPaymentMethod={confirmPaymentMethod}
        creditPriceUsd={options.creditPriceUsd}
        testIdPrefix={options.testIdPrefix}
        intent={options.intent}
        fetchAccess={options.fetchAccess}
        refreshSignal={options.refreshSignal}
        onPaid={options.onPaid ?? noop}
        onUnlocked={options.onUnlocked}
        onComplete={options.onComplete}
        onClose={close}
      />
    </Suspense>
  );
}

/**
 * The purchase action for one wallet. `owner` is `null` while it is not
 * known: the mode still reads, but nothing is handed off to a guessed owner.
 * Throws outside a {@link CreditsPurchaseProvider}.
 */
export function useCreditsPurchase(
  owner: SettingsPaymentOwner | null,
): CreditsPurchaseAction {
  const context = useContext(CreditsPurchaseContext);
  if (context === null)
    throw new Error(
      'AI Credits purchases must render inside a <CreditsPurchaseProvider>.',
    );
  const { accountId, client, mode, openCheckout, retain } = context;
  useEffect(() => retain(), [retain]);
  // The sheets this caller opened, closed when it unmounts as the checkouts
  // it once rendered itself were. No `onClose` is reported: every caller's
  // close handler only settles state the unmounting caller owns, and React's
  // development effect replay unmounts once on mount, where a reported close
  // would run a caller's close work (a held send's funding re-check) for a
  // checkout that reopens straight away.
  const openedRef = useRef<CreditsCheckoutHandle[]>([]);
  useEffect(() => {
    const opened = openedRef.current;
    return (): void => {
      for (const handle of opened.splice(0)) handle.close();
    };
  }, []);
  const organizationId =
    owner?.kind === 'organization' ? owner.organizationId : null;
  const ownerKind = owner?.kind ?? null;
  const start = useCallback(
    (
      intent: SettingsPaymentHandoffIntent,
      checkout: CreditsCheckoutOptions = {},
    ): CreditsPurchaseStart => {
      if (mode === 'inline') {
        if (openCheckout === null || ownerKind === null)
          return { mode: 'unavailable' };
        const handle = openCheckout(organizationId ?? undefined, {
          ...checkout,
          intent:
            'intent' in checkout ? checkout.intent : checkoutIntentOf(intent),
        });
        // Only the latest matters: a start replaces the open checkout.
        openedRef.current.splice(0, openedRef.current.length, handle);
        return { mode: 'inline', checkout: handle };
      }
      const handoff = client?.creditsHandoff;
      if (mode !== 'handoff' || handoff === undefined || ownerKind === null)
        return { mode: 'unavailable' };
      const payer: SettingsPaymentOwner =
        organizationId === null
          ? { kind: 'personal' }
          : { kind: 'organization', organizationId };
      return {
        mode: 'handoff',
        opened: handoff.open({
          owner: payer,
          intent,
          ...(accountId === undefined || accountId === null
            ? {}
            : { accountId }),
        }),
      };
    },
    [accountId, client, mode, openCheckout, organizationId, ownerKind],
  );
  return useMemo(() => ({ mode, start }), [mode, start]);
}
