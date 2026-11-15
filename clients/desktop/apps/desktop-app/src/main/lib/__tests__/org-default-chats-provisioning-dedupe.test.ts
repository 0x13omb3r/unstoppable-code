// CAN-6096: every organization chat-project listing starts default Chats
// provisioning (default-chats, claim, complete against the hosted service).
// Concurrent starts share one attempt, a success answers repeat starts for
// two minutes, a failure is never remembered, and any workspace context
// broadcast (switch, account change, departure, organizations) forgets it.
// The production module runs over a counted binding.

let mockAttempts = 0;
let mockOutcomes: {
  resolve: () => void;
  reject: (error: Error) => void;
}[] = [];
let mockListener: ((state: unknown) => void) | undefined;
const mockContext = { kind: 'organization', organizationId: 'org-1' };

jest.mock('../org-cowork-binding', () => ({
  createOrgCoworkBinding: (): {
    ensureOrgDefaultCoworkWorkspace: () => Promise<void>;
  } => ({
    ensureOrgDefaultCoworkWorkspace: (): Promise<void> => {
      mockAttempts += 1;
      return new Promise<void>((resolve, reject) => {
        mockOutcomes.push({ resolve, reject });
      });
    },
  }),
}));
jest.mock('../workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    getState: (): unknown => ({
      context: mockContext,
      organizations: [{ id: 'org-1' }],
    }),
    subscribe: (listener: (state: unknown) => void): (() => void) => {
      mockListener = listener;
      return (): undefined => undefined;
    },
  }),
}));
jest.mock('../../canopy-cloud/client', () => ({
  CanopyCloudClientError: class extends Error {},
  ensureOrgDefaultChats: (): undefined => undefined,
  requestCanopyCloudJson: (): undefined => undefined,
}));
jest.mock('../../canopy-cloud/oauth-login', () => ({
  getDesktopOAuthClientDeviceId: (): string => 'device',
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: () => undefined } => ({
    recordAppDiagnostic: (): undefined => undefined,
  }),
}));
jest.mock('../canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> =>
    Promise.resolve({
      status: 'ok',
      entry: { capabilities: ['org-projects-v1'] },
    }),
}));
jest.mock('../installation-generation', () => ({
  readInstallationGeneration: (): undefined => undefined,
}));
jest.mock('../org-billing-state', () => ({
  isOrganizationTeamsLapsed: (): Promise<boolean> => Promise.resolve(false),
}));
jest.mock('../sidebar-items', () => ({
  readAllSidebarItemsSnapshot: (): undefined => undefined,
}));
jest.mock('../sidebar-items-preservation', () => ({
  getSidebarItemsPreserveWorkspaceIds: (): string[] => [],
}));
jest.mock('../workspace-persistence', () => ({
  readWorkspaceOwnership: (): undefined => undefined,
}));
jest.mock('../window-send', () => ({
  sendToAllWindows: (): undefined => undefined,
}));
jest.mock('@canopy/desktop-shared/node/lib/detached-work', () => ({
  detachedWorkCallback:
    (work: () => Promise<unknown>): (() => void) =>
    (): void => {
      void work();
    },
}));

import {
  installOrgDefaultCoworkProvisioning,
  resetOrgCoworkBindingForTests,
  startOrgDefaultCoworkProvisioning,
} from '../org-cowork-binding-deps';

let now = 0;
const start = (): Promise<void> => startOrgDefaultCoworkProvisioning('org-1');
/** Lets the eligibility reads reach the binding. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
async function finish(index: number, failure?: Error): Promise<void> {
  const outcome = mockOutcomes[index];
  if (failure) outcome.reject(failure);
  else outcome.resolve();
  await settle();
}

beforeEach(() => {
  resetOrgCoworkBindingForTests();
  mockAttempts = 0;
  mockOutcomes = [];
  mockListener = undefined;
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

describe('organization default Chats provisioning dedupe (CAN-6096)', () => {
  it('shares one attempt among concurrent starts', async () => {
    const starts = [start(), start(), start(), start(), start()];
    await settle();
    expect(mockAttempts).toBe(1);
    await finish(0);
    await Promise.all(starts);
    expect(mockAttempts).toBe(1);
  });

  it('answers repeat starts for two minutes after a success, then tries again', async () => {
    void start();
    await settle();
    await finish(0);
    now += 119_000;
    await start();
    await settle();
    expect(mockAttempts).toBe(1);
    now += 2_000;
    void start();
    await settle();
    expect(mockAttempts).toBe(2);
  });

  it('never remembers a failure', async () => {
    void start();
    await settle();
    await finish(0, new Error('pool timeout'));
    void start();
    await settle();
    expect(mockAttempts).toBe(2);
  });

  it('forgets a success on any context broadcast and starts a fresh attempt', async () => {
    installOrgDefaultCoworkProvisioning();
    await settle();
    await finish(0);
    void start();
    await settle();
    expect(mockAttempts).toBe(1);
    for (const reason of ['switch', 'account-change', 'organizations']) {
      mockListener?.({ reason, context: mockContext });
      await settle();
      await finish(mockAttempts - 1);
    }
    expect(mockAttempts).toBe(4);
  });

  it('does not remember an attempt that started before a context broadcast', async () => {
    installOrgDefaultCoworkProvisioning();
    await settle();
    mockListener?.({ reason: 'switch', context: mockContext });
    await settle();
    expect(mockAttempts).toBe(2);
    await finish(0);
    await finish(1, new Error('pool timeout'));
    void start();
    await settle();
    expect(mockAttempts).toBe(3);
  });
});
