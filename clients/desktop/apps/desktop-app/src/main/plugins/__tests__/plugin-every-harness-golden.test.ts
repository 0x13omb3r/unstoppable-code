import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import type {
  ItemHarnessInstalls,
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/protocol/plugins';
import { forgetHarnessCopyFingerprints } from '../../lib/harness-copy-fingerprint';
import { getPluginHarnessInstallsFilePath } from '../../lib/paths';

// One Add for every harness, for plugins (CAN-6816). The registered plugin
// handlers, the record store, the session member listing and the harness
// compatibility rules run as production code over on-disk plugin fixtures.
// Only the plugin catalog cache (served here as a fixture) and unrelated
// hosts are replaced; no harness runtime is installed, so main confirms none
// itself and the renderer's list decides the targets.
let cache: {
  version: 2;
  lastRefreshed: string;
  marketplaces: MarketplaceInfo[];
};
jest.mock('../plugin-service', () => ({
  // A marketplace update as the service reports it (CAN-6817); the fixture
  // plugin folders are changed on disk by the test itself.
  updateMarketplace: (): Promise<unknown> =>
    Promise.resolve({ success: true, data: {} }),
  loadMarketplacesCacheOnly: (): Promise<unknown> =>
    Promise.resolve({ success: true, data: structuredClone(cache) }),
  loadMarketplacesForPresentation: (): Promise<unknown> =>
    Promise.resolve({ success: true, data: structuredClone(cache) }),
  // Handlers that answer with one plugin row, as the service returns it.
  prepareCodexCompatibilityPlugin: (
    marketplaceId: string,
    pluginName: string,
  ): Promise<unknown> =>
    Promise.resolve({
      success: true,
      data: structuredClone(
        cache.marketplaces
          .find((marketplace) => marketplace.id === marketplaceId)
          ?.plugins.find((plugin) => plugin.name === pluginName),
      ),
    }),
}));
jest.mock('../shareable-plugin-resolution', () => ({}));
jest.mock('../curated-plugin-events', () => ({}));
jest.mock('../invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));
jest.mock('../remote-install-source-gate', () => ({}));
// A window of this desktop, not a remote bridge (CAN-6817 retry restore).
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): null => null,
}));
jest.mock('../canopy-server-client', () => ({}));
jest.mock('../../lib/web-contents-send', () => ({}));
jest.mock('../../pipelines/pipeline-package-service', () => ({}));
jest.mock('../../sharing/share-operation-result', () => ({}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => false,
}));
jest.mock('../../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: (): boolean => false,
}));
jest.mock('../../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: (): Promise<{ authenticated: boolean }> =>
    Promise.resolve({ authenticated: false }),
  getCachedCodexAuthStatusObserved: (): Promise<{ authenticated: boolean }> =>
    Promise.resolve({ authenticated: false }),
}));
jest.mock('../../agents/user-supplied-credential', () => ({
  hasUserSuppliedProviderCredential: (): boolean => false,
}));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
// New Customize on, as main evaluates it (CAN-6817).
jest.mock('../../lib/customize-discovery-enabled', () => ({
  isCustomizeDiscoveryEnabledInMain: (): Promise<boolean> =>
    Promise.resolve(true),
}));

import { registerIpcHandler } from '../../ipc/register';
import { registerPluginHandlers } from '../plugin-handlers';

const HARNESSES = ['claude', 'codex', 'cursor', 'copilot', 'opencode'];
let root = '';

function handler(channel: string): (...args: unknown[]) => unknown {
  const found = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel)?.[1];
  if (!found) throw new Error(`Missing ${channel} handler`);
  return (...args): unknown => {
    const result: unknown = Reflect.apply(found, undefined, [
      { sender: {} },
      ...args,
    ]);
    return result;
  };
}

async function writePlugin(
  dir: string,
  manifestPath: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, text] of Object.entries({
    [manifestPath]: JSON.stringify(manifest),
    ...files,
  })) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

