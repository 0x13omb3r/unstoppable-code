/** Minimum gap between automatic post-purchase re-probes of one scope. */
export const CREDITS_REPROBE_MIN_INTERVAL_MS = 60_000;
/** Throttle entries retained, oldest first out. */
export const CREDITS_REPROBE_MAX_SCOPES = 256;

/**
 * The shared post-purchase re-probe throttle (§5).
 *
 * One per host, not per surface: purchase surfaces mount concurrently (every
 * chat's composer, the Home composer, a popped-out composer), and a
 * per-surface throttle would fire one probe chain per surface on a single
 * window focus. Entries are keyed by owner scope so one chat never throttles
 * or joins another owner's probe (CAN-3463).
 */
export interface CreditsCoverageProbe<TAvailability> {
  /**
   * Re-read availability for `key`. Joins a probe in flight for the same key.
   * `force` bypasses the throttle (**Check again**); an automatic probe inside
   * the throttle window resolves `null`. `readFresh` is a FRESH availability
   * read that never throws or rejects ("no read" resolves `null`); it runs
   * only when this call starts a probe.
   */
  probe(
    force: boolean,
    key: string,
    readFresh: () => Promise<TAvailability | null>,
  ): Promise<TAvailability | null>;
}

export interface CreditsCoverageProbeOptions {
  readonly now?: () => number;
}

export function createCreditsCoverageProbe<TAvailability>(
  options: CreditsCoverageProbeOptions = {},
): CreditsCoverageProbe<TAvailability> {
  const now = options.now ?? Date.now;
  const lastReprobeAtByScope = new Map<string, number>();
  const reprobeInFlightByScope = new Map<
    string,
    Promise<TAvailability | null>
  >();
  return {
    probe(
      force: boolean,
      key: string,
      readFresh: () => Promise<TAvailability | null>,
    ): Promise<TAvailability | null> {
      const existing = reprobeInFlightByScope.get(key);
      if (existing) return existing;
      const at = now();
      const lastReprobeAt = lastReprobeAtByScope.get(key) ?? 0;
      if (!force && at - lastReprobeAt < CREDITS_REPROBE_MIN_INTERVAL_MS) {
        return Promise.resolve(null);
      }
      lastReprobeAtByScope.delete(key);
      lastReprobeAtByScope.set(key, at);
      if (lastReprobeAtByScope.size > CREDITS_REPROBE_MAX_SCOPES) {
        const oldest = lastReprobeAtByScope.keys().next().value;
        if (oldest !== undefined) lastReprobeAtByScope.delete(oldest);
      }
      // FRESH, always: this re-probe exists to notice that the answer just
      // changed, so a retained answer would defeat it exactly when it matters.
      const probe = readFresh().finally((): void => {
        if (reprobeInFlightByScope.get(key) === probe) {
          reprobeInFlightByScope.delete(key);
        }
      });
      reprobeInFlightByScope.set(key, probe);
      return probe;
    },
  };
}
