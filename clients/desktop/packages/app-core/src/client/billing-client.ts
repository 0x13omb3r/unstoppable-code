import type {
  BillingPaymentMethodSummary,
  BillingTopUpResponse,
  ModelLibraryUnlockSource,
} from '@canopy/protocol/billing';
import type {
  SettingsPaymentHandoffAvailability,
  SettingsPaymentHandoffRequest,
  SettingsPaymentHandoffResult,
} from '@canopy/protocol/settings/payment-handoff';

/** Host-bound billing operations. Server authorization remains authoritative. */
export interface BillingClient {
  createSetupIntent(input?: {
    orgId?: string;
  }): Promise<{ clientSecret: string }>;
  confirmPaymentMethod(
    setupIntentId: string,
    input?: { orgId?: string },
  ): Promise<BillingPaymentMethodSummary>;
  topUp(input: {
    amountUsd: number;
    requestId: string;
    source?: ModelLibraryUnlockSource;
    /** Explicit organization wallet; omission selects the personal wallet. */
    orgId?: string;
  }): Promise<BillingTopUpResponse>;
  getFeePercent(): Promise<number>;
}

/**
 * An AI Credits purchase handed off to the owner's web billing page, with
 * the intended top-up or modal already open.
 */
export interface CreditsHandoffRequest extends SettingsPaymentHandoffRequest {
  /**
   * The signed-in account the caller acts for. When it is no longer the
   * host's account the hand-off does not open. Omitted, the host uses the
   * account signed in now.
   */
  readonly accountId?: string;
}

/**
 * The host's AI Credits hand-off: billing opens outside the app, signed in,
 * and the host reports where it went. Present only on hosts that hand
 * purchases off; hosts with inline checkout use {@link BillingClient}.
 * Neither method rejects: a transport failure is a failed open or an
 * unavailable hand-off.
 */
export interface CreditsHandoffClient {
  open(request: CreditsHandoffRequest): Promise<SettingsPaymentHandoffResult>;
  /** Whether a hand-off can open right now for this account. */
  availability(request?: {
    readonly accountId?: string;
  }): Promise<SettingsPaymentHandoffAvailability>;
}
