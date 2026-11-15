'use client';

import { PaymentHandoffNotice } from '@canopy/ui-shared/components';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  accountBillingPath,
  organizationBillingPath,
  type SettingsPaymentOwner,
} from '@canopy/protocol/billing';
import type {
  SettingsPaymentHandoffFailure,
  SettingsPaymentHandoffIntent,
} from '@canopy/protocol/settings/payment-handoff';
import type { CreditsPurchaseMode } from '@canopy/app-state/billing/credits';
import {
  AI_CREDITS_PURCHASE_LABEL,
  Button,
} from '@canopy/ui-shared/components';
import { useCreditsPurchase } from '../../credits/CreditsPurchaseProvider';
import { useSettingsHost, useSettingsNavigation } from '../host';
import {
  useBillingSettingsSlots,
  type BillingSettingsSlots,
} from './billing-settings-slots';

/**
 * The payment area of the shared billing sections: which payment UI the host
 * gets, the CTA labels, who may use them, and the handoff's pending, opened,
 * failed and unavailable states.
 *
 * - A host with inline checkout (web) renders its inline financial UI from
 *   the billing slots, unchanged.
 * - A host without it (desktop) renders CTAs that open the owner's web
 *   billing page with the intended modal already open, through the shared
 *   AI Credits purchase action (`useCreditsPurchase`) and the client's
 *   `creditsHandoff`. Opening the browser never means a payment
 *   succeeded: the area offers "Check again" and refreshes the authoritative
 *   wallet, card and activity when the window regains focus.
 *
 * It never renders card fields, Stripe, checkout or editing forms itself.
 */

export const PAYMENT_HANDOFF_UNAVAILABLE_COPY = 'Manage payments on the web.';
export const PAYMENT_HANDOFF_OPENED_COPY = 'Continue in your browser.';
export const PAYMENT_HANDOFF_FAILED_COPY =
  "Couldn't open this payment page. Try again.";
export const PAYMENT_HANDOFF_BROWSER_FAILED_COPY =
  "Couldn't open your browser. Try again.";

/** Debounce for the window-focus refresh, so one return refreshes once. */
export const PAYMENT_AREA_FOCUS_REFRESH_DELAY_MS = 250;

/** What a payment CTA opens. */
export type PaymentAreaAction = 'payment-method' | 'top-up' | 'auto-top-up';

/** The payment UI this host can show. */
export type PaymentAreaMode =
  | { readonly kind: 'inline'; readonly slots: BillingSettingsSlots | null }
  | { readonly kind: 'handoff'; readonly available: boolean | null };

/**
 * The payment mode for a purchase mode. Inline checkout uses the mounted
 * billing slots (none mounted means no payment UI); every other host gets
 * the handoff CTAs, whose availability is `null` while the host checks and
 * `false` when no handoff can open.
 */
function usePaymentAreaModeFor(
  purchaseMode: CreditsPurchaseMode | null,
): PaymentAreaMode {
  const slots = useBillingSettingsSlots();
  return useMemo<PaymentAreaMode>(() => {
    switch (purchaseMode) {
      case 'inline':
        return { kind: 'inline', slots };
      case 'handoff':
        return { kind: 'handoff', available: true };
      case 'unavailable':
        return { kind: 'handoff', available: false };
      case null:
        return { kind: 'handoff', available: null };
    }
  }, [purchaseMode, slots]);
}

/**
 * The host's payment mode, from the shared AI Credits purchase action: one
 * source for whether this host checks out inline or hands off.
 */
export function usePaymentAreaMode(): PaymentAreaMode {
  return usePaymentAreaModeFor(useCreditsPurchase(null).mode);
}

/**
 * Whether the host can capture or manage a card at all: inline with card
 * capture configured, or through the handoff (where the web page owns it).
 */
export function paymentCaptureAvailable(mode: PaymentAreaMode): boolean {
  return mode.kind === 'handoff' || mode.slots?.publishableKey != null;
}

/** The handoff CTA label for an action. */
export function paymentAreaActionLabel(
  action: PaymentAreaAction,
  options: { readonly hasCard?: boolean } = {},
): string {
  switch (action) {
    case 'payment-method':
      return options.hasCard === true ? 'Manage payment method' : 'Add card';
    case 'top-up':
      return AI_CREDITS_PURCHASE_LABEL;
    case 'auto-top-up':
      return 'Manage automatic top-up';
  }
}

/** The typed handoff intent an action opens. */
export function paymentAreaHandoffIntent(
  action: PaymentAreaAction,
): SettingsPaymentHandoffIntent {
  switch (action) {
    case 'payment-method':
      return { kind: 'modal', modal: 'payment-method' };
    case 'top-up':
      return { kind: 'top-up', reason: 'credits' };
    case 'auto-top-up':
      return { kind: 'modal', modal: 'auto-top-up' };
  }
}

