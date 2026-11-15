import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { CreditsHandoffOpener, CreditsHandoffOpenResult } from './openers';
import type {
  CreditsAccountIdentity,
  CreditsAccountIdentityReader,
  CreditsCheckFeedbackKind,
} from './types';

/**
 * The pending browser checkout of an AI Credits purchase, keyed by wallet
 * (CAN-5534).
 *
 * The hand-off used to live in the purchase action's instance, so switching
 * chats reset it: the waiting copy, Check again and Reopen billing
 * disappeared, a fresh purchase action returned, and the arrival handle was
 * cancelled. It lives here instead, for the host session only: it survives
 * remounts, hidden surfaces and navigation, never a reload.
 *
 * One record per wallet key (the purchase scope: project, worktree and
 * navigation context, without the chat), so every surface in that scope
 * shows the return controls instead of a second checkout. A record still
 * remembers the chat and surface that started it: the arrival is that
 * chat's.
 *
 * A record ends only when coverage is confirmed, its originating notice is
 * dismissed, {@link CREDITS_HANDOFF_MAX_AGE_MS} passes, or the account
 * changes. Timing out restores the purchase action; it does not mean the
 * browser checkout was cancelled.
 */

/** Fixed lifetime from the successful browser open. Nothing extends it. */
export const CREDITS_HANDOFF_MAX_AGE_MS = 10 * 60_000;

/**
 * The arrival tracking a record owns from its creation. The store cancels it
 * when the record ends without coverage and records it on coverage.
 */
export interface CreditsArrivalHandle {
  /** The initiating buyer, once verified in the arrival session. */
  readonly accountKey?: string | null;
  recordCovered(): boolean;
  cancel(): void;
}

export interface CreditsHandoffRecord<TOrigin extends string = string> {
  readonly id: string;
  /** The purchase scope this record suppresses fresh purchases in. */
  readonly walletKey: string;
  /** The chat key of the chat that started it, when it had one. */
  readonly originChatKey: string | null;
  /** The originating chat's own credits scope key. */
  readonly originScopeKey: string;
  /** The surface whose click started it; `null` when it tracks no arrival. */
  readonly origin: TOrigin | null;
  readonly startedAt: number;
  /** The last explicit Check again verdict, shared by every chat in scope. */
  readonly feedback: CreditsCheckFeedbackKind | null;
  /** The buying account; `undefined` while it is being identified. */
  readonly accountKey: string | undefined;
  /**
   * The account could not be read since. The record stays, but a coverage
   * found meanwhile is not attributed to its chat.
   */
  readonly identityUnverified: boolean;
  readonly accountGeneration: number;
}

export interface CreditsPurchaseState<TOrigin extends string = string> {
  readonly records: Readonly<Record<string, CreditsHandoffRecord<TOrigin>>>;
  /** Bumped whenever the account session ends; fences every async result. */
  readonly accountGeneration: number;
}

export interface BeginCreditsHandoffInput<TOrigin extends string = string> {
  readonly walletKey: string;
  readonly originChatKey: string | null;
  readonly originScopeKey: string;
  readonly origin: TOrigin | null;
  /** The generation the open started under; a later one rejects it. */
  readonly accountGeneration: number;
  /** Owned by the store from here on, adopted or not. */
  readonly arrival: CreditsArrivalHandle | null;
}

export interface CreditsPurchaseStorePorts<TOpenRequest = never> {
  /**
   * The host's hand-off opener: where a purchase in `handoff` mode goes.
   * Absent on a host that cannot hand off; every open then fails.
   */
  readonly openHandoff?: CreditsHandoffOpener<TOpenRequest>;
  /**
   * The account identity reader, looked up at each use; `null` when this
   * host cannot read the account. `complete` needs it: without a reader no
   * record ever completes.
   */
  readonly accountIdentityReader: () => CreditsAccountIdentityReader | null;
  readonly now?: () => number;
}

export interface CreditsPurchaseStore<
  TOrigin extends string = string,
  TOpenRequest = never,
