import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/** The most archive reads the cold-start sweep runs at once (CAN-6778). */
export const COWORK_ARCHIVE_SWEEP_CONCURRENCY = 3;

/*
 * The page's effect starts a sweep again whenever its entries change, while
 * an earlier sweep's reads may still be in flight. The slots and the reads in
 * flight are shared by every sweep, so they never run more reads at once
 * than the limit between them, or read the same entry twice.
 */
let slotsTaken = 0;
const slotWaiters: (() => void)[] = [];
const readsInFlight = new Set<string>();

async function takeSlot(): Promise<void> {
  while (slotsTaken >= COWORK_ARCHIVE_SWEEP_CONCURRENCY)
    await new Promise<void>((resolve) => slotWaiters.push(resolve));
  slotsTaken += 1;
}

function giveSlot(): void {
  slotsTaken -= 1;
  slotWaiters.shift()?.();
}

/**
 * Reads each entry's archive, a few at a time, for the cold-start decision.
 * Before each read it waits for `ready`, so it never starts one ahead of a
 * task the user is opening; it stops starting reads once `cancelled`. An
 * entry another sweep is reading is left to it, and one whose archive is
 * `known` by then (an open read it) is skipped.
 */
export async function sweepCoworkArchives(options: {
  readonly entries: readonly { readonly id: string; readonly key: string }[];
  readonly read: (entryId: string) => Promise<void>;
  readonly known: (key: string) => boolean;
  readonly cancelled: () => boolean;
  readonly ready: () => Promise<void>;
}): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      await options.ready();
      if (options.cancelled()) return;
      await takeSlot();
      if (options.cancelled()) {
        giveSlot();
        return;
      }
      // A user open may have started while this worker waited for a slot.
      if (!isReadyNow()) {
        giveSlot();
        continue;
      }
      let entry = options.entries[next];
      while (
        entry !== undefined &&
        (readsInFlight.has(entry.key) || options.known(entry.key))
      ) {
        next += 1;
        entry = options.entries[next];
      }
      next += 1;
      if (entry === undefined) {
        giveSlot();
        return;
      }
      readsInFlight.add(entry.key);
      try {
        await options.read(entry.id);
      } finally {
        readsInFlight.delete(entry.key);
        giveSlot();
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          COWORK_ARCHIVE_SWEEP_CONCURRENCY,
          options.entries.length,
        ),
      },
      () => worker(),
    ),
  );
}

function isReadyNow(): boolean {
  return useStandaloneChatStore.getState().loadingWorkEntryId === null;
}

/** Resolves once no Work Entry's tabs are loading for an open. */
export function whenNoWorkEntryLoads(): Promise<void> {
  if (isReadyNow()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useStandaloneChatStore.subscribe((state) => {
      if (state.loadingWorkEntryId !== null) return;
      unsubscribe();
      resolve();
    });
  });
}
