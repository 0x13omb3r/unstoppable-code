import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import type { ModelLibraryUnlockSource } from '@canopy/protocol/billing';
import type { CreditsBalanceReading, CreditsScopeRequest } from './types';

/**
 * The pending "unlock advanced models" purchase (CAN-4028).
 *
 * Checkout happens in the browser, so the host has to remember what the user
 * was trying to do, notice when the server says the account is unlocked, and
 * then finish the job. This store is that memory and that decision.
 *
 * Three rules shape everything below:
 *
 *  1. **Only an authoritative server read unlocks anything.** A return link,
 *     a window focus, and the poll timer are all just reasons to ask again.
 *     None of them carries authority, and a retained (last-known) value never
 *     confirms a payment.
 *  2. **The pending model is applied at most once**, and only while the
 *     account, the owner, the chat's selection, and this exact request are
 *     all still what they were when checkout opened. A newer manual selection
 *     or a newer intent always wins.
 *  3. **Nothing is resent.** Unlocking changes what can be selected; the user
 *     sends their own message, through the normal send path.
 *
 * Bounded to ONE intent. A second purchase attempt replaces the first, which
 * is what makes "never over a newer intent" structural.
 */

export interface PendingModelUnlockIntent {
  /** Satisfies `isBillingRequestId`; also names this attempt in the link. */
  readonly requestId: string;
  /** Account identity checkout was opened for. */
  readonly accountId: string;
  /** Billing owner checkout was opened for; the bound refresh reads this owner. */
  readonly owner: string;
  readonly chatId: string | null;
  /** Originating work identity; chat ids can repeat across sessions. */
  readonly scope?: CreditsScopeRequest;
  readonly modelId: string | null;
  readonly startedAt: number;
  readonly source?: ModelLibraryUnlockSource;
  /**
   * The buyer's balance read before checkout opened, when that read finished
   * first. Lets the confirmation name the credits added (CAN-5160).
   */
  readonly startingBalance?: CreditsBalanceReading;
}

/**
 * - `waiting`: checkout is open in the browser and the poll loop is running.
 * - `timed-out`: the poll loop stopped. NOT a payment failure — the payment
 *   may still complete — so the user is offered a re-check and a reopen.
 * - `applying`: unlock confirmed, the pending model is being applied.
 * - `unlocked`: confirmed, and nothing further is owed to the user.
 * - `apply-failed`: confirmed, but the pending model did not land. The unlock
 *   stands; only the selection is offered again.
 */
export type ModelUnlockPhase =
  | 'waiting'
  | 'timed-out'
  | 'applying'
  | 'unlocked'
  | 'apply-failed';

/** One model-library access read. */
export interface ModelUnlockAccessRead {
  readonly accountKey: string | null;
  readonly access: ModelLibraryAccess | undefined;
  /**
   * True only when THIS read carried the server's own answer. A retained
   * value is the previous answer, so it can never confirm a payment.
   */
  readonly authoritative: boolean;
  readonly ownerKey?: string;
}

/**
 * Behavior bound to the surface that started the intent. Kept out of the
 * store state because none of it is serializable, and because a handler must
 * die with the intent it belongs to.
 */
export interface ModelUnlockIntentHandlers {
  /**
   * Apply the pending model through the surface's normal model-change path
   * and report whether it landed. Absent when there is no model to apply.
   */
  readonly apply?: () => Promise<boolean>;
  /**
   * Is applying still what the user wants? False once the chat's selection
   * moved, the chat is gone, or the model can no longer be selected.
   */
  readonly isStillWanted?: () => boolean;
  /** The billing owner right now, or null when it cannot be established. */
  readonly resolveOwner?: () => Promise<string | null>;
  readonly refreshAccess?: () => Promise<ModelUnlockAccessRead | null>;
}

export interface ModelUnlockIntentState {
  readonly intent: PendingModelUnlockIntent | null;
  readonly phase: ModelUnlockPhase | null;
}

/** How often the server is asked while checkout is open. */
export const MODEL_UNLOCK_POLL_INTERVAL_MS = 3_000;
/** How long the loop runs before handing the re-check back to the user. */
export const MODEL_UNLOCK_POLL_MAX_MS = 10 * 60_000;
/** Ceiling for the failed-read backoff. */
export const MODEL_UNLOCK_POLL_MAX_BACKOFF_MS = 30_000;

export type ModelUnlockCheckOutcome = 'unlocked' | 'pending' | 'failed';