> {
  readonly useStore: UseBoundStore<StoreApi<CreditsPurchaseState<TOrigin>>>;
  /**
   * Open billing through the host's hand-off. Never rejects: a throw, or a
   * host without an opener, is `'failed'`. Opening records nothing; a
   * `'web'` result is recorded with {@link CreditsPurchaseStore.begin}.
   */
  openHandoff(request: TOpenRequest): Promise<CreditsHandoffOpenResult>;
  /**
   * End every record past its deadline. Also called before adopting or
   * completing one: a suspended machine fires its timer late.
   */
  expire(now?: number): void;
  /**
   * Whether this exact record is still the scope's pending hand-off for the
   * account generation an async operation started under.
   */
  isCurrent(walletKey: string, id: string, accountGeneration: number): boolean;
  hasHandoffs(): boolean;
  /**
   * Take the scope's initial-open latch, or `null` when another surface
   * holds it or a hand-off is already pending, so two mounted purchase
   * actions cannot both launch a checkout. Release it once the open settles.
   */
  claimOpening(walletKey: string): object | null;
  releaseOpening(walletKey: string, token: object): void;
  /**
   * Record a successful browser open. An existing record for the scope is
   * adopted unchanged, keeping its baseline and deadline; the new arrival
   * handle is then cancelled. `null` when the account changed meanwhile.
   */
  begin(
    input: BeginCreditsHandoffInput<TOrigin>,
  ): CreditsHandoffRecord<TOrigin> | null;
  /** Store the last explicit Check again verdict for every chat in scope. */
  setFeedback(
    walletKey: string,
    id: string,
    accountGeneration: number,
    feedback: CreditsCheckFeedbackKind | null,
  ): void;
  /**
   * Coverage confirmed. The first caller for this record and generation
   * records the arrival for the originating chat, then removes the record;
   * every later or stale caller gets `false` and changes nothing. Announce
   * after this.
   */
  complete(walletKey: string, id: string, accountGeneration: number): boolean;
  /**
   * End a record without coverage: its originating notice was dismissed, or
   * its account changed. Naming it means a late call cannot end a newer
   * record for the same scope.
   */
  end(walletKey: string, id: string, accountGeneration: number): void;
  /** Fence in-flight work immediately, before the root's identity read settles. */
  suspendAccount(): void;
  /**
   * Bring records in line with the saved account. The same account keeps them
   * (a credits refresh announces as an account change too); sign-out or a
   * different account ends them for good. An unreadable account is not a
   * sign-out: records stay but are not attributed until it reads again.
   */
  reconcileAccount(identity: CreditsAccountIdentity): void;
}

/** The pending hand-off for a purchase scope, or `null`. */
export function selectCreditsHandoff<TOrigin extends string>(
  state: CreditsPurchaseState<TOrigin>,
  walletKey: string | null,
): CreditsHandoffRecord<TOrigin> | null {
  return walletKey === null ? null : (state.records[walletKey] ?? null);
}

/** Create the wallet-keyed purchase store a host keeps for its session. */
export function createCreditsPurchaseStore<
  TOrigin extends string = string,
  TOpenRequest = never,