/** The owner's web billing page path. */
export function paymentOwnerBillingPath(owner: SettingsPaymentOwner): string {
  return owner.kind === 'personal'
    ? accountBillingPath()
    : organizationBillingPath(owner.organizationId);
}

/* -------------------------------------------------------------------------- */
/* Handoff state                                                              */
/* -------------------------------------------------------------------------- */

type HandoffOutcome =
  | { readonly kind: 'opened' }
  | {
      readonly kind: 'failed';
      readonly reason: Exclude<SettingsPaymentHandoffFailure, 'unavailable'>;
    };

interface PaymentAreaState {
  readonly mode: PaymentAreaMode;
  readonly owner: SettingsPaymentOwner;
  /** The viewer may manage this wallet's payments. */
  readonly canManage: boolean;
  /** The handoff is known to be unavailable (or still being checked). */
  readonly unavailable: boolean;
  /** The action whose handoff is opening, or `null`. */
  readonly pending: PaymentAreaAction | null;
  readonly outcome: HandoffOutcome | null;
  readonly start: (
    action: PaymentAreaAction,
    intent: SettingsPaymentHandoffIntent,
  ) => void;
  readonly retry: () => void;
  readonly checkAgain: () => void;
  readonly openOnWeb: () => void;
}

const PaymentAreaContext = createContext<PaymentAreaState | null>(null);

function ownerKey(owner: SettingsPaymentOwner): string {
  return owner.kind === 'personal'
    ? 'personal'
    : `organization:${owner.organizationId}`;
}

export interface PaymentAreaProps {
  /** The wallet whose payments this area opens. Always explicit. */
  readonly owner: SettingsPaymentOwner;
  /** Whether the viewer may manage this wallet's payments. */
  readonly canManage: boolean;
  /**
   * Re-read the authoritative summary, credits and activity. Called by
   * "Check again" and when the window regains focus after a handoff opened.
   */
  readonly refresh: () => void;
  readonly children: ReactNode;
}

/**
 * Scope for one wallet's payment CTAs. Renders only its children; place
 * {@link PaymentAreaNotice} where the area's status belongs.
 */
export function PaymentArea({
  owner,
  canManage,
  refresh,
  children,
}: PaymentAreaProps): JSX.Element {
  const purchase = useCreditsPurchase(owner);
  const mode = usePaymentAreaModeFor(purchase.mode);
  const navigation = useSettingsNavigation();
  const host = useSettingsHost();
  const key = ownerKey(owner);
  const [stateKey, setStateKey] = useState(key);
  const [pending, setPending] = useState<PaymentAreaAction | null>(null);
  const [outcome, setOutcome] = useState<HandoffOutcome | null>(null);
  const [reportedUnavailable, setReportedUnavailable] = useState(false);
  const lastRef = useRef<{
    action: PaymentAreaAction;
    intent: SettingsPaymentHandoffIntent;
  } | null>(null);
  const generationRef = useRef(0);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // A different wallet starts clean: a pending or finished handoff belongs to
  // the owner that started it ("adjusting state on prop change").
  if (stateKey !== key) {
    setStateKey(key);
    setPending(null);
    setOutcome(null);
    setReportedUnavailable(false);
  }
  useEffect(() => {
    generationRef.current += 1;
    lastRef.current = null;
  }, [key]);
  useEffect(
    () => (): void => {
      generationRef.current += 1;
    },
    [],
  );

  const unavailable =
    mode.kind === 'handoff' && (mode.available !== true || reportedUnavailable);

  const start = useCallback(
    (action: PaymentAreaAction, intent: SettingsPaymentHandoffIntent): void => {
      if (mode.kind !== 'handoff' || unavailable || pending !== null) return;
      const begun = purchase.start(intent);
      if (begun.mode !== 'handoff') return;
      const generation = generationRef.current;
      lastRef.current = { action, intent };
      setPending(action);
      setOutcome(null);
      void begun.opened.then(
        (result) => {
          if (generationRef.current !== generation) return;
          setPending(null);
          if (result.ok) {
            setOutcome({ kind: 'opened' });
          } else if (result.reason === 'unavailable') {
            setReportedUnavailable(true);
          } else {
            setOutcome({ kind: 'failed', reason: result.reason });
          }
        },
        () => {
          if (generationRef.current !== generation) return;
          setPending(null);
          setOutcome({ kind: 'failed', reason: 'failed' });
        },
      );
    },
    [mode.kind, pending, purchase, unavailable],
  );

  const retry = useCallback((): void => {
    const last = lastRef.current;
    if (last !== null) start(last.action, last.intent);
  }, [start]);

  const checkAgain = useCallback((): void => {
    refreshRef.current();
  }, []);

  const openOnWeb = useCallback((): void => {
    navigation.openExternal(
      `${host.webOrigin()}${paymentOwnerBillingPath(owner)}`,
    );
  }, [host, navigation, owner]);

  // Returning from the browser refreshes the wallet, card and activity once
  // per focus. The page never infers a payment from having opened it.
  const opened = outcome?.kind === 'opened';
  useEffect(() => {
    if (!opened || typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = (): void => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        refreshRef.current();
      }, PAYMENT_AREA_FOCUS_REFRESH_DELAY_MS);
    };
    window.addEventListener('focus', onFocus);
    return (): void => {
      window.removeEventListener('focus', onFocus);
      if (timer !== null) clearTimeout(timer);
    };
  }, [opened]);

  const value = useMemo<PaymentAreaState>(
    () => ({
      mode,
      owner,
      canManage,
      unavailable,
      pending,
      outcome,
      start,
      retry,
      checkAgain,
      openOnWeb,
    }),
    [
      canManage,
      checkAgain,
      mode,
      openOnWeb,
      outcome,
      owner,
      pending,
      retry,
      start,
      unavailable,
    ],
  );

  return (
    <PaymentAreaContext.Provider value={value}>
      {children}
    </PaymentAreaContext.Provider>
  );
}

