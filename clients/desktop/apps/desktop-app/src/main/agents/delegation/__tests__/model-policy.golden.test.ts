// Allowed models for managed delegation: the two contracts a paired or older
// controller and a restart depend on. The tunneled
// `managed-delegation:model-policy-catalog` channel, through its registered
// IPC handler, must list each model with the route keys admission captures;
// and the policy saved through `preferences:save`'s preferences store must
// read back unchanged for admission, with a malformed saved policy failing
// closed. A break hides the controls that switch a route off, or silently
// widens or erases what the user allowed.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type ManagedDelegationPolicyCatalogResult,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type { ManagedDelegationModelPolicy } from '@canopy/protocol/delegation/model-policy';

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
jest.mock('../../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../../../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../../../lib/model-config', () => {
  const model = (
    id: string,
    label: string,
    modelSource: string,
    defaultHarness: string,
    selectable = true,
  ): unknown => ({
    id,
    label,
    modelSource,
    defaultHarness,
    enabled: true,
    selectable,
    supportedThinkingLevels: [],
  });
  return {
    listAuthoritativeConfiguredModels: (): unknown[] => [
      model('gpt-6.1-sol', 'GPT 6.1 Sol', 'codex-package', 'codex'),
      model('gpt-6-luna', 'GPT 6 Luna', 'codex-package', 'codex'),
      model('claude-fable-5-1', 'Claude Fable 5.1', 'claude-package', 'claude'),
      model('gateway-terra', 'GPT 6.1 Terra', 'ai-gateway', 'codex'),
      model('cursor-default', 'Cursor default', 'cursor-managed', 'cursor'),
      model(
        'opencode:anthropic%2Fclaude-native',
        'OpenCode Claude',
        'opencode-managed',
        'opencode',
      ),
      model('hidden-internal', 'Hidden', 'codex-package', 'codex', false),
    ],
  };
});
// The user's saved harness assignment: Luna (a Codex model) runs on Claude.
jest.mock('@canopy/desktop-shared/types', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@canopy/desktop-shared/types',
  ),
  getExecutionHarnessForModel: (id: string): string | undefined =>
    id === 'gpt-6-luna' ? 'claude' : undefined,
}));
jest.mock('@canopy/execution-engine/lib/gateway-model-availability', () => ({
  resolveGatewayModelEntry: (id: string): unknown =>
    id === 'gpt-6.1-sol' || id === 'gateway-terra'
      ? { origin: 'ai-credits' }
      : id === 'claude-fable-5-1'
        ? { origin: 'org-gateway' }
        : undefined,
}));
jest.mock('../../../auth/provider-auth-state', () => ({
  peekFreshProviderNativeAuthAvailability: (): unknown => ({
    codex: true,
    claude: false,
  }),
}));
jest.mock('../../../cursor/connection', () => ({
  peekCursorAccount: (): unknown => null,
}));

import {
  flushPreferencesWrites,
  readLatestPreferencesFile,
  writePreferencesFile,
} from '../../../lib/preferences-store';
import {
  managedDelegationModelPolicyRefusalFor,
  readManagedDelegationModelPolicy,
} from '../model-policy';

let dir = '';
let originalDataDir: string | undefined;
const savedKey = process.env.ANTHROPIC_API_KEY;
const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-model-policy-golden-'));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

afterAll(async () => {
  await flushPreferencesWrites();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
  rmSync(dir, { recursive: true, force: true });
});