function facet(
  provider: 'claude' | 'codex',
  name: string,
  dir: string,
  details: Partial<NonNullable<PluginInfo['details']>>,
): NonNullable<PluginInfo['facets']['claude']> {
  return {
    provider,
    mode: 'native',
    name,
    description: '',
    version: '1.0.0',
    author: '',
    category: '',
    homepage: '',
    installLocation: dir,
    sourcePath: dir,
    details: {
      skills: [],
      agents: [],
      commands: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
      hasReadme: false,
      ...details,
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'plugin-every-harness-'));
  const codexDir = join(root, 'codex-only');
  await writePlugin(
    codexDir,
    '.codex-plugin/plugin.json',
    { name: 'codex-only' },
    {
      'skills/review/SKILL.md':
        '---\nname: review\ndescription: Review\n---\nBody\n',
    },
  );
  const claudeDir = join(root, 'claude-hooks');
  await writePlugin(
    claudeDir,
    '.claude-plugin/plugin.json',
    { name: 'claude-hooks' },
    {
      'skills/lint/SKILL.md': '---\nname: lint\ndescription: Lint\n---\nBody\n',
      'agents/helper.md': '---\nname: helper\ndescription: Helper\n---\n',
    },
  );
  const skill = {
    name: 'review',
    description: 'Review',
    path: 'skills/review',
  };
  const plugins: PluginInfo[] = [
    {
      name: 'codex-only',
      marketplaceId: 'fixture',
      sourcePath: codexDir,
      providerSupport: { claude: 'none', codex: 'native' },
      facets: {
        codex: facet('codex', 'codex-only', codexDir, { skills: [skill] }),
      },
    },
    {
      name: 'claude-hooks',
      marketplaceId: 'fixture',
      sourcePath: claudeDir,
      providerSupport: { claude: 'native', codex: 'compat' },
      facets: {
        claude: facet('claude', 'claude-hooks', claudeDir, {
          skills: [{ name: 'lint', description: 'Lint', path: 'skills/lint' }],
          agents: [
            {
              name: 'helper',
              description: 'Helper',
              filePath: 'agents/helper.md',
            },
          ],
          hooks: [{ event: 'Stop', hookType: 'command', command: 'echo done' }],
        }),
      },
    },
  ];
  cache = {
    version: 2,
    lastRefreshed: '2026-11-15T00:00:00.000Z',
    marketplaces: [
      {
        id: 'fixture',
        name: 'Fixture',
        installLocation: root,
        plugins,
      } as unknown as MarketplaceInfo,
    ],
  };
  registerPluginHandlers();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(getPluginHarnessInstallsFilePath(), { force: true });
});

