import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  canonicalInstalledItemRef,
  installedItemKey,
  InstalledItemRefSchema,
  parseInstalledItemKey,
  type InstalledItemRef,
} from '@canopy/protocol/installed-items';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { readPluginCatalog } from '@canopy/execution-engine/node/plugins/catalog-read-health';
import { readClaudeDisabledInstalledPlugins } from '@canopy/execution-engine/node/plugins/claude-disabled-plugins';
import type { OpenCodePromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';
import { readHeadlessPreferences } from '../approvals/headless-session';

const policySchema = z.object({
  disabledInstalledItems: z.array(z.string()).default([]),
  parkedCodexPlugins: z.array(z.object({ key: z.string() })).default([]),
  pendingInstalledItemUninstalls: z
    .array(z.object({ refs: z.array(InstalledItemRefSchema) }))
    .default([]),
});

/** Read current saved policy before resolving even a pinned capability snapshot. */
export async function assertCliInstalledItemsEnabled(
  request: OpenCodePromptRunnerRequest,
): Promise<void> {
  const selected: InstalledItemRef[] = [
    ...[
      ...new Set([
        ...(request.pluginSelections?.collectionIds ?? []),
        ...(request.pluginSelections?.bundleIds ?? []),
      ]),
    ].map((collectionId) => ({ kind: 'collection' as const, collectionId })),
    ...(request.pluginSelections?.mcpServerRefs ?? []).map((ref) => ({
      kind: 'mcp-config' as const,
      ...ref,
    })),
    ...(request.pluginSelections?.pluginRefs ?? []).map((ref) => ({
      kind: 'plugin' as const,
      ...ref,
    })),
    ...(request.pluginSelections?.skillRefs ?? []).map((ref) => ({
      kind: 'skill' as const,
      ...ref,
    })),
  ];
  const resources = request.packageOverlay?.resources ?? [];
  if (!selected.length && !resources.length) return;
  const policy = policySchema.parse(await readHeadlessPreferences());
  const disabled = [
    ...policy.disabledInstalledItems,
    ...policy.parkedCodexPlugins.map((entry) => entry.key),
  ].map((key) => {
    const ref = parseInstalledItemKey(key);
    if (!ref) throw new Error('Disabled item policy is unreadable.');
    return ref;
  });
  disabled.push(
    ...policy.pendingInstalledItemUninstalls.flatMap((entry) => entry.refs),
  );
  for (const id of readClaudeDisabledInstalledPlugins(
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'),
    { strict: true },
  )) {
    const separator = id.lastIndexOf('@');
    if (separator > 0 && separator < id.length - 1)
      disabled.push({
        kind: 'plugin',
        marketplaceId: id.slice(separator + 1),
        pluginName: id.slice(0, separator).toLowerCase(),
      });
  }
  const catalog = readPluginCatalog(
    join(getCanopyDataDir(), 'plugins-cache.json'),
  );
  const marketplaces =
    catalog.state === 'valid' ? catalog.data.marketplaces : [];
  const canonical = (ref: InstalledItemRef): InstalledItemRef =>
    canonicalInstalledItemRef(ref, marketplaces);
  const keys = new Set(disabled.map((ref) => installedItemKey(canonical(ref))));
  const assertEnabled = (ref: InstalledItemRef): void => {
    if (ref.kind === 'plugin' && catalog.state !== 'valid')
      throw new Error('The installed plugin catalog is unavailable.');
    if (keys.has(installedItemKey(canonical(ref))))
      throw new Error(
        'A selected installed item is disabled. Update the workflow selections before running it.',
      );
  };
  selected.forEach(assertEnabled);
  for (const resource of resources) {
    const kind = resource.kind === 'standalone_skill' ? 'skill' : 'plugin';
    if (resource.installedItemRef) {
      assertEnabled(resource.installedItemRef);
    } else if (
      (kind === 'plugin' && catalog.state !== 'valid') ||
      disabled.some((ref) => ref.kind === kind)
    ) {
      throw new Error(
        'Pinned resources without an original installed identity cannot be checked against disabled items. Re-export the package before running it.',
      );
    }
  }
}
