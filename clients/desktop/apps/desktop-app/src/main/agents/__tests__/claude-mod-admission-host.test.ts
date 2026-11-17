import {
  CLIENT_FEATURE_FLAG_DEFAULTS,
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import {
  request as delegationRequest,
  successfulQuery,
} from '../../__tests__/helpers/delegation-runner-fixtures/claude';

// Cited by behavior-inventory/claude-mod-admission.yaml: desktop startup's
// installClaudeModAdmissionHost() keeps the default-off admission flag's
// launch effects out of every child environment until the flag turns on.
// Managed Claude delegates, which load settings files, keep plugin dirs named
// in a settings file's env off at the flag tier whatever the flag says.

const FLAG_KEY = CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key;
let flagEnabled = false;
type SnapshotListener = (snapshot: FeatureFlagSnapshot) => void;
interface FeatureFlagServiceStub {
  isEnabled: () => boolean;
  onSnapshotChanged: (listener: SnapshotListener) => () => void;
}
interface AbsentPreferences {
  authority: 'absent';
}
const snapshotListeners: SnapshotListener[] = [];

jest.mock(
  '../../feature-flags',
  (): { getFeatureFlagService: () => FeatureFlagServiceStub } => ({
    getFeatureFlagService: (): FeatureFlagServiceStub => ({
      isEnabled: (): boolean => flagEnabled,
      onSnapshotChanged: (listener: SnapshotListener): (() => void) => {
        snapshotListeners.push(listener);
        return (): void => undefined;
      },
    }),
  }),
);
jest.mock(
  '../../lib/preferences-store',
  (): { readPreferencesFileDetailed: () => Promise<AbsentPreferences> } => ({
    readPreferencesFileDetailed: (): Promise<AbsentPreferences> =>
      Promise.resolve({ authority: 'absent' }),
  }),
);

interface DelegateQueryArgs {
  options: { settings: { env?: unknown } };
}
const mockClaudeQuery = jest.fn<
  ReturnType<typeof successfulQuery>,
  [DelegateQueryArgs]
>(() => successfulQuery());
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: DelegateQueryArgs): unknown => mockClaudeQuery(args),
  createSdkMcpServer: jest.fn(() => ({ type: 'sdk' })),
  tool: jest.fn((name: string) => ({ name })),
}));

import {
  installClaudeModAdmissionHost,
  resolveClaudeModAdmissionLaunch,
} from '../claude-mod-admission-launch';
import { createClaudeDelegationRunner } from '../delegation/claude-runner';
import { DelegationNativePolicy } from '../delegation/native-policy';
import { runInAgentWorker } from '../../agent-runs/agent-worker-context';

function publish(enabled: boolean): void {
  flagEnabled = enabled;
  for (const listener of snapshotListeners) {
    listener({
      values: { ...CLIENT_FEATURE_FLAG_DEFAULTS, [FLAG_KEY]: enabled },
      status: 'ready',
      initialized: true,
      updatedAt: new Date(0).toISOString(),
      error: null,
    });
  }
}

describe('installClaudeModAdmissionHost', () => {
  const inherited = process.env.CLAUDE_CODE_PLUGIN_DIRS;

  beforeAll(() => {
    process.env.CLAUDE_CODE_PLUGIN_DIRS = '/tmp/inherited-plugins';
    installClaudeModAdmissionHost();
  });

  afterAll(() => {
    if (inherited === undefined) delete process.env.CLAUDE_CODE_PLUGIN_DIRS;
    else process.env.CLAUDE_CODE_PLUGIN_DIRS = inherited;
  });

  it('leaves child environments and launches unchanged while the flag is off', async () => {
    expect(getEnhancedEnv().CLAUDE_CODE_PLUGIN_DIRS).toBe(
      '/tmp/inherited-plugins',
    );
    await expect(
      resolveClaudeModAdmissionLaunch({ cwd: process.cwd() }),
    ).resolves.toBeUndefined();
  });

  it('drops inherited Claude plugin dirs while the flag is on, and restores them when it turns off', () => {
    publish(true);
    expect(getEnhancedEnv()).not.toHaveProperty('CLAUDE_CODE_PLUGIN_DIRS');
    publish(false);
    expect(getEnhancedEnv().CLAUDE_CODE_PLUGIN_DIRS).toBe(
      '/tmp/inherited-plugins',
    );
  });
});

describe('managed Claude delegate launch', () => {
  async function delegateFlagTierEnv(): Promise<unknown> {
    mockClaudeQuery.mockClear();
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          tools: new DelegationNativePolicy({
            cwd: process.cwd(),
            writePaths: [],
            signal: delegationRequest.signal,
            delegationId: delegationRequest.delegationId,
            mode: (): 'full-access' => 'full-access',
            allowed: (): Promise<boolean> => Promise.resolve(true),
            approval: {
              check: jest.fn(() => Promise.resolve({ decision: 'allow' })),
              setMode: jest.fn(),
              reevaluatePendingApprovals: jest.fn(() => Promise.resolve()),
              dispose: jest.fn(),
            },
            emit: (): Promise<void> => Promise.resolve(),
          }),
          plugins: [],
          mcpServers: {},
        }),
      reportError: jest.fn(),
    });
    let ended!: () => void;
    const terminal = new Promise<void>((resolve) => (ended = resolve));
    await runInAgentWorker(
      { kind: 'subagent', runId: delegationRequest.delegationId },
      () =>
        runner.start(delegationRequest, (envelope: AgentDelegationEvent) => {
          if (envelope.event.type === 'terminal') ended();
          return Promise.resolve();
        }),
    );
    await terminal;
    await runner.close({ runId: delegationRequest.delegationId });
    expect(mockClaudeQuery).toHaveBeenCalledTimes(1);
    return mockClaudeQuery.mock.calls[0][0].options.settings.env;
  }

  afterAll(() => publish(false));

  it.each([false, true])(
    'empties CLAUDE_CODE_PLUGIN_DIRS at the flag tier with the admission flag %s',
    async (enabled) => {
      publish(enabled);
      await expect(delegateFlagTierEnv()).resolves.toEqual({
        CLAUDE_CODE_PLUGIN_DIRS: '',
      });
    },
  );
});
