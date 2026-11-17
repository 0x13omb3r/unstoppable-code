import { mcpServerLoadsOnHarness } from '@canopy/protocol/mcp-servers';
import {
  ITEM_INSTALL_HARNESSES,
  harnessSkipSentence,
  type HarnessCompatibility,
  type HarnessCompatibilityHarness,
} from '@canopy/protocol/plugins';
import { customizeHarnessLabel } from './customize-discovery';
import type {
  UnifiedEntryHarnessRecord,
  UnifiedPluginEntry,
} from './unified-plugin-entry';

// ---------------------------------------------------------------------------
// Adding existing installs to a harness set up later (CAN-6817, New Customize
// only). An item one Add installed for every harness keeps a record of each
// harness it tried; a harness set up after that Add has no result in it. The
// offer lists those items and, after one confirmation, adds the new harnesses
// to each record. Pure: no host calls.
// ---------------------------------------------------------------------------

/** One record to add newly set-up harnesses to. */
export interface HarnessCatchUpTarget {
  readonly entryId: string;
  readonly name: string;
  readonly record: UnifiedEntryHarnessRecord;
  /** The set-up harnesses this record has no result for, in order. */
  readonly harnesses: readonly HarnessCompatibilityHarness[];
}

export interface HarnessCatchUpOffer {
  /** Every harness some target is missing, in order. */
  readonly harnesses: readonly HarnessCompatibilityHarness[];
  readonly targets: readonly HarnessCatchUpTarget[];
  /**
   * Item and harness pairs the item's compatibility rules out before any
   * call (an MCP server a harness can't load), with why. Shown with the
   * result; never offered on their own.
   */
  readonly cannotAdd: readonly HarnessCatchUpNote[];
}

/**
 * Why a harness can't load an MCP server, from its compatibility, or
 * `undefined` when it can. Plugin records get the same reasons from main as
 * skipped states, so only server records need this.
 */
function mcpExclusionReason(
  compatibility: HarnessCompatibility | undefined,
  harness: HarnessCompatibilityHarness,
): string | undefined {
  if (mcpServerLoadsOnHarness(compatibility, harness)) return undefined;
  const result = compatibility?.harnesses[harness];
  return result?.level === 'unsupported'
    ? harnessSkipSentence(harness, result.reason)
    : `${customizeHarnessLabel(harness)} can't load its MCP servers.`;
}

/**
 * The offer for these installed rows and set-up harnesses, or `undefined`
 * when every record already has a result for every set-up harness. Only
 * installed rows count: a record an uninstalled item left behind offers
 * nothing.
 */
export function harnessCatchUpOffer(
  entries: readonly UnifiedPluginEntry[],
  setUp: readonly HarnessCompatibilityHarness[],
): HarnessCatchUpOffer | undefined {
  const targets: HarnessCatchUpTarget[] = [];
  const cannotAdd: HarnessCatchUpNote[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    // Waiting for a sign-in is still installed (as `marketplaceEntryIsInstalled`
    // reads it); its harnesses are added the same way.
    if (entry.state !== 'installed' && entry.state !== 'needs-auth') continue;
    for (const record of entry.harnessInstalls?.records ?? []) {
      const key =
        record.item !== undefined
          ? `item:${record.item.kind}:${JSON.stringify(record.item)}`
          : `server:${record.serverId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const missing = ITEM_INSTALL_HARNESSES.filter(
        (harness) =>
          setUp.includes(harness) && !record.harnesses.includes(harness),
      );
      const harnesses: HarnessCompatibilityHarness[] = [];
      for (const harness of missing) {
        const reason =
          record.serverId !== undefined
            ? mcpExclusionReason(entry.harnessCompatibility, harness)
            : undefined;
        if (reason === undefined) harnesses.push(harness);
        else cannotAdd.push({ name: entry.name, harness, reason });
      }
      if (harnesses.length > 0)
        targets.push({
          entryId: entry.id,
          name: entry.name,
          record,
          harnesses,
        });
    }
  }
  if (targets.length === 0) return undefined;
  const missing = new Set(targets.flatMap((target) => target.harnesses));
  const offered = ITEM_INSTALL_HARNESSES.filter((harness) =>
    missing.has(harness),
  );
  return {
    harnesses: offered,
    targets,
    cannotAdd: cannotAdd.filter((note) => offered.includes(note.harness)),
  };
}

/** A stable key for an offer, so dismissing it hides only this one. */
export function harnessCatchUpOfferKey(offer: HarnessCatchUpOffer): string {
  return offer.harnesses.join(',');
}

/** "Cursor", "Cursor and OpenCode", "Codex, Cursor and OpenCode". */
export function harnessListLabel(
  harnesses: readonly HarnessCompatibilityHarness[],
): string {
  const names = harnesses.map(customizeHarnessLabel);
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One item a harness did not take, with why. */
export interface HarnessCatchUpNote {
  readonly name: string;
  readonly harness: HarnessCompatibilityHarness;
  readonly reason: string;
}

/** What adding the installs did, for the notice to show. */
export interface HarnessCatchUpResult {
  /** Items now installed for at least one of the new harnesses. */
  readonly added: number;
  /** Items a new harness skipped or refused, with why. */
  readonly notAdded: readonly HarnessCatchUpNote[];
}

/** The per-harness state an add call answers with, as far as this reads it. */
export interface HarnessCatchUpRecordedState {
  readonly status: string;
  readonly reason?: string;
}

/**
 * Reads one target's result from the record its add call answered with.
 * `null` (nothing was recorded, for example the item was removed meanwhile)
 * and a missing harness are not added, each with a reason, never silently
 * added.
 */
export function harnessCatchUpTargetResult(
  target: HarnessCatchUpTarget,
  record: {
    readonly harnesses: Readonly<
      Partial<Record<HarnessCompatibilityHarness, HarnessCatchUpRecordedState>>
    >;
  } | null,
): { readonly added: boolean; readonly notes: HarnessCatchUpNote[] } {
  let added = false;
  const notes: HarnessCatchUpNote[] = [];
  for (const harness of target.harnesses) {
    const state = record?.harnesses[harness];
    if (state?.status === 'installed') added = true;
    else
      notes.push({
        name: target.name,
        harness,
        reason:
          record === null
            ? "It couldn't be added. Try again from its row."
            : (state?.reason ??
              `Nothing was recorded for ${customizeHarnessLabel(harness)}.`),
      });
  }
  return { added, notes };
}
