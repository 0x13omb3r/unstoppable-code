import { useCallback, useMemo, useState } from 'react';
import { toAppError } from '@canopy/protocol/app-errors';
import type { HarnessCatchUpNoticeState } from '@canopy/ui-shared/components';
import {
  harnessCatchUpOffer,
  harnessCatchUpOfferKey,
  harnessCatchUpTargetResult,
  type HarnessCatchUpNote,
  type HarnessCatchUpOffer,
  type HarnessCatchUpTarget,
} from '@canopy/ui-shared/lib/harness-catch-up';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { useSetUpHarnesses } from './useSetUpHarnesses';

/** Offers dismissed with Not now in this window, until the app restarts. */
const dismissedOfferKeys = new Set<string>();

/**
 * New Customize (CAN-6817): offers to add existing installs to harnesses set
 * up after they were added, and adds them after one confirmation through
 * the same calls one Add makes, in catch-up mode so every result already
 * recorded is kept. `undefined` state: nothing to offer, it was dismissed,
 * or the host cannot add.
 */
export function useHarnessCatchUp(options: {
  readonly enabled: boolean;
  readonly entries: readonly UnifiedPluginEntry[];
  readonly reloadPlugins: () => Promise<unknown> | void;
  readonly reloadServers: () => Promise<unknown> | void;
}): {
  readonly state: HarnessCatchUpNoticeState | undefined;
  readonly add: () => void;
  readonly dismiss: () => void;
} {
  const { enabled, entries, reloadPlugins, reloadServers } = options;
  const setUp = useSetUpHarnesses(enabled);
  const canAdd =
    window.plugins.installForHarnesses !== undefined &&
    window.mcpServers.installForHarnesses !== undefined;
  const offer = useMemo(
    () =>
      enabled && canAdd && setUp.settled
        ? harnessCatchUpOffer(entries, setUp.harnesses)
        : undefined,
    [canAdd, enabled, entries, setUp],
  );
  // Not now hides this offer until the app restarts, across visits to
  // Customize (the page unmounts in between); a different set of harnesses
  // is a new offer.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(dismissedOfferKeys),
  );
  const [run, setRun] = useState<
    | { readonly kind: 'adding'; readonly offer: HarnessCatchUpOffer }
    | Extract<HarnessCatchUpNoticeState, { kind: 'done' | 'failed' }>
    | undefined
  >(undefined);

  const add = useCallback((): void => {
    const target = run?.kind === 'failed' ? run.offer : offer;
    if (target === undefined || run?.kind === 'adding') return;
    setRun({ kind: 'adding', offer: target });
    void addToHarnesses(target.targets, target.cannotAdd)
      .then(async (result) => {
        await Promise.all([reloadPlugins(), reloadServers()]);
        setRun({ kind: 'done', offer: target, result });
      })
      .catch((cause: unknown) => {
        setRun({
          kind: 'failed',
          offer: target,
          message:
            toAppError(cause)?.detail.message.trim() ||
            "Couldn't add your installs.",
        });
      });
  }, [offer, reloadPlugins, reloadServers, run]);

  const dismiss = useCallback((): void => {
    const shown = run?.offer ?? offer;
    if (shown !== undefined) {
      const key = harnessCatchUpOfferKey(shown);
      dismissedOfferKeys.add(key);
      setDismissed((current) => new Set(current).add(key));
    }
    setRun(undefined);
  }, [offer, run]);

  if (!enabled) return { state: undefined, add, dismiss };
  if (run !== undefined) return { state: run, add, dismiss };
  if (offer === undefined || dismissed.has(harnessCatchUpOfferKey(offer)))
    return { state: undefined, add, dismiss };
  return { state: { kind: 'offer', offer }, add, dismiss };
}

/**
 * Adds each target's missing harnesses, one item at a time, and reads what
 * each harness did from the record it answers with. One item that fails
 * does not stop the rest; it is reported with why.
 */
async function addToHarnesses(
  targets: readonly HarnessCatchUpTarget[],
  cannotAdd: readonly HarnessCatchUpNote[],
): Promise<{ added: number; notAdded: HarnessCatchUpNote[] }> {
  let added = 0;
  // What compatibility rules out is listed with the rest, with why.
  const notAdded: HarnessCatchUpNote[] = [...cannotAdd];
  for (const target of targets) {
    try {
      const { record } = target;
      const answer =
        record.item !== undefined
          ? await window.plugins.installForHarnesses?.({
              item: record.item,
              harnesses: [...target.harnesses],
              mode: 'catch-up',
            })
          : await window.mcpServers.installForHarnesses?.({
              serverId: record.serverId,
              configId: record.configId,
              harnesses: [...target.harnesses],
              mode: 'catch-up',
            });
      const result = harnessCatchUpTargetResult(target, answer ?? null);
      if (result.added) added += 1;
      notAdded.push(...result.notes);
    } catch (cause) {
      const reason =
        toAppError(cause)?.detail.message.trim() || "Couldn't add it.";
      for (const harness of target.harnesses)
        notAdded.push({ name: target.name, harness, reason });
    }
  }
  return { added, notAdded };
}
