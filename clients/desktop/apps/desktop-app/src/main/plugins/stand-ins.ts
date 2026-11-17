import {
  PLUGIN_STAND_IN_LINK_VERSION,
  chatGptAppMissingHarnesses,
  parsePluginStandInLink,
  standInEndpointHost,
  type HarnessCompatibilityHarness,
  type ItemHarnessInstalls,
  type ItemHarnessStandIn,
  type PluginStandInCandidate,
  type PluginStandInLink,
} from '@canopy/protocol/plugins';
import {
  createHarnessInstallRecordStore,
  type HarnessInstallRecordStore,
  type HarnessInstallStoreDisk,
} from '../lib/harness-install-store';
import { getPluginStandInsFilePath } from '../lib/paths';
import { harnessCopy, type StagedPlugin } from './harness-installs';

// ---------------------------------------------------------------------------
// The publisher's MCP server standing in for a plugin's ChatGPT app (CAN-6818,
// behind the `customize-discovery` Labs experiment; the renderer only sends a
// candidate while it is on).
//
// After one Add records a plugin for every harness (CAN-6816), each harness
// where its ChatGPT app doesn't run is checked: when the copy that harness's
// session reads bundles an MCP server on the candidate's host (read from the
// installed copy itself), the publisher's server already loads there and the
// row says so. Nothing is installed or written to a harness or an MCP server;
// only the link file (`plugin-stand-ins.json`) changes. A harness without one
// reads "ChatGPT app only."; installing a separate server there is a
// follow-up.
// ---------------------------------------------------------------------------

/** A newer app wrote the link file; this one only reads around it. */
export class PluginStandInsNewerError extends Error {
  constructor() {
    super('A newer version of the app saved these stand-in records.');
    this.name = 'PluginStandInsNewerError';
  }
}

export type PluginStandInStore = HarnessInstallRecordStore<PluginStandInLink>;

export function createPluginStandInStore(
  filePath: () => string = getPluginStandInsFilePath,
  disk?: HarnessInstallStoreDisk,
): PluginStandInStore {
  return createHarnessInstallRecordStore({
    path: filePath,
    collection: 'items',
    parse: parsePluginStandInLink,
    newerError: () => new PluginStandInsNewerError(),
    ...(disk !== undefined ? { disk } : {}),
  });
}

export interface PluginStandInDeps {
  readonly store: PluginStandInStore;
  readonly now: () => string;
}

/**
 * The host of one bundled MCP declaration as a session loads it, or
 * `undefined` when the session does not load it as an http server: the
 * plugin resolver starts a declaration with a `command` as stdio, skips one
 * the manifest turns off (`enabled: false`), and loads a `url` only with no
 * type or `type: "http"`. A URL it can't parse (an unexpanded placeholder)
 * has no host.
 */
export function sessionHttpMcpHost(
  server: Readonly<Record<string, unknown>>,
): string | undefined {
  if (server.enabled === false) return undefined;
  if (typeof server.command === 'string') return undefined;
  if (typeof server.url !== 'string') return undefined;
  // As the resolver reads it: any falsy type is no type.
  if (Boolean(server.type) && server.type !== 'http') return undefined;
  return standInEndpointHost(server.url);
}

/**
 * Whether the copy a harness's recorded state reads (as `harnessCopy` picks
 * it) loads an MCP server on `host`: installed there, MCP servers not left
 * out, and the installed copy bundling a server on that host.
 */
function readsOwnMcpOnHost(
  staged: StagedPlugin,
  record: ItemHarnessInstalls,
  harness: HarnessCompatibilityHarness,
  host: string,
): boolean {
  const state = record.harnesses[harness];
  if (state?.status !== 'installed') return false;
  if (state.leftOut?.includes('mcpServers') === true) return false;
  const provider = harnessCopy(staged, harness, state.via)?.provider;
  if (provider !== 'claude' && provider !== 'codex') return false;
  return (staged.mcpHosts?.[provider] ?? []).includes(host);
}

