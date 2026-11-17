import type { MarketplaceSource } from '@canopy/app-core/client';
import { officialMarketplaceProvider } from '@canopy/ui-shared/lib';

/**
 * The Marketplaces page (CAN-6814, behind the `customize-discovery` Labs
 * experiment): pure helpers over the existing marketplace source contract.
 * Nothing here reads or writes marketplace data.
 */

/** Who publishes a source, as the page's tag names it. */
export type MarketplaceSourceTag = 'Official' | 'Canopy';

/**
 * `Official` for the Claude and Codex first-party marketplaces, `Canopy` for
 * the marketplaces Canopy ships. Other sources carry no tag: the contract has
 * no team or community fact to name them by.
 */
export function marketplaceSourceTag(
  source: Pick<MarketplaceSource, 'id' | 'kind'>,
): MarketplaceSourceTag | undefined {
  if (officialMarketplaceProvider(source.id) !== undefined) return 'Official';
  if (source.kind === 'builtin' || source.kind === 'curated') return 'Canopy';
  return undefined;
}

/** The first-party provider whose logo a source shows, when it has one. */
export function marketplaceSourceProvider(
  source: Pick<MarketplaceSource, 'id'>,
): 'Claude' | 'Codex' | undefined {
  return officialMarketplaceProvider(source.id);
}

/**
 * How many of a source's plugins are installed for any harness, or
 * `undefined` when the host reports no install state (cloud sources).
 */
export function marketplaceSourceInstalledCount(
  source: Pick<MarketplaceSource, 'plugins'>,
): number | undefined {
  let known = false;
  let count = 0;
  for (const plugin of source.plugins) {
    const state = plugin.installState;
    if (state === undefined) continue;
    known = true;
    if (Object.values(state.providers).some((provider) => provider?.installed))
      count += 1;
  }
  return known ? count : undefined;
}

/**
 * Updates per source id, from the host. Hosts that cannot detect updates pass
 * none, so the banner stays hidden and rows show no update state.
 */
export type MarketplaceSourceUpdateCounts = Readonly<Record<string, number>>;

export interface MarketplaceUpdatesSummary {
  /** Updates across every listed source. */
  readonly updates: number;
  /** Listed sources with at least one update, in list order. */
  readonly sourceIds: readonly string[];
}

/** What the updates banner says; `undefined` hides it. */
export function marketplaceUpdatesSummary(
  sources: readonly Pick<MarketplaceSource, 'id'>[],
  counts: MarketplaceSourceUpdateCounts | undefined,
): MarketplaceUpdatesSummary | undefined {
  if (counts === undefined) return undefined;
  let updates = 0;
  const sourceIds: string[] = [];
  for (const source of sources) {
    const count = counts[source.id] ?? 0;
    if (!Number.isFinite(count) || count <= 0) continue;
    updates += count;
    sourceIds.push(source.id);
  }
  return updates > 0 ? { updates, sourceIds } : undefined;
}

export function marketplaceUpdatesLabel(count: number): string {
  return `${count} ${count === 1 ? 'update' : 'updates'}`;
}

export function marketplaceUpdatesMessage(sourceCount: number): string {
  return sourceCount === 1
    ? 'New versions are available in 1 marketplace.'
    : `New versions are available in ${sourceCount} marketplaces.`;
}
