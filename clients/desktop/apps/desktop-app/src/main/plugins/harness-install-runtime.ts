import {
  harnessInstallItemKey,
  type HarnessInstallItemRef,
  type ItemHarnessInstalls,
  type MarketplaceInfo,
  type PluginInfo,
} from '@canopy/protocol/plugins';
import { confirmSetUpHarnesses } from '../lib/confirm-set-up-harnesses';
import { isCustomizeDiscoveryEnabledInMain } from '../lib/customize-discovery-enabled';
import {
  forgetHarnessCopyFingerprints,
  harnessCopyFingerprint,
} from '../lib/harness-copy-fingerprint';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  createItemHarnessInstallStore,
  createItemHarnessStagers,
  pluginHarnessCompatibility,
  pluginSessionFacts,
  noteItemUninstalled,
  resyncItemHarnessInstalls,
  servedItemHarnessInstalls,
  skillFolderOrNull,
  type HarnessCopy,
  type HarnessCopyFacts,
  type ItemHarnessInstallDeps,
  type ItemHarnessInstallStore,
  type PluginMemberCounter,
  type StagedItem,
  type StagedPlugin,
} from './harness-installs';
import {
  cursorSkillSourceDir,
  discoverCursorPluginMembers,
  loadPluginManifest,
  readPluginMcpConfigObjects,
  resolvePluginInfoPath,
  resolveSelectedSkillDirectory,
} from './plugin-resolver';
import { discoverPluginSkills } from './plugin-members';
import { sessionHttpMcpHost } from './stand-ins';
import {
  forgetPluginStandIn,
  pluginStandInHooks,
  withServedStandIns,
} from './stand-in-runtime';
import { loadMarketplacesCacheOnly } from './plugin-service';

// ---------------------------------------------------------------------------
// Production wiring for one Add for every harness, for plugins and skills
// (CAN-6816): reads an installed item the way each harness's session reads
// it. Nothing here installs, downloads or writes anything but the record.
// ---------------------------------------------------------------------------

/** Shared by the IPC handlers and the Claude session resolver. */
export const itemHarnessInstallStore: ItemHarnessInstallStore =
  createItemHarnessInstallStore();

const countPluginMembers: PluginMemberCounter = (
  pluginPath,
  provider,
  target,
) => {
  const manifest = loadPluginManifest(pluginPath, provider);
  const mcpServers = Object.keys(
    readPluginMcpConfigObjects(pluginPath, manifest),
  ).length;
  const members =
    target === 'claude'
      ? discoverPluginSkills(pluginPath, manifest).length
      : discoverCursorPluginMembers(pluginPath, provider).length;
  return members + mcpServers;
};

/**
 * The hosts of the http MCP servers an installed copy bundles, read from its
 * own manifest and MCP table the way a session reads them (CAN-6818). A copy
 * that is missing, or whose table can't be read, loads none in a session
 * either (the resolver reads it the same way), so none stands in.
 */
function installedMcpHosts(
  folder: string | null,
  provider: 'claude' | 'codex',
): string[] {
  if (folder === null) return [];
  try {
    const servers = readPluginMcpConfigObjects(
      folder,
      loadPluginManifest(folder, provider),
    );
    return Object.values(servers).flatMap((server) => {
      const host = sessionHttpMcpHost(server);
      return host === undefined ? [] : [host];
    });
  } catch {
    return [];
  }
}

function loadStagedSkill(item: {
  sourceId: string;
  skillName: string;
}): StagedItem | undefined {
  const warnings: string[] = [];
  const dir = resolveSelectedSkillDirectory(item, warnings);
  const folder = dir === null ? null : skillFolderOrNull(dir);
  if (folder === null) return undefined;
  return {
    kind: 'skill',
    dir: folder,
    cursorDir: cursorSkillSourceDir(item, warnings),
  };
}

/**
 * A plugin row as each harness's session finds it on disk. `install` lets
 * the resolver put back an external plugin's missing copy, as a session
 * does; otherwise nothing is installed and a missing copy stays missing.
 */