it('the catalog channel lists each selectable model with the route keys admission captures', async () => {
  const { registerManagedDelegationHandlers } =
    await import('../../../ipc/managed-delegation');
  registerManagedDelegationHandlers();
  expect(IPC_CHANNELS.managedDelegationModelPolicyCatalog).toBe(
    'managed-delegation:model-policy-catalog',
  );
  const handler = mockHandlers.get(
    IPC_CHANNELS.managedDelegationModelPolicyCatalog,
  );
  const result = (await handler?.({})) as ManagedDelegationPolicyCatalogResult;
  if (!result.ok) throw new Error(result.error);
  const keys = Object.fromEntries(
    result.catalog.models.map((m) => [m.modelId, m.routes.map((r) => r.key)]),
  );
  // Keys match what route capture records: native accounts are `account`,
  // hosted funding names its gateway, and gateway-only models have no account.
  expect(keys).toEqual({
    'gpt-6.1-sol': ['codex:account', 'codex:ai-credits'],
    // Assigned away from its default harness: keyed by the harness it runs on.
    'gpt-6-luna': ['claude:account'],
    'claude-fable-5-1': ['claude:account', 'claude:org-gateway'],
    'gateway-terra': ['codex:ai-credits'],
    'cursor-default': ['cursor:account'],
    'opencode:anthropic%2Fclaude-native': ['opencode:account'],
  });
  // Selecting what the catalog offers admits the route capture records.
  const luna = {
    selectedModelId: 'gpt-6-luna',
    runtimeModelId: 'gpt-6-luna',
    harnessId: 'claude',
    runtimeKind: 'claude-sdk',
    runnerRegistrationId: 'local-delegation-claude-v1',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'codex-package',
    providerType: 'claude',
    assignmentRevision: 'r',
    billingAuthority: 'native',
    aiCreditsRouted: false,
    capabilities: [],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'h',
    capabilityGeneration: 1,
    policyRevision: 'p',
  };
  expect(
    managedDelegationModelPolicyRefusalFor(
      {
        version: 1,
        mode: 'selected',
        disabledBillingGroups: [],
        selectedModelIds: ['gpt-6-luna'],
        modelRoutes: { 'gpt-6-luna': keys['gpt-6-luna'] ?? [] },
      },
      luna,
      false,
    ),
  ).toBeUndefined();
  const fable = result.catalog.models.find(
    (m) => m.modelId === 'claude-fable-5-1',
  );
  // A signed-out account stays listed, with its reason, so intent survives.
  expect(fable?.routes[0]?.availability).toBe('unavailable');
  expect(
    result.catalog.models.find((m) => m.modelId === 'cursor-default')
      ?.unavailableReason,
  ).toBeDefined();
  expect(result.catalog.billingGroups.map((g) => g.id)).toEqual([
    'codex:account',
    'ai-credits',
    'claude:account',
    'org-gateway',
    'cursor:account',
    'opencode:account',
  ]);
});

it('preferences:save persists the policy that admission reads; malformed or unreadable saved preferences fail closed', async () => {
  expect(IPC_CHANNELS.preferencesSave).toBe('preferences:save');
  expect(await readManagedDelegationModelPolicy()).toBeUndefined();
  const policy: ManagedDelegationModelPolicy = {
    version: 1,
    mode: 'selected',
    disabledBillingGroups: ['ai-credits'],
    selectedModelIds: ['gpt-6.1-sol'],
    // A deselected model's remembered routes are kept for reselection.
    modelRoutes: {
      'gpt-6.1-sol': ['codex:account'],
      'claude-fable-5-1': ['claude:org-gateway'],
    },
  };
  await writePreferencesFile({ managedDelegationModelPolicy: policy });
  expect(
    (await readLatestPreferencesFile()).managedDelegationModelPolicy,
  ).toEqual(policy);
  expect(await readManagedDelegationModelPolicy()).toEqual(policy);

  const malformed = { managedDelegationModelPolicy: { version: 9 } };
  await writePreferencesFile(malformed as Partial<PreferencesData>);
  expect(await readManagedDelegationModelPolicy()).toEqual({
    version: 1,
    mode: 'selected',
    disabledBillingGroups: [],
    selectedModelIds: [],
    modelRoutes: {},
  });

  // Preferences that exist but can't be read fail closed, never widen, even
  // when the last readable state had no policy (All models).
  await writePreferencesFile({ managedDelegationModelPolicy: undefined });
  expect(await readManagedDelegationModelPolicy()).toBeUndefined();
  await flushPreferencesWrites();
  const dataDir = join(dir, 'data');
  for (const name of readdirSync(dataDir))
    if (name.startsWith('preferences') && name.endsWith('.json'))
      writeFileSync(join(dataDir, name), '{not json');
  expect(await readManagedDelegationModelPolicy()).toEqual({
    version: 1,
    mode: 'selected',
    disabledBillingGroups: [],
    selectedModelIds: [],
    modelRoutes: {},
  });
});