export interface ModelUnlockIntentStorePorts {
  /** The default access refresh, for an intent without its own. */
  readonly refreshAccess: () => Promise<ModelUnlockAccessRead | null>;
  /** The purchase moved the balance; refresh every credits surface. */
  readonly announceCreditsChanged: () => void;
  /** An intent began (checkout opened). For telemetry. */
  readonly onBegin?: (intent: PendingModelUnlockIntent) => void;
  /** An authoritative read confirmed the unlock. For telemetry. */
  readonly onAccessConfirmed?: (intent: PendingModelUnlockIntent) => void;
  /**
   * Records a failure the store recovers from: an owner re-read or a model
   * application that threw, or a credits subscriber that threw. The store
   * still settles the intent; the host decides how the failure is recorded.
   * Must not throw.
   */
  readonly reportError?: (error: unknown) => void;
  readonly now?: () => number;
}

export interface ModelUnlockIntentStore {
  readonly useStore: UseBoundStore<StoreApi<ModelUnlockIntentState>>;
  /**
   * Called once per intent when its unlock is confirmed, whichever of the
   * poll, a focus, or a return link got there first, and before the pending
   * model is applied (CAN-5027).
   */
  setConfirmedListener(
    listener: ((intent: PendingModelUnlockIntent) => void) | null,
  ): void;
  /** Remember a checkout that was just opened. Replaces any earlier intent. */
  begin(
    intent: PendingModelUnlockIntent,
    handlers?: ModelUnlockIntentHandlers,
  ): void;
  /**
   * Forget the intent. With a `requestId`, only that intent is cleared, so a
   * surface dismissing its own finished attempt cannot cancel a newer one.
   */
  clear(requestId?: string): void;
  /** Drop the intent if it belongs to another account. */
  reconcileAccount(accountKey: string | null): void;
  /**
   * Ask the server once and act on the answer. Single-flight, so the poll, a
   * focus, a return link, and a **Check again** press never overlap.
   */
  checkNow(): Promise<ModelUnlockCheckOutcome>;
  /**
   * A billing return link arrived. It never authorizes anything: a link
   * naming the pending request is a prompt to check now, and any other link
   * only refreshes access.
   */
  handleReturnLink(link: { readonly requestId: string }): void;
  /**
   * Try the pending model again after a failed application. The unlock is
   * already confirmed, so this never re-reads access.
   */
  retryApply(): Promise<boolean>;
  /**
   * Run the poll loop for one intent. Returns its cleanup. ONE loop, never
   * overlapping; a failed read doubles the wait up to
   * {@link MODEL_UNLOCK_POLL_MAX_BACKOFF_MS}. At
   * {@link MODEL_UNLOCK_POLL_MAX_MS} it marks the intent `timed-out`.
   */
  runPolling(requestId: string): () => void;
}

