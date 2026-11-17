'use client';

import {
  useCallback,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  BillingHistoryTable as SharedBillingHistoryTable,
  BusyLabel,
  Button,
  CreditLedgerTable as SharedCreditLedgerTable,
  EMPTY_CREDIT_POOL_COPY,
  EmptyState,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { formatCardLabel, formatExpiry } from '@canopy/ui-shared/lib';
import type { AiCreditsLedgerEntry } from '@canopy/protocol';
import type { SettingsPaymentOwner } from '@canopy/protocol/billing';
import type {
  ChargeHistoryItem,
  CreditsSummary,
  InvoicePage,
  PaymentMethodSummary,
} from '@canopy/protocol/settings/billing';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { formatPlanDate } from '@canopy/protocol/settings/plan-display';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  BillingCardBodySkeleton,
  BillingTransactionsSkeleton,
} from './billing-card-body-skeleton';
import { InvoicesSection, INVOICES_PAGE_LIMIT } from './invoices-section';
import { WalletAutoTopUp } from './auto-top-up-summary';
import { BalanceSurface } from '../../credits/BalanceSurface';
import {
  useBillingSettingsSlots,
  type BillingSettingsIntentTarget,
} from './billing-settings-slots';
import { SettingsCreditPoolSubscription } from './settings-credit-pool-subscription';
import {
  PaymentArea,
  PaymentAreaCta,
  PaymentAreaNotice,
  paymentCaptureAvailable,
  usePaymentAreaMode,
} from './PaymentArea';
import {
  useSettingsBrand,
  useSettingsClient,
  useSettingsPrivacy,
  useSettingsWorkspaceContext,
} from '../host';
import { useSettingsLoadFailure } from '../errors';
import { withPrivacyClass } from '../account/privacy-class';
import {
  getCreditsBalance,
  getCreditsLedger,
  getOrgBillingSummary,
  getOrgChargeHistory,
  getOrgInvoices,
} from '../organization/team-api';
import type { SettingsFailure } from '../errors';
import { Divider } from '@canopy/ui-shared/components';

interface TeamBillingSectionProps {
  detail: OrganizationDetail;
  /** Invalidate page and persistent navigation after a successful mutation. */
  onBillingChanged?: () => void;
}