async function stagedPluginFrom(
  plugin: PluginInfo,
  marketplace: MarketplaceInfo,
  install = false,
  /**
   * Serving rows (CAN-6817): a plugin whose every copy is gone is still
   * staged, with no folders, so its harnesses read as removed. Installing
   * and checking treat it as not installed.
   */
  keepWithoutCopies = false,
): Promise<StagedPlugin | undefined> {
  const folder = async (
    provider: 'claude' | 'codex',
  ): Promise<string | null> =>
    plugin.facets[provider]
      ? resolvePluginInfoPath(plugin, marketplace, [], install, provider)
      : null;
  const [claudePath, codexPath] = await Promise.all([
    folder('claude'),
    folder('codex'),
  ]);
  if (claudePath === null && codexPath === null && !keepWithoutCopies)
    return undefined;
  return {
    kind: 'plugin',
    claudePath,
    codexPath,
    codexCompatDisabled: plugin.codexCompatDisabled === true,
    ...pluginSessionFacts(plugin),
    mcpHosts: {
      claude: installedMcpHosts(claudePath, 'claude'),
      codex: installedMcpHosts(codexPath, 'codex'),
    },
    compatibility: pluginHarnessCompatibility(plugin),
  };
}

async function findPluginRow(item: {
  marketplaceId: string;
  pluginName: string;
}): Promise<{ plugin: PluginInfo; marketplace: MarketplaceInfo } | undefined> {
  const result = await loadMarketplacesCacheOnly();
  const marketplace = result.success
    ? result.data?.marketplaces.find((entry) => entry.id === item.marketplaceId)
    : undefined;
  const plugin = marketplace?.plugins.find(
    (entry) => entry.name.toLowerCase() === item.pluginName.toLowerCase(),
  );
  return marketplace && plugin ? { plugin, marketplace } : undefined;
}

async function loadStagedItem(
  item: HarnessInstallItemRef,
): Promise<StagedItem | undefined> {
  if (item.kind === 'skill') return loadStagedSkill(item);
  const row = await findPluginRow(item);
  return row === undefined
    ? undefined
    : stagedPluginFrom(row.plugin, row.marketplace);
}

/**
 * The version a copy's manifest names, and its digest (CAN-6817). `fresh`
 * for a digest that is saved; serving rows may reuse a recent one.
 */
function readCopyFacts(
  copy: HarnessCopy,
  fresh: boolean,
): HarnessCopyFacts | undefined {
  const fingerprint = harnessCopyFingerprint(copy.folder, { fresh });
  if (fingerprint === undefined) return undefined;
  if (copy.provider === 'skill') return { fingerprint };
  let version: string | undefined;
  try {
    const named = loadPluginManifest(copy.folder, copy.provider)?.version;
    version = typeof named === 'string' && named.trim() ? named : undefined;
  } catch {
    version = undefined;
  }
  return { fingerprint, ...(version !== undefined ? { version } : {}) };
}

const describeCopy = (copy: HarnessCopy): HarnessCopyFacts | undefined =>
  readCopyFacts(copy, true);
const describeServedCopy = (copy: HarnessCopy): HarnessCopyFacts | undefined =>
  readCopyFacts(copy, false);

