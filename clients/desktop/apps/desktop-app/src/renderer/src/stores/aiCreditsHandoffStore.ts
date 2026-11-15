import {
  CREDITS_HANDOFF_MAX_AGE_MS,
  createCreditsCoverageProbe,
  createCreditsPurchaseStore,
  selectCreditsHandoff,
  type BeginCreditsHandoffInput,
  type CreditsAccountIdentity,
  type CreditsHandoffRecord,
  type CreditsPurchaseState,
} from '@canopy/app-state/billing/credits';
import type {
  AiCreditsScopeRequest,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import type { AiCreditsCheckFeedbackKind } from '@canopy/ui-shared';
import { desktopCreditsAccountIdentityReader } from '@/lib/aiCreditsAccountIdentity';
import type { AiCreditsArrivalOrigin } from '@/lib/aiCreditsArrivalConfirmation';
import {
  openBillingPage,
  type OpenBillingPageOptions,
} from '@/lib/openBillingPage';

/**
 * The desktop's AI Credits purchase state (CAN-5534): this renderer's
 * instance of the shared wallet-keyed purchase store, for the renderer
 * session only. It survives remounts, hidden banners and navigation, never
 * an app reload. The lifecycle rules live with the store in
 * `@canopy/app-state/billing/credits`; this module binds the desktop's
 * account bridge and billing hand-off and keeps the names chat surfaces use.
 */

/** Fixed lifetime from the successful browser open. Nothing extends it. */
export const AI_CREDITS_HANDOFF_MAX_AGE_MS = CREDITS_HANDOFF_MAX_AGE_MS;

export type AiCreditsHandoffRecord =
  CreditsHandoffRecord<AiCreditsArrivalOrigin>;

/** One billing hand-off: the desktop's current `openBillingPage` call. */
export interface AiCreditsHandoffOpenRequest {
  readonly availability: NativeAiCreditsAvailability | null;
  readonly scope: AiCreditsScopeRequest | undefined;
  readonly options: OpenBillingPageOptions;
}

export const aiCreditsPurchaseStore = createCreditsPurchaseStore<
  AiCreditsArrivalOrigin,
  AiCreditsHandoffOpenRequest
>({
  accountIdentityReader: desktopCreditsAccountIdentityReader,
  openHandoff: (request) =>
    openBillingPage(request.availability, request.scope, request.options),
});

/**
 * The post-purchase re-probe throttle, shared by every mounted purchase
 * action in this renderer (§5).
 */
export const aiCreditsCoverageProbe =
  createCreditsCoverageProbe<NativeAiCreditsAvailability>();

export const useAiCreditsHandoffStore = aiCreditsPurchaseStore.useStore;

export function expireAiCreditsHandoffs(now?: number): void {
  aiCreditsPurchaseStore.expire(now);
}

/** The pending hand-off for a purchase scope, or `null`. */
export function selectAiCreditsHandoff(
  state: CreditsPurchaseState<AiCreditsArrivalOrigin>,
  walletKey: string | null,
): AiCreditsHandoffRecord | null {
  return selectCreditsHandoff(state, walletKey);
}

export function isAiCreditsHandoffCurrent(
  walletKey: string,
  id: string,
  accountGeneration: number,
): boolean {
  return aiCreditsPurchaseStore.isCurrent(walletKey, id, accountGeneration);
}

export function hasAiCreditsHandoffs(): boolean {
  return aiCreditsPurchaseStore.hasHandoffs();
}

export function claimAiCreditsHandoffOpening(walletKey: string): object | null {
  return aiCreditsPurchaseStore.claimOpening(walletKey);
}

export function releaseAiCreditsHandoffOpening(
  walletKey: string,
  token: object,
): void {
  aiCreditsPurchaseStore.releaseOpening(walletKey, token);
}

export type BeginAiCreditsHandoffInput =
  BeginCreditsHandoffInput<AiCreditsArrivalOrigin>;

export function beginAiCreditsHandoff(
  input: BeginAiCreditsHandoffInput,
): AiCreditsHandoffRecord | null {
  return aiCreditsPurchaseStore.begin(input);
}

export function setAiCreditsHandoffFeedback(
  walletKey: string,
  id: string,
  accountGeneration: number,
  feedback: AiCreditsCheckFeedbackKind | null,
): void {
  aiCreditsPurchaseStore.setFeedback(
    walletKey,
    id,
    accountGeneration,
    feedback,
  );
}

export function completeAiCreditsHandoff(
  walletKey: string,
  id: string,
  accountGeneration: number,
): boolean {
  return aiCreditsPurchaseStore.complete(walletKey, id, accountGeneration);
}

export function endAiCreditsHandoff(
  walletKey: string,
  id: string,
  accountGeneration: number,
): void {
  aiCreditsPurchaseStore.end(walletKey, id, accountGeneration);
}

export function suspendAiCreditsHandoffAccount(): void {
  aiCreditsPurchaseStore.suspendAccount();
}

/** What a root-level account re-read found. */
export type AiCreditsHandoffAccountIdentity = CreditsAccountIdentity;

export function reconcileAiCreditsHandoffAccount(
  identity: AiCreditsHandoffAccountIdentity,
): void {
  aiCreditsPurchaseStore.reconcileAccount(identity);
}
