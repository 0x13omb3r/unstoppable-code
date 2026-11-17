import type {
  HarnessCompatibilityHarness,
  ItemHarnessInstalls,
} from '@canopy/protocol/plugins';
import { isCustomizeDiscoveryEnabledInMain } from '../lib/customize-discovery-enabled';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { ItemStandInHooks, StagedPlugin } from './harness-installs';
import {
  createPluginStandInStore,
  pluginStandInToken,
  refreshPluginStandIn,
  removePluginStandIn,
  servedStandIns,
  type PluginStandInDeps,
} from './stand-ins';

// ---------------------------------------------------------------------------
// Production wiring for the publisher's MCP server standing in for a
// plugin's ChatGPT app (CAN-6818). Reads the plugin's record and installed
// copy; writes only the link file. No MCP server, harness config, token or
// credential is read or written.
// ---------------------------------------------------------------------------

function log(message: string): void {
  logMainProcessWarn('[plugin-stand-ins]', message);
}

const pluginStandInDeps: PluginStandInDeps = {
  store: createPluginStandInStore(),
  now: () => new Date().toISOString(),
};

async function refresh(
  key: string,
  record: ItemHarnessInstalls,
  staged: StagedPlugin,
  candidate: Parameters<ItemStandInHooks['afterInstall']>[3],
  token: number,
): Promise<void> {
  try {
    // New Customize only, whoever calls (a remote controller too).
    if (!(await isCustomizeDiscoveryEnabledInMain())) return;
    await refreshPluginStandIn(
      pluginStandInDeps,
      key,
      record,
      staged,
      candidate,
      token,
    );
  } catch (error) {
    // The row then shows the plugin's own note for that harness.
    log(
      `Could not record a ChatGPT app's stand-in: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The hooks one Add, Try again and a sync call for a plugin (CAN-6818). */
export const pluginStandInHooks: ItemStandInHooks = {
  begin: pluginStandInToken,
  afterInstall: (key, record, staged, candidate, _mode, token) =>
    refresh(key, record, staged, candidate, token),
  retry: (key, _harness: HarnessCompatibilityHarness, record, staged, token) =>
    refresh(key, record, staged, undefined, token),
};

/** After a plugin is uninstalled: its link goes too. */
export async function forgetPluginStandIn(key: string): Promise<void> {
  await removePluginStandIn(pluginStandInDeps, key, log);
}

/**
 * Each record with the stand-ins its plugin's link serves, checked against
 * the plugin as its sessions find it now (`staged`). A plugin that can't be
 * read, or a link file that can't be read, claims nothing: the row shows
 * the plugin's own note.
 */
export async function withServedStandIns(
  records: Readonly<Record<string, ItemHarnessInstalls>>,
  staged: ReadonlyMap<string, StagedPlugin>,
): Promise<Record<string, ItemHarnessInstalls>> {
  const served: Record<string, ItemHarnessInstalls> = { ...records };
  let links: Awaited<ReturnType<PluginStandInDeps['store']['read']>>;
  try {
    links = await pluginStandInDeps.store.read();
  } catch (error) {
    log(
      `Could not read the stand-in records: ${error instanceof Error ? error.message : String(error)}`,
    );
    return served;
  }
  for (const [key, link] of Object.entries(links)) {
    const record = Object.prototype.hasOwnProperty.call(records, key)
      ? records[key]
      : undefined;
    if (record === undefined) continue;
    const standIns = servedStandIns(record, link, staged.get(key));
    if (Object.keys(standIns).length > 0) served[key] = { ...record, standIns };
  }
  return served;
}