/** Try again's repair: an external plugin's copy, put back (CAN-6817). */
async function restoreItem(item: HarnessInstallItemRef): Promise<void> {
  if (item.kind !== 'plugin') return;
  try {
    const row = await findPluginRow(item);
    if (row !== undefined)
      await stagedPluginFrom(row.plugin, row.marketplace, true);
  } catch (error) {
    // The check after this records what is still missing.
    logMainProcessWarn(
      '[harness-installs]',
      `Could not restore a plugin's files: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    forgetHarnessCopyFingerprints();
  }
}

export const itemHarnessInstallDeps: ItemHarnessInstallDeps = {
  store: itemHarnessInstallStore,
  loadItem: loadStagedItem,
  stagers: createItemHarnessStagers(countPluginMembers),
  now: () => new Date().toISOString(),
  confirmedSetUpHarnesses: confirmSetUpHarnesses,
  describeCopy,
  restoreItem,
  standIns: pluginStandInHooks,
};

// ---------------------------------------------------------------------------
// Keeping records in sync (CAN-6817), New Customize only.
// ---------------------------------------------------------------------------

/**
 * The records to serve with plugin rows: each one with copies changed or
 * removed outside the app flagged (see `servedItemHarnessInstalls`). With
 * New Customize off, or a row that cannot be read, records go as saved.
 */
export async function servedPluginHarnessInstalls(
  records: Readonly<Record<string, ItemHarnessInstalls>>,
  marketplaces: readonly MarketplaceInfo[],
): Promise<Record<string, ItemHarnessInstalls>> {
  const served: Record<string, ItemHarnessInstalls> = { ...records };
  const staged = new Map<string, StagedPlugin>();
  if (
    Object.keys(records).length === 0 ||
    !(await isCustomizeDiscoveryEnabledInMain())
  )
    return served;
  for (const marketplace of marketplaces)
    for (const plugin of marketplace.plugins) {
      const key = harnessInstallItemKey({
        kind: 'plugin',
        marketplaceId: marketplace.id,
        pluginName: plugin.name,
      });
      const record = Object.prototype.hasOwnProperty.call(records, key)
        ? records[key]
        : undefined;
      if (record === undefined) continue;
      try {
        const current = await stagedPluginFrom(
          plugin,
          marketplace,
          false,
          true,
        );
        if (current !== undefined) staged.set(key, current);
        served[key] = servedItemHarnessInstalls(
          record,
          current,
          describeServedCopy,
        );
      } catch (error) {
        // Unknown is not changed: the record goes as saved.
        logMainProcessWarn(
          '[harness-installs]',
          `Could not check a plugin's copies: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  // What the publisher's MCP server did where it stands in for a ChatGPT
  // app (CAN-6818).
  return withServedStandIns(served, staged);
}

/**
 * After an update the user started (CAN-6817): every recorded harness of
 * these items is checked against the version now installed. `plugins` picks
 * the installed plugins to sync by marketplace (`undefined` for every
 * marketplace). Errors are logged, never thrown: the update itself already
 * succeeded, and the row shows any copy left out of date with Try again.
 */
export async function resyncHarnessInstallsAfterUpdate(target: {
  readonly plugins?: {
    readonly marketplaceId?: string;
    readonly name?: string;
  };
  readonly skills?: readonly { sourceId: string; skillName: string }[];
}): Promise<void> {
  try {
    if (!(await isCustomizeDiscoveryEnabledInMain())) return;
    // Rows served next read the updated copies, not a digest from before.
    forgetHarnessCopyFingerprints();
    const items: HarnessInstallItemRef[] = (target.skills ?? []).map(
      (skill) => ({ kind: 'skill', ...skill }),
    );
    if (target.plugins !== undefined) {
      const { marketplaceId, name } = target.plugins;
      const result = await loadMarketplacesCacheOnly();
      // Unreadable is not empty: say so, and leave the records as they are
      // (the rows show any copy left out of date).
      if (!result.success || result.data === undefined)
        logMainProcessWarn(
          '[harness-installs]',
          'Could not read the plugin catalog to update install records.',
        );
      for (const marketplace of result.success
        ? (result.data?.marketplaces ?? [])
        : [])
        if (marketplaceId === undefined || marketplace.id === marketplaceId)
          for (const plugin of marketplace.plugins)
            if (
              name === undefined ||
              plugin.name.toLowerCase() === name.toLowerCase()
            )
              items.push({
                kind: 'plugin',
                marketplaceId: marketplace.id,
                pluginName: plugin.name,
              });
    }
    for (const item of items)
      await resyncItemHarnessInstalls(itemHarnessInstallDeps, item).catch(
        (error: unknown) => {
          logMainProcessWarn(
            '[harness-installs]',
            `Could not update an install record: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
  } catch (error) {
    logMainProcessWarn(
      '[harness-installs]',
      `Could not update install records after an update: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * An uninstalled plugin or skill is uninstalled for every harness, so its
 * record goes too (CAN-6817). Checks still running for it discard their
 * results; a removal the disk refuses is retried, and until it lands every
 * read in this process leaves the record out. Never throws: the uninstall
 * itself already happened.
 */
export async function forgetItemHarnessInstalls(
  item: HarnessInstallItemRef,
): Promise<void> {
  const key = harnessInstallItemKey(item);
  noteItemUninstalled(key);
  // Only an MCP server the plugin added for its ChatGPT app goes with it.
  if (item.kind === 'plugin') await forgetPluginStandIn(key);
  const removed = await itemHarnessInstallStore
    .remove(key)
    .catch((): boolean => false);
  if (!removed)
    logMainProcessWarn(
      '[harness-installs]',
      'Could not remove an install record from disk; it is ignored until a later write removes it.',
    );
}