/** Create the single-intent unlock store a host keeps for its session. */
export function createModelUnlockIntentStore(
  ports: ModelUnlockIntentStorePorts,
): ModelUnlockIntentStore {
  const now = ports.now ?? Date.now;
  const useStore = create<ModelUnlockIntentState>(() => ({
    intent: null,
    phase: null,
  }));
  let handlers: ModelUnlockIntentHandlers = {};
  let confirmedListener: ((intent: PendingModelUnlockIntent) => void) | null =
    null;
  let checkInFlight: Promise<ModelUnlockCheckOutcome> | null = null;

  const isCurrent = (requestId: string): boolean =>
    useStore.getState().intent?.requestId === requestId;
  const report = (error: unknown): void => {
    ports.reportError?.(error);
  };

  function clear(requestId?: string): void {
    if (requestId !== undefined && !isCurrent(requestId)) return;
    handlers = {};
    useStore.setState({ intent: null, phase: null });
  }

  async function applyPendingModel(
    intent: PendingModelUnlockIntent,
  ): Promise<void> {
    const { apply, isStillWanted, resolveOwner } = handlers;
    // Latch BEFORE the first await. Every later check sees `applying` and
    // returns, which is what makes the application happen at most once even
    // when the poll and a return link confirm on the same tick.
    useStore.setState({ phase: 'applying' });
    let applied: boolean | null = null;
    if (apply !== undefined) {
      let ownerStands = true;
      if (resolveOwner !== undefined) {
        try {
          ownerStands = (await resolveOwner()) === intent.owner;
        } catch (error) {
          // An owner that cannot be re-read does not stand.
          report(error);
          ownerStands = false;
        }
      }
      // Re-checked after the owner read, which awaits: the selection may have
      // moved, or a newer intent may have replaced this one, in that window.
      if (
        ownerStands &&
        isCurrent(intent.requestId) &&
        (isStillWanted === undefined || isStillWanted())
      ) {
        try {
          applied = await apply();
        } catch (error) {
          // A thrown application is a failed one: the selection can be retried.
          report(error);
          applied = false;
        }
      }
    }
    // A newer intent owns the store now. Leave it exactly as it is.
    if (!isCurrent(intent.requestId)) return;
    // `null` means nothing was attempted. The unlock stands either way, so
    // only a real failed attempt offers the retry.
    useStore.setState({
      phase: applied === false ? 'apply-failed' : 'unlocked',
    });
  }

  async function evaluate(
    read: ModelUnlockAccessRead | null,
  ): Promise<ModelUnlockCheckOutcome> {
    const { intent, phase } = useStore.getState();
    if (intent === null) return 'pending';
    if (phase !== 'waiting' && phase !== 'timed-out') return 'pending';
    if (read === null) return 'failed';
    if (read.accountKey !== intent.accountId) {
      clear(intent.requestId);
      return 'pending';
    }
    // A scoped answer confirms only its echoed owner. Legacy personal reads
    // cannot confirm organization access.
    if (
      intent.owner !== (read.ownerKey ?? 'personal') ||
      !read.authoritative ||
      read.access !== 'unlocked'
    ) {
      return 'pending';
    }
    const applying = applyPendingModel(intent);
    ports.onAccessConfirmed?.(intent);
    // Announced here rather than inside the application, so a later retry of
    // a failed selection does not confirm the same unlock a second time. The
    // credits refresh comes first and stands on its own (CAN-5026).
    try {
      ports.announceCreditsChanged();
    } catch (error) {
      // A subscriber's failure must not strand the intent or the application.
      report(error);
    }
    try {
      confirmedListener?.(intent);
    } finally {
      // Preserve observer error propagation, but always settle the
      // application before this check finishes.
      await applying;
    }
    return 'unlocked';
  }

  function checkNow(): Promise<ModelUnlockCheckOutcome> {
    if (checkInFlight !== null) return checkInFlight;
    const requestId = useStore.getState().intent?.requestId;
    const started = (handlers.refreshAccess ?? ports.refreshAccess)()
      .then(
        (read): Promise<ModelUnlockCheckOutcome> | ModelUnlockCheckOutcome =>
          requestId !== undefined && !isCurrent(requestId)
            ? 'pending'
            : evaluate(read),
      )
      .finally((): void => {
        if (checkInFlight === started) checkInFlight = null;
      });
    checkInFlight = started;
    return started;
  }

  async function retryApply(): Promise<boolean> {
    const { intent, phase } = useStore.getState();
    if (intent === null || phase !== 'apply-failed') return false;
    await applyPendingModel(intent);
    return (
      isCurrent(intent.requestId) && useStore.getState().phase === 'unlocked'
    );
  }

  function runPolling(requestId: string): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = MODEL_UNLOCK_POLL_INTERVAL_MS;

    const schedule = (): void => {
      timer = setTimeout((): void => {
        timer = null;
        void tick();
      }, delay);
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const { intent, phase } = useStore.getState();
      if (intent?.requestId !== requestId || phase !== 'waiting') return;
      if (now() - intent.startedAt >= MODEL_UNLOCK_POLL_MAX_MS) {
        useStore.setState({ phase: 'timed-out' });
        return;
      }
      const outcome = await checkNow();
      if (stopped) return;
      delay =
        outcome === 'failed'
          ? Math.min(delay * 2, MODEL_UNLOCK_POLL_MAX_BACKOFF_MS)
          : MODEL_UNLOCK_POLL_INTERVAL_MS;
      const after = useStore.getState();
      if (after.intent?.requestId === requestId && after.phase === 'waiting') {
        schedule();
      }
    };

    schedule();
    return (): void => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }

  return {
    useStore,
    setConfirmedListener(listener): void {
      confirmedListener = listener;
    },
    begin(intent, intentHandlers = {}): void {
      handlers = intentHandlers;
      useStore.setState({ intent, phase: 'waiting' });
      ports.onBegin?.(intent);
    },
    clear,
    reconcileAccount(accountKey: string | null): void {
      const { intent } = useStore.getState();
      if (intent !== null && intent.accountId !== accountKey) clear();
    },
    checkNow,
    handleReturnLink(link: { readonly requestId: string }): void {
      const intent = useStore.getState().intent;
      if (
        isCurrent(link.requestId) &&
        intent &&
        now() - intent.startedAt < MODEL_UNLOCK_POLL_MAX_MS
      ) {
        void checkNow();
        return;
      }
      void ports.refreshAccess();
    },
    retryApply,
    runPolling,
  };
}