/** Normalized default-card shape shared by the summary + confirm responses. */
interface CardDisplay {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * Org "AI Credits" subtab, rendered as two sibling first-level cards: "AI
 * credit pool" and "Billing history", which hosts the saved payment method as
 * a genuine subcard. Each carries the icon + title + subtitle shell its peers
 * on the other Settings subtabs use.
 *
 * OWNER can add or replace the payment method; ADMIN sees a read-only summary.
 * The billing-history card (and its payment method) is hidden when empty — no
 * Stripe key, no card, no charges.
 */
export function TeamBillingSection({
  detail,
  onBillingChanged,
}: TeamBillingSectionProps): JSX.Element {
  const orgId = detail.id;
  const isOwner = detail.viewerRole === 'OWNER';
  const client = useSettingsClient();
  const slots = useBillingSettingsSlots();
  const paymentMode = usePaymentAreaMode();
  // Card capture is possible inline (Stripe configured) or through the web
  // handoff; this replaces the old "Stripe key present" predicate.
  const paymentsAvailable = paymentCaptureAvailable(paymentMode);
  const brandName = useSettingsBrand().displayName;
  const viewerId = useSettingsWorkspaceContext().accountKey;
  // The one-shot top-up or payment modal intent this page was opened with,
  // read by the host's intent controller once the summary has loaded.
  const [intentTarget, setIntentTarget] =
    useState<BillingSettingsIntentTarget | null>(null);
  const owner = useOrganizationOwner(orgId);

  const [card, setCard] = useState<CardDisplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [creditsReloadSignal, setCreditsReloadSignal] = useState(0);
  const [historyReloadSignal, setHistoryReloadSignal] = useState(0);
  const loadError = useSettingsLoadFailure('billing:organization-summary');

  const loadSummary = useCallback(
    async (options?: { silent?: boolean }): Promise<void> => {
      if (!options?.silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const next = await getOrgBillingSummary(client, orgId);
        setCard(next.paymentMethod);
      } catch (err) {
        setError(loadError(err));
      } finally {
        setLoading(false);
      }
    },
    [client, orgId, loadError],
  );

  // Initial load / reload on org switch. Genuine external sync whose success
  // path calls setState (see the `set-state-in-effect` rule note).
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const handleCardSaved = (next: PaymentMethodSummary): void => {
    // Optimistically show the freshly saved card, then reload the full summary
    // so it stays consistent with the new payment method.
    setCard(next);
    onBillingChanged?.();
    void loadSummary();
  };

  const handleCardRemoved = (): void => {
    // Optimistically clear the card, then reload so it stays consistent with
    // the removed payment method.
    setCard(null);
    onBillingChanged?.();
    void loadSummary();
  };

  /** "Check again" and browser return: re-read card, pool and history. */
  const refreshAuthoritative = useCallback((): void => {
    void loadSummary({ silent: true });
    setCreditsReloadSignal((current) => current + 1);
    setHistoryReloadSignal((current) => current + 1);
  }, [loadSummary]);

  // A payment-method intent opens the owner's card modal. A retired
  // subscription intent (sent by shipped builds) opens nothing.
  const openCardRequestId =
    isOwner && intentTarget?.kind === 'payment-method'
      ? intentTarget.requestId
      : null;

  // A plain stack, not a card: the cards below are first-level cards with the
  // same icon + title + subtitle shell their peers use, so `gap-6` here matches
  // the spacing the settings container gives sibling cards elsewhere.
  return (
    <PaymentArea
      owner={owner}
      canManage={isOwner}
      refresh={refreshAuthoritative}
    >
      <div className="flex flex-col gap-6" data-testid="team-billing-section">
        {slots !== null ? (
          <slots.IntentController
            viewerId={viewerId}
            owner={owner}
            canManageBilling={isOwner}
            dataReady={!loading}
            onTarget={setIntentTarget}
          />
        ) : null}
        <PaymentAreaNotice testId="team-billing-payment-handoff" />
        {/* Empty `className` on purpose: the default is `mb-4`, which would stack
            on top of the wrapper's `gap-6` and leave a lopsided gutter under the
            banner. */}
        <ErrorBanner
          errorSource="team-billing-load"
          className=""
          error={error?.copy}
          details={error?.details}
          onRetry={() => void loadSummary()}
        />

        <AiCreditPoolCard
          orgId={orgId}
          owner={owner}
          isOwner={isOwner}
          brandName={brandName}
          intentTarget={intentTarget}
          reloadSignal={creditsReloadSignal}
        />
        <BillingHistoryCard
          orgId={orgId}
          isOwner={isOwner}
          card={card}
          paymentsAvailable={paymentsAvailable}
          onSaved={handleCardSaved}
          onRemoved={handleCardRemoved}
          openCardRequestId={openCardRequestId}
          reloadSignal={historyReloadSignal}
        />
      </div>
    </PaymentArea>
  );
}

/** A stable explicit owner for this organization's wallet. */
function useOrganizationOwner(orgId: string): SettingsPaymentOwner {
  const [owner, setOwner] = useState<SettingsPaymentOwner>(() => ({
    kind: 'organization',
    organizationId: orgId,
  }));
  if (owner.kind !== 'organization' || owner.organizationId !== orgId) {
    setOwner({ kind: 'organization', organizationId: orgId });
  }
  return owner;
}

interface PaymentMethodSubcardProps {
  orgId: string;
  isOwner: boolean;
  card: CardDisplay | null;
  paymentsAvailable: boolean;
  onSaved: (summary: PaymentMethodSummary) => void;
  onRemoved: () => void;
  openCardRequestId: string | null;
}

/**
 * A `Visa ····4242` label, or a neutral fallback when the brand/last4 are not
 * both present (e.g. a non-card PM). Mirrors the account-page card formatting.
 */
function cardLabel(card: CardDisplay): string {
  if (card.brand && card.last4) {
    return formatCardLabel(card.brand, card.last4);
  }
  return card.last4 ? `···· ${card.last4}` : 'Card on file';
}

/**
 * The saved-card subcard rendered inside the billing-history card (a `bg-muted`
 * block alongside the USD charge history, mirroring the individual page's
 * `SavedCardSection`). OWNER can add a card (primary CTA) or Edit / Delete the
 * card on file via the icon affordances; Add/Edit open the shared themed capture
 * modal, and Delete confirms first. Non-owners (and environments without a Stripe
 * publishable key) see the card read-only.
 */
function PaymentMethodSubcard({
  orgId,
  isOwner,
  card,
  paymentsAvailable,
  onSaved,
  onRemoved,
  openCardRequestId,
}: PaymentMethodSubcardProps): JSX.Element {
  const slots = useBillingSettingsSlots();
  const paymentMode = usePaymentAreaMode();
  const { blockClassName } = useSettingsPrivacy();
  const hasCard = card !== null && card.last4 !== null;
  const canManage = isOwner && paymentsAvailable;

  const layout = (actions: ReactNode, after: ReactNode): JSX.Element => (
    <div>
      <div className="pb-4" data-testid="team-billing-payment-method-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-s font-medium fg-primary">Payment method</p>
            {hasCard && card ? (
              <p
                className={withPrivacyClass(
                  'pt-1 text-s fg-primary',
                  blockClassName,
                )}
                data-testid="team-billing-card-summary"
              >
                {cardLabel(card)}
                {card.expMonth !== null && card.expYear !== null
                  ? `, exp ${formatExpiry(card.expMonth, card.expYear)}`
                  : ''}
              </p>
            ) : (
              <p className="pt-1 text-s fg-secondary">No card on file.</p>
            )}
          </div>

          {actions}
        </div>

        {after}
      </div>
      <Divider />
    </div>
  );

  if (!canManage) return layout(null, null);
  if (paymentMode.kind === 'handoff') {
    return layout(
      <PaymentAreaCta
        action="payment-method"
        hasCard={hasCard}
        testId="team-billing-manage-payment-method"
      />,
      null,
    );
  }
  if (slots === null) return layout(null, null);
  return (
    <slots.OrganizationPaymentMethodActions
      organizationId={orgId}
      hasCard={hasCard}
      cardLabel={card ? cardLabel(card) : null}
      onSaved={onSaved}
      onRemoved={onRemoved}
      openRequestId={openCardRequestId}
    >
      {({ actions, after }) => layout(actions, after)}
    </slots.OrganizationPaymentMethodActions>
  );
}

interface BillingHistoryCardProps {
  orgId: string;
  isOwner: boolean;
  card: CardDisplay | null;
  paymentsAvailable: boolean;
  onSaved: (summary: PaymentMethodSummary) => void;
  onRemoved: () => void;
  /** Opens the owner's card modal once (a payment-method intent). */
  openCardRequestId: string | null;
  /** Bumped by "Check again" and browser return: reload the first page. */
  reloadSignal: number;
}

/**
 * The grouped billing-history card: the saved payment method as a `bg-muted`
 * subcard, then the USD transactions table under a "Transactions" subheader. The
 * whole card is hidden unless it has real value — a card on file, at least one
 * charge, or an error. A configured Stripe key alone does NOT force it to show,
 * so an org that has never billed (no card, no charges) shows nothing
 * here; the first card is added via the credit top-up flow.
 */
function BillingHistoryCard({
  orgId,
  isOwner,
  card,
  paymentsAvailable,
  onSaved,
  onRemoved,
  openCardRequestId,
  reloadSignal,
}: BillingHistoryCardProps): JSX.Element {
  const client = useSettingsClient();
  const [charges, setCharges] = useState<ChargeHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // The page whose read failed, so Retry repeats that read: the first page,
  // or the "Load more" page after it.
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const loadError = useSettingsLoadFailure('billing:organization-history');

  const loadPage = useCallback(
    async (cursor: string | null): Promise<void> => {
      if (cursor === null) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        const page = await getOrgChargeHistory(
          client,
          orgId,
          cursor === null ? {} : { cursor },
        );
        setCharges((prev) =>
          cursor === null ? page.charges : [...prev, ...page.charges],
        );
        setNextCursor(page.nextCursor);
      } catch (err) {
        setFailedCursor(cursor);
        setError(loadError(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [client, orgId, loadError],
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage, reloadSignal]);

  // Invoices own their paging state inside `InvoicesSection`; this card only
  // supplies the org-scoped fetcher and href builder. Both are memoized on
  // `orgId` so the section's first-page effect does not refire every render.
  const loadInvoicePage = useCallback(
    (cursor: string | null): Promise<InvoicePage> =>
      getOrgInvoices(client, orgId, { limit: INVOICES_PAGE_LIMIT, cursor }),
    [client, orgId],
  );
  const invoiceHref = useCallback(
    (invoice: { id: string }): string =>
      `/organization/${encodeURIComponent(orgId)}/billing/invoices/${encodeURIComponent(invoice.id)}`,
    [orgId],
  );

  const hasCard = card !== null && card.last4 !== null;
  const showTransactions = charges.length > 0;
  // Only show this card when it carries real value: a card on file, at least one
  // charge, or an error. A configured Stripe key alone is NOT enough — an org
  // that has never billed (no card, no charges) shows nothing here rather
  // than an empty "Add card" shell, since the first card is captured by the
  // credit top-up flow. While the first charge page is still
  // loading we can't yet know it's empty, so the card simply stays hidden until
  // content is confirmed instead of flashing a placeholder.
  // A card intent shows the card even when it is otherwise empty, so the modal
  // opens from its own subcard.
  const showCard =
    hasCard ||
    showTransactions ||
    error !== null ||
    (openCardRequestId !== null && paymentsAvailable);
  // When the card is shown, still surface the payment subcard so a card can be
  // managed or (re)added alongside existing history.
  const showPaymentSubcard = paymentsAvailable || hasCard;

  if (!showCard) {
    return <></>;
  }

  return (
    <SettingsCard
      title="Billing history"
      subtitle="Past payments and receipts for this organization, in USD."
      testId="team-billing-history-card"
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner
          errorSource="billing-history-card"
          className=""
          error={error?.copy}
          details={error?.details}
          onRetry={() => void loadPage(failedCursor)}
        />

        {showPaymentSubcard ? (
          <PaymentMethodSubcard
            orgId={orgId}
            isOwner={isOwner}
            card={card}
            paymentsAvailable={paymentsAvailable}
            onSaved={onSaved}
            onRemoved={onRemoved}
            openCardRequestId={openCardRequestId}
          />
        ) : null}

        <InvoicesSection
          loadPage={loadInvoicePage}
          hrefFor={invoiceHref}
          testId="team-billing-invoices"
        />

        {loading && !showTransactions ? (
          <BillingTransactionsSkeleton />
        ) : showTransactions ? (
          <div data-testid="team-billing-transactions">
            <p className="text-s font-medium fg-primary">Transactions</p>
            <div className="pt-2">
              <SharedBillingHistoryTable
                charges={charges}
                formatDate={formatPlanDate}
              />
            </div>
            {nextCursor !== null ? (
              <div className="pt-3 empty:hidden">
                <Button
                  size="compact"
                  disabled={loadingMore}
                  aria-busy={loadingMore}
                  onClick={() => void loadPage(nextCursor)}
                  data-testid="team-billing-history-load-more"
                >
                  <BusyLabel busy={loadingMore}>Load more</BusyLabel>
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}

/* -------------------------------------------------------------------------- */
/* AiCreditPoolCard — org shared credit pool (CAN-1040 / T17)                 */
/* -------------------------------------------------------------------------- */

/**
 * The pool's subtitle. A turn spends the member's own wallet first and then
 * the pool of the organization that owns the work (CAN-3463).
 */
const POOL_SUBTITLE =
  "Shared AI Credits for this organization's work, used after a member's own run out.";

/**
 * The org "AI Credits pool" card. Self-loads the org {@link CreditsSummary} plus
 * the first ledger page, then renders the pool balance, the credit ledger, and (for OWNER) a manual "Buy AI Credits" button. Both OWNER
 * and ADMIN see the shared {@link AutoTopUpControls}: OWNER can manage it, ADMIN
 * sees it read-only (`canManage=false` → disabled toggle, no "Adjust limit", no
 * top-up). MEMBER never reaches this tab.
 */
function AiCreditPoolCard({
  orgId,
  owner,
  isOwner,
  brandName,
  intentTarget,
  reloadSignal,
}: {
  orgId: string;
  owner: SettingsPaymentOwner;
  isOwner: boolean;
  brandName: string;
  /** The page's top-up or automatic top-up intent, once read. */
  intentTarget: BillingSettingsIntentTarget | null;
  /** Bumped by "Check again" and browser return: reload silently. */
  reloadSignal: number;
}): JSX.Element {
  const client = useSettingsClient();
  const slots = useBillingSettingsSlots();
  const paymentMode = usePaymentAreaMode();
  const [summary, setSummary] = useState<CreditsSummary | null>(null);
  const [entries, setEntries] = useState<AiCreditsLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const loadError = useSettingsLoadFailure('billing:organization-credits');

  const load = useCallback(
    async (options?: { silent?: boolean }): Promise<void> => {
      // A `silent` refresh (realtime signal / post-purchase) refetches in place
      // without flashing the loading skeleton over the already-rendered pool.
      if (!options?.silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const [nextSummary, ledger] = await Promise.all([
          getCreditsBalance(client, orgId),
          getCreditsLedger(client, orgId),
        ]);
        setSummary(nextSummary);
        setEntries(ledger.entries);
      } catch (err) {
        setError(loadError(err));
      } finally {
        setLoading(false);
      }
    },
    [client, orgId, loadError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // "Check again" and browser return re-read the authoritative pool.
  useEffect(() => {
    if (reloadSignal === 0) return;
    void load({ silent: true });
  }, [load, reloadSignal]);

  // The credit top-up grant lands asynchronously on the Stripe webhook, so the
  // immediate refetch after "Buy AI Credits" usually races (and loses to) the
  // webhook. Subscribe to `credit.pool` signals so the pool updates live the
  // moment the webhook grants the credits; a signal (or a post-error reconnect)
  // triggers a silent refetch of the authoritative balance + ledger. When the
  // realtime stream is gated off the subscription reports `disabled` and the
  // manual/post-purchase refetch remains the fallback — never worse than before.
  // A signal is also the only hint an open checkout gets that a processing
  // payment settled or the model library unlocked. It is passed on as a
  // counter: a reason to read again, never the answer.
  const [checkoutRefreshSignal, setCheckoutRefreshSignal] = useState(0);
  const refreshFromSignal = useCallback((): void => {
    void load({ silent: true });
    setCheckoutRefreshSignal((current) => current + 1);
  }, [load]);
  // Without inline billing UI (desktop), the host's settings client carries
  // the same signals.
  const creditPoolSubscription =
    slots !== null ? (
      <slots.CreditPoolSubscription
        organizationId={orgId}
        onSignal={refreshFromSignal}
        onReconnect={refreshFromSignal}
      />
    ) : (
      <SettingsCreditPoolSubscription
        organizationId={orgId}
        onSignal={refreshFromSignal}
        onReconnect={refreshFromSignal}
      />
    );

  const reloadAfterAutoTopUp = useCallback((): Promise<void> => load(), [load]);

  // "Not set up yet" vs. "drained to zero after setup": a pool that has never
  // seen a single ledger entry has genuinely never been funded, so it gets the
  // welcoming empty state. Once any credit has been purchased/granted/used the
  // ledger is non-empty, so a balance that later returns to $0 keeps the normal
  // balance + activity view instead of reverting to the empty state.
  const neverFunded =
    summary !== null && summary.balanceCredits === 0 && entries.length === 0;

  // The purchase control; the card shows it only to a viewer who funds the
  // pool.
  const renderCard = (purchase: ReactNode): JSX.Element => (
    <SettingsCard
      title="AI Credits pool"
      subtitle={POOL_SUBTITLE}
      testId="team-billing-ai-credits"
    >
      <>
        {/* Default `mb-4` kept: the banner sits above the body content and
            owns the gutter below itself, since the card body wrapper already
            supplies the gutter above. */}
        <ErrorBanner
          errorSource="team-billing-change-payment"
          error={error?.copy}
          details={error?.details}
          onRetry={() => void load()}
        />

        {loading ? (
          <BillingCardBodySkeleton />
        ) : summary === null ? (
          <p className="text-s fg-secondary">
            No AI Credits details available.
          </p>
        ) : (
          <BalanceSurface
            density="card"
            summary={summary}
            owner={{ kind: 'organization', canFund: isOwner }}
            purchase={purchase}
            testIdPrefix="team-"
            empty={
              neverFunded
                ? {
                    title: EMPTY_CREDIT_POOL_COPY.title,
                    subtitle: EMPTY_CREDIT_POOL_COPY.message,
                  }
                : undefined
            }
            autoTopUp={
              <WalletAutoTopUp
                owner={owner}
                summary={summary}
                canManage={isOwner}
                onSaved={reloadAfterAutoTopUp}
                brandName={brandName}
                orgVariant
                testIdPrefix="team-"
                openAdjustRequestId={
                  intentTarget?.kind === 'auto-top-up'
                    ? intentTarget.requestId
                    : null
                }
              />
            }
          >
            <div className="pt-4" data-testid="team-billing-ai-credits-ledger">
              <p className="text-s font-medium fg-primary">Activity</p>
              {entries.length === 0 ? (
                <EmptyState
                  title="No activity yet."
                  subtitle="Purchases and usage appear here once the pool is active."
                />
              ) : (
                <div className="pt-2">
                  <SharedCreditLedgerTable
                    entries={entries}
                    formatDate={formatPlanDate}
                  />
                </div>
              )}
            </div>
          </BalanceSurface>
        )}
      </>
    </SettingsCard>
  );

  if (paymentMode.kind === 'handoff') {
    return (
      <>
        {creditPoolSubscription}
        {renderCard(
          <PaymentAreaCta
            action="top-up"
            testId="team-billing-buy-credits-handoff"
          />,
        )}
      </>
    );
  }
  if (slots === null) return renderCard(null);

  // The trigger moves between the empty state and the balance row, and the
  // card swaps to its skeleton on a full reload. The checkout is the purchase
  // provider's sheet, which none of that moves.
  return (
    <>
      {creditPoolSubscription}
      <slots.CreditsTopUp
        owner={owner}
        creditPriceUsd={summary?.creditPriceUsd}
        onToppedUp={() => void load({ silent: true })}
        testIdPrefix="team-"
        variant="secondary"
        intent={
          isOwner && intentTarget?.kind === 'top-up'
            ? intentTarget.intent
            : null
        }
        refreshSignal={checkoutRefreshSignal}
      >
        {({ trigger }) => renderCard(trigger)}
      </slots.CreditsTopUp>
    </>
  );
}