function usePaymentArea(): PaymentAreaState {
  const area = useContext(PaymentAreaContext);
  if (area === null)
    throw new Error('Payment CTAs must render inside a <PaymentArea>.');
  return area;
}

/* -------------------------------------------------------------------------- */
/* CTAs and status                                                            */
/* -------------------------------------------------------------------------- */

export interface PaymentAreaCtaProps {
  readonly action: PaymentAreaAction;
  /** The host's inline UI for this CTA (web billing slots), when inline. */
  readonly inline?: ReactNode;
  /** Payment-method CTAs read "Manage payment method" when a card exists. */
  readonly hasCard?: boolean;
  readonly testId: string;
}

/**
 * One payment CTA. Inline hosts get their inline UI; handoff hosts get a
 * button that opens the owner's web billing page with this action's modal.
 * Viewers who may not manage payments get nothing.
 */
export function PaymentAreaCta({
  action,
  inline,
  hasCard,
  testId,
}: PaymentAreaCtaProps): JSX.Element | null {
  const area = usePaymentArea();
  if (area.mode.kind === 'inline') return <>{inline ?? null}</>;
  if (!area.canManage) return null;
  const busy = area.pending === action;
  return (
    <Button
      size="compact"
      disabled={area.unavailable || area.pending !== null}
      aria-busy={busy}
      onClick={() => area.start(action, paymentAreaHandoffIntent(action))}
      data-testid={testId}
    >
      {busy ? 'Opening…' : paymentAreaActionLabel(action, { hasCard })}
    </Button>
  );
}

/**
 * The payment area's status line on handoff hosts: "Open on web" while the
 * handoff is unavailable, "Continue in your browser." with "Check again"
 * once the browser opened, or the failure copy with "Try again". Renders
 * nothing before a handoff starts, on inline hosts, or for viewers who may
 * not manage payments.
 */
export function PaymentAreaNotice({
  testId,
}: {
  readonly testId: string;
}): JSX.Element | null {
  const area = usePaymentArea();
  if (area.mode.kind === 'inline' || !area.canManage) return null;

  let message: string;
  let action: JSX.Element;
  let tone = 'fg-secondary';
  if (area.unavailable) {
    message = PAYMENT_HANDOFF_UNAVAILABLE_COPY;
    action = (
      <Button
        size="compact"
        onClick={area.openOnWeb}
        data-testid={`${testId}-open-on-web`}
      >
        Open on web
      </Button>
    );
  } else if (area.outcome?.kind === 'opened') {
    message = PAYMENT_HANDOFF_OPENED_COPY;
    action = (
      <Button
        size="compact"
        onClick={area.checkAgain}
        data-testid={`${testId}-check-again`}
      >
        Check again
      </Button>
    );
  } else if (area.outcome?.kind === 'failed') {
    message =
      area.outcome.reason === 'browser_failed'
        ? PAYMENT_HANDOFF_BROWSER_FAILED_COPY
        : PAYMENT_HANDOFF_FAILED_COPY;
    tone = 'fg-destructive';
    action = (
      <Button
        size="compact"
        onClick={area.retry}
        disabled={area.pending !== null}
        data-testid={`${testId}-try-again`}
      >
        Try again
      </Button>
    );
  } else {
    return null;
  }

  return (
    <PaymentHandoffNotice testId={testId}>
      <p className={`min-w-0 text-s ${tone}`} data-testid={`${testId}-message`}>
        {message}
      </p>
      {action}
    </PaymentHandoffNotice>
  );
}