/**
 * The harnesses where the plugin's ChatGPT app doesn't run and its own
 * installed copy loads an MCP server on the candidate's host.
 */
export function pluginStandInHarnesses(
  staged: StagedPlugin,
  record: ItemHarnessInstalls,
  candidate: PluginStandInCandidate,
): HarnessCompatibilityHarness[] {
  const host = standInEndpointHost(candidate.endpoint);
  if (host === undefined) return [];
  return chatGptAppMissingHarnesses(staged.compatibility).filter((harness) =>
    readsOwnMcpOnHost(staged, record, harness, host),
  );
}

// Removals this process has seen, per link key. An install, Try again or
// sync that started before one never writes a link after it.
const removalGenerations = new Map<string, number>();

function removalGeneration(key: string): number {
  return removalGenerations.get(key) ?? 0;
}

/**
 * The removals seen so far for a plugin: the token a plugin install, Try
 * again or sync takes before its first step and hands to the stand-in, so an
 * uninstall at any point after that cancels the stand-in write.
 */
export function pluginStandInToken(key: string): number {
  return removalGeneration(key);
}

/**
 * Works out the stand-in harnesses for a plugin from its latest record and
 * installed copy, and writes the link. `candidate` replaces the stored one
 * (a new Add); without one the stored candidate is used. Writes nothing
 * when the plugin was uninstalled since `token`, when there is no
 * candidate, or when the plugin has no ChatGPT app.
 */
export async function refreshPluginStandIn(
  deps: PluginStandInDeps,
  key: string,
  record: ItemHarnessInstalls,
  staged: StagedPlugin,
  candidate: PluginStandInCandidate | undefined,
  token: number,
): Promise<PluginStandInLink | undefined> {
  if (removalGeneration(key) !== token) return undefined;
  if (chatGptAppMissingHarnesses(staged.compatibility).length === 0)
    return undefined;
  const stored = (await deps.store.read())[key];
  const chosen = candidate ?? stored?.candidate;
  if (chosen === undefined) return undefined;
  const harnesses = pluginStandInHarnesses(staged, record, chosen);
  const now = deps.now();
  let removed = false;
  const written = await deps.store.update(key, (latest) => {
    if (removalGeneration(key) !== token) {
      removed = true;
      return latest;
    }
    return {
      version: PLUGIN_STAND_IN_LINK_VERSION,
      candidate: chosen,
      harnesses,
      createdAt: latest?.createdAt ?? now,
      updatedAt: now,
    };
  });
  return removed ? undefined : written;
}

/**
 * After the plugin is uninstalled: removes its link. Work still running for
 * it writes nothing after this. Never throws.
 */
export async function removePluginStandIn(
  deps: PluginStandInDeps,
  key: string,
  log: (message: string) => void,
): Promise<void> {
  removalGenerations.set(key, removalGeneration(key) + 1);
  if (!(await deps.store.remove(key)))
    log(
      'Could not remove a stand-in record from disk; it is ignored until a later write removes it.',
    );
}

/**
 * The stand-ins served with a plugin's record, worked out from that record
 * and the plugin as its sessions find it now, with the link's candidate:
 * the stored harness list is only the last result, never trusted on its
 * own, so a write that raced another can't hide or claim a harness. Without
 * the plugin as it is now, nothing is claimed. Never saved.
 */
export function servedStandIns(
  record: ItemHarnessInstalls,
  link: PluginStandInLink,
  staged: StagedPlugin | undefined,
): Partial<Record<HarnessCompatibilityHarness, ItemHarnessStandIn>> {
  const served: Partial<
    Record<HarnessCompatibilityHarness, ItemHarnessStandIn>
  > = {};
  if (staged === undefined) return served;
  for (const harness of pluginStandInHarnesses(staged, record, link.candidate))
    served[harness] = { name: link.candidate.name };
  return served;
}
