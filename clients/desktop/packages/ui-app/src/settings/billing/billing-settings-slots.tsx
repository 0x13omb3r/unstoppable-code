'use client';

import {
  createContext,
  useContext,
  type ComponentType,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  BillingTopUpIntent,
  SettingsPaymentOwner,
} from '@canopy/protocol/billing';
import type {
  BillingSummaryPaymentMethod,
  CreditsAutoTopUpSettings,
  PaymentMethodSummary,
} from '@canopy/protocol/settings/billing';

/**
 * Web-only billing UI the shared billing sections render inline.
 *
 * Card entry, Stripe, checkout, card deletion, the automatic top-up editor,
 * and the billing page's one-shot payment intents stay
 * in `apps/web`. A web billing route mounts a provider that supplies them;
 * hosts without inline checkout (desktop) mount none, and the shared sections
 * render the payment handoff from `PaymentArea` instead. A section never
 * renders a missing slot and never asks which host it runs in.
 */

/**
 * Which modal a billing page opens on arrival, from its URL intent. The
 * retired `subscription` intent that shipped builds still send never reaches
 * here: the URL parser reads it as no intent.
 */
export type BillingSettingsIntentTarget =
  | { readonly kind: 'top-up'; readonly intent: BillingTopUpIntent }
  | { readonly kind: 'payment-method'; readonly requestId: string }
  | { readonly kind: 'auto-top-up'; readonly requestId: string };

/** Reads the page's top-up and payment modal intents once. Renders nothing. */
export interface BillingIntentControllerSlotProps {
  /** The signed-in viewer, or `null` while unknown. */
  readonly viewerId: string | null;
  /** The wallet this page renders; never inferred. */
  readonly owner: SettingsPaymentOwner;
  /** Whether the viewer may manage this wallet's billing; `null` while unknown. */
  readonly canManageBilling: boolean | null;
  /** Whether the data the target modals need has finished loading. */
  readonly dataReady: boolean;
  /** Called at most once, with the modal the page should open. */
  readonly onTarget: (target: BillingSettingsIntentTarget) => void;
}

/** Live `credit.pool` signals for a wallet. Renders nothing. */
export interface CreditPoolSubscriptionSlotProps {
  /** Omit for the personal wallet. */
  readonly organizationId?: string;
  readonly onSignal: () => void;
  readonly onReconnect: () => void;
}

/** The personal saved card's Add / Edit / Delete affordances and their dialogs. */
export interface PersonalPaymentMethodActionsSlotProps {
  readonly paymentMethod: BillingSummaryPaymentMethod | null;
  readonly onCardMutated: () => void;
  /** Opens the add / replace card modal once per new request id. */
  readonly openRequestId: string | null;
}

/** Pieces of the organization saved-card affordances, placed by the subcard. */
export interface OrganizationPaymentMethodActionsParts {
  /** Add / Edit / Delete buttons, beside the card summary. */
  readonly actions: ReactNode;
  /** Error line and dialogs, below the summary row. */
  readonly after: ReactNode;
}

export interface OrganizationPaymentMethodActionsSlotProps {
  readonly organizationId: string;
  /** Whether a card is on file. */
  readonly hasCard: boolean;
  /** `Visa ····4242`-style label for the delete confirmation, when known. */
  readonly cardLabel: string | null;
  readonly onSaved: (summary: PaymentMethodSummary) => void;
  readonly onRemoved: () => void;
  readonly openRequestId: string | null;
  readonly children: (
    parts: OrganizationPaymentMethodActionsParts,
  ) => ReactNode;
}

/**
 * The "Buy AI Credits" affordance, placed by the credits card. Its checkout is
 * the purchase provider's one sheet, so the card places no dialog.
 */
export interface CreditsTopUpParts {
  readonly trigger: ReactNode;
}

export interface CreditsTopUpSlotProps {
  readonly owner: SettingsPaymentOwner;
  readonly creditPriceUsd?: number;
  readonly onToppedUp: () => void;
  readonly testIdPrefix: string;
  readonly variant: 'primary' | 'secondary';
  /** The top-up intent this page was opened with, or `null`. */
  readonly intent: BillingTopUpIntent | null;
  readonly refreshSignal?: number;
  readonly children: (parts: CreditsTopUpParts) => ReactNode;
}

/** The automatic top-up switch, summary and "Adjust" editor. */
export interface AutoTopUpControlsSlotProps {
  readonly owner: SettingsPaymentOwner;
  readonly settings: CreditsAutoTopUpSettings;
  readonly monthlySpentUsd: number;
  readonly monthlyResetAt: string;
  readonly canManage: boolean;
  /** Refresh after a saved change; the slot owns the mutation itself. */
  readonly onSaved: () => Promise<void>;
  readonly brandName: string;
  readonly orgVariant?: boolean;
  readonly testIdPrefix?: string;
  /** Opens the "Adjust" editor once per new request id. */
  readonly openAdjustRequestId: string | null;
}

export interface BillingSettingsSlots {
  /** Stripe publishable key, or `null` when card capture is unconfigured. */
  readonly publishableKey: string | null;
  readonly IntentController: ComponentType<BillingIntentControllerSlotProps>;
  readonly CreditPoolSubscription: ComponentType<CreditPoolSubscriptionSlotProps>;
  readonly PersonalPaymentMethodActions: ComponentType<PersonalPaymentMethodActionsSlotProps>;
  readonly OrganizationPaymentMethodActions: ComponentType<OrganizationPaymentMethodActionsSlotProps>;
  readonly CreditsTopUp: ComponentType<CreditsTopUpSlotProps>;
  readonly AutoTopUpControls: ComponentType<AutoTopUpControlsSlotProps>;
}

const BillingSettingsSlotsContext = createContext<BillingSettingsSlots | null>(
  null,
);

export function BillingSettingsSlotsProvider({
  slots,
  children,
}: {
  readonly slots: BillingSettingsSlots;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <BillingSettingsSlotsContext.Provider value={slots}>
      {children}
    </BillingSettingsSlotsContext.Provider>
  );
}

/** The host's inline billing UI, or `null` when none is mounted. */
export function useBillingSettingsSlots(): BillingSettingsSlots | null {
  return useContext(BillingSettingsSlotsContext);
}