test('one Add records every set-up harness, native first, with what each leaves out, and Try again checks one harness', async () => {
  const install = handler(PLUGINS_CHANNELS.INSTALL_FOR_HARNESSES);
  const retry = handler(PLUGINS_CHANNELS.RETRY_HARNESS_INSTALL);
  const load = handler(PLUGINS_CHANNELS.LOAD);
  const cacheBefore = JSON.stringify(cache);

  // A Codex-only plugin: native for Codex, its skills converted for Claude
  // Code and the Cursor family.
  const codexOnly = (await install({
    item: {
      kind: 'plugin',
      marketplaceId: 'fixture',
      pluginName: 'codex-only',
    },
    harnesses: HARNESSES,
  })) as ItemHarnessInstalls;
  const expected: Record<string, unknown> = {};
  for (const harness of HARNESSES)
    expected[harness] = expect.objectContaining({
      status: 'installed',
      via: harness === 'codex' ? 'native' : 'converted',
    });
  expect(codexOnly.harnesses).toEqual(expected);

  // A Claude plugin with agents and hooks: native for Claude Code; the
  // Cursor family loads its skill and leaves the rest out.
  const partial = (await install({
    item: {
      kind: 'plugin',
      marketplaceId: 'fixture',
      pluginName: 'claude-hooks',
    },
    harnesses: ['claude', 'cursor'],
  })) as ItemHarnessInstalls;
  expect(partial.harnesses.claude).toEqual(
    expect.objectContaining({ status: 'installed', via: 'native' }),
  );
  expect(partial.harnesses.cursor).toEqual(
    expect.objectContaining({
      status: 'installed',
      leftOut: ['agents', 'hooks'],
    }),
  );

  // The rows the window loads carry both records; the cache is not changed.
  const loaded = (await load()) as {
    data: { marketplaces: MarketplaceInfo[] };
  };
  const served = loaded.data.marketplaces[0].plugins;
  expect(served.map((plugin) => plugin.harnessInstalls)).toEqual([
    codexOnly,
    partial,
  ]);
  expect(JSON.stringify(cache)).toBe(cacheBefore);

  // A handler that answers with one plugin row carries its record too, so
  // the page that replaces its plugin with that row keeps the per-harness
  // notes.
  const prepared = (await handler(PLUGINS_CHANNELS.PREPARE_CODEX_COMPATIBILITY)(
    'fixture',
    'claude-hooks',
  )) as { data: PluginInfo };
  expect(prepared.data.harnessInstalls).toEqual(partial);

  // Try again checks one recorded harness and keeps the others.
  const retried = (await retry({
    item: {
      kind: 'plugin',
      marketplaceId: 'fixture',
      pluginName: 'claude-hooks',
    },
    harness: 'cursor',
  })) as ItemHarnessInstalls;
  expect(retried.harnesses.claude).toEqual(partial.harnesses.claude);
  await expect(
    retry({
      item: {
        kind: 'plugin',
        marketplaceId: 'fixture',
        pluginName: 'claude-hooks',
      },
      harness: 'codex',
    }),
  ).rejects.toThrow('not installed for Codex');
  await expect(
    install({
      item: {
        kind: 'plugin',
        marketplaceId: 'fixture',
        pluginName: 'codex-only',
      },
      harnesses: ['vim'],
    }),
  ).rejects.toThrow('Unknown harness');

  // The record file holds only the records, keyed by item.
  const file = JSON.parse(
    await readFile(getPluginHarnessInstallsFilePath(), 'utf8'),
  ) as { version: number; items: Record<string, unknown> };
  expect(file.version).toBe(1);
  expect(Object.keys(file.items).sort()).toEqual([
    'plugin:fixture/claude-hooks',
    'plugin:fixture/codex-only',
  ]);
  expect(existsSync(join(root, 'codex-only', '.claude-plugin'))).toBe(false);
});

test('an update rebuilds every harness from the new version; a copy changed outside the app warns until Try again repairs it', async () => {
  const install = handler(PLUGINS_CHANNELS.INSTALL_FOR_HARNESSES);
  const update = handler(PLUGINS_CHANNELS.UPDATE);
  const retry = handler(PLUGINS_CHANNELS.RETRY_HARNESS_INSTALL);
  const load = handler(PLUGINS_CHANNELS.LOAD);
  const item = {
    kind: 'plugin',
    marketplaceId: 'fixture',
    pluginName: 'codex-only',
  } as const;
  const served = async (): Promise<ItemHarnessInstalls | undefined> =>
    (
      (await load()) as { data: { marketplaces: MarketplaceInfo[] } }
    ).data.marketplaces[0].plugins.find(
      (plugin) => plugin.name === 'codex-only',
    )?.harnessInstalls;
  const dir = join(root, 'codex-only');
  await writePlugin(
    dir,
    '.codex-plugin/plugin.json',
    { name: 'codex-only', version: '1.0.0' },
    {},
  );
  await install({ item, harnesses: HARNESSES });

  // The publisher ships 2.0.0: every harness is checked against it.
  await writePlugin(
    dir,
    '.codex-plugin/plugin.json',
    { name: 'codex-only', version: '2.0.0' },
    {
      'skills/review/SKILL.md':
        '---\nname: review\ndescription: Review v2\n---\nBody\n',
    },
  );
  await update('fixture');
  const updated = await served();
  for (const harness of HARNESSES)
    expect(updated?.harnesses[harness as 'claude']).toEqual(
      expect.objectContaining({ status: 'installed', version: '2.0.0' }),
    );

  // Edited by hand: every harness reading that copy warns; the saved record
  // is unchanged, and Try again records the copy as it is now.
  await writeFile(join(dir, 'skills/review/SKILL.md'), 'edited\n');
  forgetHarnessCopyFingerprints();
  expect((await served())?.harnesses.cursor).toEqual(
    expect.objectContaining({ status: 'failed', outsideChange: 'changed' }),
  );
  await retry({ item, harness: 'cursor' });
  expect((await served())?.harnesses.cursor).toEqual(
    expect.objectContaining({ status: 'installed' }),
  );
});