>(
  ports: CreditsPurchaseStorePorts<TOpenRequest>,
): CreditsPurchaseStore<TOrigin, TOpenRequest> {
  type HandoffRecord = CreditsHandoffRecord<TOrigin>;
  type Records = Readonly<Record<string, HandoffRecord>>;
  const now = ports.now ?? Date.now;
  const useStore = create<CreditsPurchaseState<TOrigin>>(() => ({
    records: {},
    accountGeneration: 0,
  }));

  /**
   * Arrival handles, by record id. Outside Zustand state: they are live
   * objects with their own lifecycle, not presentation.
   */
  const arrivalHandles = new Map<string, CreditsArrivalHandle>();
  /** One initial browser open per purchase scope until its record exists. */
  const openingLatches = new Map<string, object>();
  /** The account established by a reconcile or identity read, if any. */
  let knownAccountKey: string | null | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let handoffCounter = 0;
  const invalidatedIdentities = new Set<string>();

  const isExpired = (record: HandoffRecord, at: number): boolean =>
    at >= record.startedAt + CREDITS_HANDOFF_MAX_AGE_MS;

  const releaseHandle = (id: string): void => {
    arrivalHandles.get(id)?.cancel();
    arrivalHandles.delete(id);
    invalidatedIdentities.delete(id);
  };

  const setRecords = (records: Records, accountGeneration?: number): void => {
    useStore.setState(
      accountGeneration === undefined
        ? { records }
        : { records, accountGeneration },
    );
    scheduleExpiry();
  };

  const withoutRecord = (walletKey: string): Records => {
    const next = { ...useStore.getState().records };
    delete next[walletKey];
    return next;
  };

  /** One timer for the earliest deadline, whether or not a surface is mounted. */
  function scheduleExpiry(): void {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    const records = Object.values(useStore.getState().records);
    if (records.length === 0) return;
    const deadline = Math.min(
      ...records.map((r) => r.startedAt + CREDITS_HANDOFF_MAX_AGE_MS),
    );
    expiryTimer = setTimeout(
      (): void => {
        expiryTimer = null;
        expire();
      },
      Math.max(0, deadline - now()),
    );
  }

  function expire(at = now()): void {
    const { records } = useStore.getState();
    const expired = Object.values(records).filter((r) => isExpired(r, at));
    if (expired.length === 0) return;
    const next = { ...records };
    for (const record of expired) {
      delete next[record.walletKey];
      releaseHandle(record.id);
    }
    setRecords(next);
  }

  function isCurrent(
    walletKey: string,
    id: string,
    accountGeneration: number,
  ): boolean {
    expire();
    const state = useStore.getState();
    return (
      state.accountGeneration === accountGeneration &&
      state.records[walletKey]?.id === id
    );
  }

  function updateRecord(
    walletKey: string,
    id: string,
    accountGeneration: number,
    patch: Partial<
      Pick<HandoffRecord, 'feedback' | 'accountKey' | 'identityUnverified'>
    >,
  ): boolean {
    if (!isCurrent(walletKey, id, accountGeneration)) return false;
    const { records } = useStore.getState();
    const record = records[walletKey];
    if (!record) return false;
    setRecords({ ...records, [walletKey]: { ...record, ...patch } });
    return true;
  }

  const markUnverified = (record: HandoffRecord): void => {
    updateRecord(record.walletKey, record.id, record.accountGeneration, {
      identityUnverified: true,
    });
  };

  function end(walletKey: string, id: string, accountGeneration: number): void {
    if (!isCurrent(walletKey, id, accountGeneration)) return;
    releaseHandle(id);
    setRecords(withoutRecord(walletKey));
  }

  /** Bind a new record to the account it was bought from. */
  function identifyAccount(record: HandoffRecord): void {
    const readIdentity = ports.accountIdentityReader();
    if (readIdentity === null) {
      markUnverified(record);
      return;
    }
    const settle = (key: string | null): void => {
      if (!isCurrent(record.walletKey, record.id, record.accountGeneration))
        return;
      if (key === null) {
        markUnverified(record);
        return;
      }
      if (
        (record.accountKey !== undefined && record.accountKey !== key) ||
        (knownAccountKey !== undefined && knownAccountKey !== key)
      ) {
        end(record.walletKey, record.id, record.accountGeneration);
        return;
      }
      knownAccountKey = key;
      updateRecord(record.walletKey, record.id, record.accountGeneration, {
        accountKey: key,
        identityUnverified: false,
      });
    };
    // Through a promise chain, so a synchronous reader throw is a failed read.
    void Promise.resolve()
      .then(() => readIdentity())
      .then(
        (identity): void => {
          if (identity.kind === 'unreadable') {
            settle(null);
            return;
          }
          if (identity.kind === 'signed-out') {
            if (
              isCurrent(record.walletKey, record.id, record.accountGeneration)
            ) {
              reconcileAccount({ kind: 'signed-out' });
            }
            return;
          }
          settle(identity.key);
        },
        (): void => settle(null),
      );
  }

  function endSession(): void {
    const state = useStore.getState();
    for (const id of arrivalHandles.keys()) releaseHandle(id);
    openingLatches.clear();
    invalidatedIdentities.clear();
    setRecords({}, state.accountGeneration + 1);
  }

  function reconcileAccount(identity: CreditsAccountIdentity): void {
    if (identity.kind === 'unreadable') {
      const { records } = useStore.getState();
      const next: Record<string, HandoffRecord> = {};
      for (const [key, record] of Object.entries(records)) {
        next[key] = { ...record, identityUnverified: true };
      }
      if (Object.keys(next).length > 0) setRecords(next);
      return;
    }
    if (identity.kind === 'signed-out') {
      knownAccountKey = null;
      endSession();
      return;
    }
    const changed =
      knownAccountKey !== undefined && knownAccountKey !== identity.key;
    knownAccountKey = identity.key;
    if (changed) {
      endSession();
      return;
    }
    const { records } = useStore.getState();
    const next: Record<string, HandoffRecord> = {};
    let dropped = false;
    for (const [key, record] of Object.entries(records)) {
      if (
        invalidatedIdentities.has(record.id) ||
        (record.accountKey !== undefined && record.accountKey !== identity.key)
      ) {
        releaseHandle(record.id);
        dropped = true;
        continue;
      }
      // Still identifying: its own read settles it against this account.
      next[key] =
        record.accountKey === identity.key
          ? { ...record, identityUnverified: false }
          : record;
    }
    if (dropped || Object.keys(next).length > 0) setRecords(next);
  }

  return {
    useStore,
    async openHandoff(
      request: TOpenRequest,
    ): Promise<CreditsHandoffOpenResult> {
      const open = ports.openHandoff;
      if (open === undefined) return 'failed';
      try {
        return await open(request);
      } catch {
        return 'failed';
      }
    },
    expire,
    isCurrent,
    hasHandoffs(): boolean {
      return (
        openingLatches.size > 0 ||
        Object.keys(useStore.getState().records).length > 0
      );
    },
    claimOpening(walletKey: string): object | null {
      expire();
      if (openingLatches.has(walletKey)) return null;
      if (useStore.getState().records[walletKey]) return null;
      const token = {};
      openingLatches.set(walletKey, token);
      return token;
    },
    releaseOpening(walletKey: string, token: object): void {
      if (openingLatches.get(walletKey) === token)
        openingLatches.delete(walletKey);
    },
    begin(input: BeginCreditsHandoffInput<TOrigin>): HandoffRecord | null {
      expire();
      const state = useStore.getState();
      if (state.accountGeneration !== input.accountGeneration) {
        input.arrival?.cancel();
        return null;
      }
      const existing = state.records[input.walletKey];
      if (existing) {
        input.arrival?.cancel();
        return existing;
      }
      const startedAt = now();
      const record: HandoffRecord = {
        id: `credits-handoff-${startedAt.toString(36)}-${++handoffCounter}`,
        walletKey: input.walletKey,
        originChatKey: input.originChatKey,
        originScopeKey: input.originScopeKey,
        origin: input.origin,
        startedAt,
        feedback: null,
        // The arrival may already have verified the buyer before the open.
        // Keep that identity if the follow-up read is temporarily offline.
        accountKey: input.arrival?.accountKey ?? undefined,
        identityUnverified: false,
        accountGeneration: state.accountGeneration,
      };
      if (input.arrival !== null) arrivalHandles.set(record.id, input.arrival);
      setRecords({ ...state.records, [input.walletKey]: record });
      identifyAccount(record);
      return record;
    },
    setFeedback(
      walletKey: string,
      id: string,
      accountGeneration: number,
      feedback: CreditsCheckFeedbackKind | null,
    ): void {
      const record = useStore.getState().records[walletKey];
      if (record?.id === id && record.feedback === feedback) return;
      updateRecord(walletKey, id, accountGeneration, { feedback });
    },
    complete(
      walletKey: string,
      id: string,
      accountGeneration: number,
    ): boolean {
      if (!isCurrent(walletKey, id, accountGeneration)) return false;
      const record = useStore.getState().records[walletKey];
      // Keep both the checkout and its baseline until the buyer is verified.
      if (
        record?.identityUnverified !== false ||
        record.accountKey === undefined
      )
        return false;
      const handle = arrivalHandles.get(id);
      arrivalHandles.delete(id);
      invalidatedIdentities.delete(id);
      handle?.recordCovered();
      setRecords(withoutRecord(walletKey));
      return true;
    },
    end,
    suspendAccount(): void {
      const state = useStore.getState();
      const accountGeneration = state.accountGeneration + 1;
      const records: Record<string, HandoffRecord> = {};
      for (const [key, record] of Object.entries(state.records)) {
        if (record.accountKey === undefined)
          invalidatedIdentities.add(record.id);
        records[key] = {
          ...record,
          accountGeneration,
          identityUnverified: true,
        };
      }
      openingLatches.clear();
      setRecords(records, accountGeneration);
    },
    reconcileAccount,
  };
}
