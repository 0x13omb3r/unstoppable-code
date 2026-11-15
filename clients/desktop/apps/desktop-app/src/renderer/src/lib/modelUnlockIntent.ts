import {
  MODEL_UNLOCK_POLL_INTERVAL_MS as SHARED_POLL_INTERVAL_MS,
  MODEL_UNLOCK_POLL_MAX_BACKOFF_MS as SHARED_POLL_MAX_BACKOFF_MS,
  MODEL_UNLOCK_POLL_MAX_MS as SHARED_POLL_MAX_MS,
  createModelUnlockIntentStore,
  type ModelUnlockCheckOutcome,
  type ModelUnlockIntentHandlers as SharedModelUnlockIntentHandlers,
  type ModelUnlockPhase as SharedModelUnlockPhase,
  type PendingModelUnlockIntent as SharedPendingModelUnlockIntent,
} from '@canopy/app-state/billing/credits';
import {
  reportClientAppError,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import {
  isBillingIntentIdentifier,
  isModelLibraryUnlockSource,
} from '@canopy/protocol/billing';
import type { DesktopBillingDeepLink } from '@canopy/protocol/billing';
import { announceAiCreditsChanged } from '@/lib/aiCreditsChanged';
import { refreshModelLibraryAccess } from '@/lib/modelLibraryAccess';

/**
 * The pending "unlock advanced models" purchase (CAN-4028): this renderer's
 * instance of the shared single-intent unlock store. The rules (only an
 * authoritative read unlocks, the pending model applies at most once,
 * nothing is resent) live with the store in
 * `@canopy/app-state/billing/credits`; this module binds the desktop's
 * access refresh, credits announcement and telemetry.
 */

export type PendingModelUnlockIntent = SharedPendingModelUnlockIntent;
export type ModelUnlockPhase = SharedModelUnlockPhase;
export type ModelUnlockIntentHandlers = SharedModelUnlockIntentHandlers;

/** How often the server is asked while checkout is open. */
export const MODEL_UNLOCK_POLL_INTERVAL_MS = SHARED_POLL_INTERVAL_MS;
/** How long the loop runs before handing the re-check back to the user. */
export const MODEL_UNLOCK_POLL_MAX_MS = SHARED_POLL_MAX_MS;
/** Ceiling for the failed-read backoff. */
export const MODEL_UNLOCK_POLL_MAX_BACKOFF_MS = SHARED_POLL_MAX_BACKOFF_MS;

const unlockStore = createModelUnlockIntentStore({
  refreshAccess: refreshModelLibraryAccess,
  announceCreditsChanged: announceAiCreditsChanged,
  reportError: (error): void => {
    reportClientAppError(error);
  },
  onBegin: (intent): void => {
    succeedClientOperation('canopy.model_recovery', {
      context: {
        recovery_source: isModelLibraryUnlockSource(intent.source)
          ? intent.source
          : 'desktop',
        ...(isBillingIntentIdentifier(intent.modelId)
          ? { model_id: intent.modelId }
          : {}),
        library_access: 'needs_purchase',
      },
    });
  },
  onAccessConfirmed: (intent): void => {
    succeedClientOperation('canopy.model_access', {
      context: {
        recovery_source: isModelLibraryUnlockSource(intent.source)
          ? intent.source
          : 'desktop',
        ...(isBillingIntentIdentifier(intent.modelId)
          ? { model_id: intent.modelId }
          : {}),
        library_access: 'unlocked',
      },
    });
  },
});

export const useModelUnlockIntentStore = unlockStore.useStore;

/**
 * Called once per intent when its unlock is confirmed, before the pending
 * model is applied. The app root uses it for the confirmation toast and the
 * in-chat confirmation (CAN-5027).
 */
export function setModelUnlockConfirmedListener(
  listener: ((intent: PendingModelUnlockIntent) => void) | null,
): void {
  unlockStore.setConfirmedListener(listener);
}

/** Remember a checkout that was just opened. Replaces any earlier intent. */
export function beginModelUnlockIntent(
  intent: PendingModelUnlockIntent,
  intentHandlers: ModelUnlockIntentHandlers = {},
): void {
  unlockStore.begin(intent, intentHandlers);
}

/** Forget the intent; with a `requestId`, only that intent. */
export function clearModelUnlockIntent(requestId?: string): void {
  unlockStore.clear(requestId);
}

/** Drop the intent if it belongs to another account. */
export function reconcileModelUnlockIntentAccount(
  accountKey: string | null,
): void {
  unlockStore.reconcileAccount(accountKey);
}

/** Ask the server once and act on the answer. Single-flight. */
export function checkModelUnlockNow(): Promise<ModelUnlockCheckOutcome> {
  return unlockStore.checkNow();
}

/** A billing return link arrived. It never authorizes anything. */
export function handleBillingReturnLink(link: DesktopBillingDeepLink): void {
  unlockStore.handleReturnLink(link);
}

/** Try the pending model again after a failed application. */
export function retryModelUnlockApply(): Promise<boolean> {
  return unlockStore.retryApply();
}

/** Run the poll loop for one intent. Returns its cleanup. */
export function runModelUnlockPolling(requestId: string): () => void {
  return unlockStore.runPolling(requestId);
}
