import type * as Extraction from '@canopy/memory-consolidation/transcript-extraction';
import type * as PreparedNote from '../../memory/local/prepared-note';
import { peekCanopyCloudAccountId } from '../../lib/canopy-cloud-account-store';
import type { StructuredHelperQueryResult } from '@canopy/desktop-shared/lib/structured-helper-query';
import type { ChatExtraction } from '@canopy/memory-consolidation/transcript-extraction';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PersistedChatMessage,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import type { LocalMemoryPolicy } from '../../memory/local/policy';
import {
  setLocalMemoryReplicaLocator,
  localMemoryScopeDir,
} from '../../memory/local/scope-resolver';
import {
  queueLearningTurn,
  readLearningState,
  reserveLearningBudget,
  CHAT_LEARNING_INTERVAL_MS,
} from '../../memory/local/transcript-learning-state';
import {
  learnFromChats,
  collectChatEvidence,
} from '../../memory/local/transcript-learning';
import { localMemoryStore } from '../../memory/local/memory-store';
import { chatLearningTurnRecorder } from '../../memory/local/transcript-learning-recorder';
import { installChatLearningFlagSource } from '../../memory/local/transcript-learning-gate';
import { createDesktopRuntime } from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import { relayAllows } from '../renderer-relay/surface-allowlist';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  MEMORY_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';

jest.mock('../../lib/canopy-cloud-account-store', () => ({
  peekCanopyCloudAccountId: jest.fn(() => 'account'),
  peekCanopyCloudAccount: jest.fn(() => null),
  subscribeCanopyCloudAccountChanges: jest.fn(() => (): void => {}),
}));

let root = '';
let flag = true;
let busy = false;
let policyReadEffect: (() => void) | null = null;
let missingChat: string | null = null;
let deferredKind = '';
const deferredChats = new Set<string>();
let preferences: PreferencesData;
let policies: Record<string, LocalMemoryPolicy>;
let transcript: PersistedChatMessage[];
type Generation = StructuredHelperQueryResult<ChatExtraction>;
let helper: jest.Mock<Promise<Generation>, []>;
const reads: string[] = [];
const sent: string[] = [];
jest.mock('../../feature-flags/service', (): object => ({
  getFeatureFlagService: (): object => ({
    isEnabled: () => flag,
    onSnapshotChanged: (): (() => void) => (): void => {},
  }),
}));
jest.mock('../../lib/preferences-store', (): object => ({
  readPreferencesFile: (): Promise<PreferencesData> =>
    Promise.resolve(preferences),
}));
jest.mock('../../memory/local/helper-model', (): object => ({
  resolveLocalMemoryRunModel: (): Promise<object> =>
    Promise.resolve({
      helperModel: { model: 'test-model', thinkingLevel: 'low' },
    }),
}));
jest.mock('../../memory/local/policy', (): object => ({
  resolveLocalMemoryPolicy: ({
    projectId,
  }: {
    projectId: string;
  }): Promise<LocalMemoryPolicy> => {
    policyReadEffect?.();
    return Promise.resolve(
      policies[projectId] ?? { kind: 'blocked', workspaceId: projectId },
    );
  },
}));
jest.mock('../../memory/local/structured-helper', (): object => ({
  runLocalMemoryStructuredHelper: (options: {
    userMessage: string;
  }): Promise<Generation> => {
    sent.push(options.userMessage);
    return helper();
  },
}));
jest.mock('../../agents/session-manager', (): object => ({
  getAllActiveSessionInfos: () =>
    busy ? [{ turnActive: true, pendingMessageCount: 0 }] : [],
  subscribeChatSessionActivity: (): (() => void) => (): void => {},
}));
jest.mock('../../lib/helper-observed-task', (): object => ({
  startObservedHelperTask: jest.fn(),
  finalizeObservedHelperTask: jest.fn(),
}));
jest.mock('../../memory/local/change-events', (): object => ({
  broadcastLocalMemoryChanged: jest.fn(),
}));
jest.mock('../../memory/local/consolidation-scheduler', (): object => ({
  requestLocalMemoryConsolidation: jest.fn(),
}));
jest.mock('../../memory/local/transcript-learning-source', (): object => ({
  readLearningTranscript: async (
    ref: { chatId: string },
    consume: (snapshot: object, signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> => {
    reads.push(ref.chatId);
    if (deferredChats.has(ref.chatId)) {
      if (deferredKind === 'empty')
        return { kind: 'evidence', evidence: [], prompt: '[]' };
      throw new Error(
        deferredKind === 'cold'
          ? 'Chat learning requires a warm canonical store'
          : 'Chat learning requires a bounded committed transcript',
      );
    }
    if (ref.chatId === missingChat)
      throw new Error(`Unknown chat: ${ref.chatId}`);
    return consume({}, new AbortController().signal);
  },
}));
jest.mock('../../memory/local/transcript-learning-runner', (): object => ({
  runChatLearningWorker: async (request: {
    kind: string;
    allowed: string[];
    evidence: Extraction.ChatEvidence[];
    value: ChatExtraction;
    source: { provider: string; chatId: string };
  }): Promise<unknown> => {
    if (request.kind === 'extract') {
      const evidence = await collectChatEvidence(
        rows(transcript),
        new Set(request.allowed),
        () => !busy,
      );
      return { kind: 'evidence', evidence, prompt: JSON.stringify(evidence) };
    }
    const { groundedChatFacts } = jest.requireActual<typeof Extraction>(
      '@canopy/memory-consolidation/transcript-extraction',
    );
    const { prepareInboxNote } = jest.requireActual<typeof PreparedNote>(
      '../../memory/local/prepared-note',
    );
    return {
      kind: 'notes',
      notes: groundedChatFacts(request.value, request.evidence).flatMap(
        (text) => {
          const note = prepareInboxNote({ text, source: request.source });
          return note ? [note] : [];
        },
      ),
    };
  },
}));
jest.mock('../../lib/paths', (): object => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getDataDir: (): string => root,
  getWorkspaceMemoryDir: (id: string): string => join(root, id),
  getUserMemoryDir: (): string => join(root, 'personal'),
}));

async function* rows(
  messages: PersistedChatMessage[],
): AsyncIterable<PersistedChatMessage> {
  await Promise.resolve();
  yield* messages;
}
function message(
  id: string,
  role: PersistedChatMessage['role'],
  text: string,
  extra: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return {
    id,
    role,
    timestamp: Date.now(),
    blocks: [{ type: 'text', text }],
    ...extra,
  };
}
async function queue(
  projectId = 'project',
  chatId = 'chat',
  userMessageId = 'u1',
): Promise<void> {
  const scope =
    projectId === 'personal'
      ? { scope: 'user' as const }
      : { scope: 'workspace' as const, workspaceId: projectId };
  await queueLearningTurn(localMemoryScopeDir(scope), {
    projectId,
    worktreeId: 'wt',
    chatId,
    userMessageId,
    at: Date.now(),
    accountId: 'account',
    accountBindingVersion: 1,
  });
}
beforeEach(() => {
  installChatLearningFlagSource({
    isEnabled: () => flag,
    subscribe: () => (): void => {},
  });
  jest.mocked(peekCanopyCloudAccountId).mockReturnValue('account');
  root = mkdtempSync(join(tmpdir(), 'learn-'));
  policyReadEffect = null;
  missingChat = null;
  deferredChats.clear();
  deferredKind = '';
  flag = true;
  busy = false;
  reads.length = 0;
  sent.length = 0;
  preferences = {
    ...DEFAULT_PREFERENCES,
    localMemoryEnabled: true,
    localMemoryLearnFromChats: true,
  };
  policies = {
    project: { kind: 'scoped', workspaceId: 'project', privateMemory: false },
    private: { kind: 'scoped', workspaceId: 'private', privateMemory: true },
    personal: { kind: 'unscoped' },
  };
  setLocalMemoryReplicaLocator({
    signedInAccountId: () => 'account',
    replicaDir: (_account, scope) =>
      join(root, scope.scope === 'user' ? 'personal' : scope.workspaceId),
  });
  transcript = [
    message('u1', 'user', 'Use pnpm for this repository.'),
    message('a1', 'assistant', 'I will use pnpm.'),
  ];
  helper = jest.fn(
    (): Promise<Generation> =>
      Promise.resolve({
        value: {
          facts: [
            {
              text: 'Use pnpm for this repository.',
              evidence: [
                {
                  turnId: 'u1',
                  role: 'user',
                  quote: 'Use pnpm for this repository.',
                },
              ],
            },
          ],
        },
        usage: { totalCostUsd: 0.01 },
      }),
  );
});
afterEach(() => {
  setLocalMemoryReplicaLocator(null);
  rmSync(root, { force: true, recursive: true });
});

test('production core operation learns a sourced redacted inbox note, persists its checkpoint and refuses callers without the dedicated grant', async () => {
  await queue();
  const runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, 'operations.sqlite'),
    }),
    shutdownTimeoutMs: 25,
  });
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-memory-idle-scheduler',
    clientInstanceId: 'desktop-main',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: [MEMORY_GRANTS.learn],
  };
  try {
    await expect(
      runtime.instruction(
        'core.memory.chats.learn',
        { memory: 'workspace', workspaceId: 'project' },
        { caller: { ...caller, grants: [MEMORY_GRANTS.write] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(reads).toEqual([]);
    for (const untrusted of [
      { ...caller, principalId: 'local-desktop-renderer:main' },
      { ...caller, clientInstanceId: 'renderer' },
      { ...caller, authorityId: 'foreign' },
      { ...caller, interfaceKind: 'portal' as const },
    ]) {
      await expect(
        runtime.instruction(
          'core.memory.chats.learn',
          { memory: 'workspace', workspaceId: 'project' },
          { caller: untrusted },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    }
    expect(reads).toEqual([]);
    expect(relayAllows('main', 'instruction', 'core.memory.chats.learn')).toBe(
      false,
    );
    await expect(
      runtime.instruction(
        'core.memory.chats.learn',
        { memory: 'workspace', workspaceId: 'project' },
        { caller },
      ),
    ).resolves.toEqual({ status: 'learned', notes: 1 });
    const scope = { scope: 'workspace' as const, workspaceId: 'project' };
    const files = await localMemoryStore.listDocuments(scope);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'inbox',
          source: { provider: 'chat-extraction', chatId: 'chat' },
        }),
      ]),
    );
    expect((await readLearningState(localMemoryScopeDir(scope))).turns).toEqual(
      [],
    );
    await queue('project', 'next');
    expect(await learnFromChats(scope)).toEqual({
      status: 'skipped',
      notes: 0,
    });
    expect(helper).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.shutdown();
  }
});

test.each([
  'flag',
  'preference',
  'memory',
  'busy',
  'blocked',
  'other-project',
  'account',
])('%s refusal reads no transcript', async (refusal) => {
  await queue();
  if (refusal === 'flag') flag = false;
  if (refusal === 'preference') preferences.localMemoryLearnFromChats = false;
  if (refusal === 'memory') preferences.localMemoryEnabled = false;
  if (refusal === 'busy') busy = true;
  if (refusal === 'blocked')
    policies.project = { kind: 'blocked', workspaceId: 'project' };
  if (refusal === 'other-project')
    policies.project = {
      kind: 'scoped',
      workspaceId: 'other',
      privateMemory: false,
    };
  if (refusal === 'account')
    jest.mocked(peekCanopyCloudAccountId).mockReturnValue('other');
  if (refusal === 'account')
    setLocalMemoryReplicaLocator({
      signedInAccountId: () => 'other',
      replicaDir: () => join(root, 'project'),
    });
  expect(
    await learnFromChats({ scope: 'workspace', workspaceId: 'project' }),
  ).toEqual({ status: 'skipped', notes: 0 });
  expect(reads).toEqual([]);
  expect(sent).toEqual([]);
});

test('private project evidence stays in that project; project evidence never feeds personal memory', async () => {
  await queue('private', 'private-chat');
  await queue('project', 'project-chat');
  expect(await learnFromChats({ scope: 'user' })).toEqual({
    status: 'skipped',
    notes: 0,
  });
  expect(reads).toEqual([]);
  expect(
    await learnFromChats({ scope: 'workspace', workspaceId: 'private' }),
  ).toEqual({ status: 'learned', notes: 1 });
  expect(reads).toEqual(['private-chat']);
  expect(
    await localMemoryStore.listDocuments({
      scope: 'workspace',
      workspaceId: 'project',
    }),
  ).toEqual([]);
});

test('personal chats feed only personal memory', async () => {
  await queue('personal');
  expect(await learnFromChats({ scope: 'user' })).toEqual({
    status: 'learned',
    notes: 1,
  });
  expect(
    (await localMemoryStore.listDocuments({ scope: 'user' }))[0]?.source
      ?.chatId,
  ).toBe('chat');
});

test('hidden, delegated and unregistered turns expose no blocks and do not bleed into the preceding turn', async () => {
  const excluded = message('u2', 'user', 'excluded');
  Object.defineProperty(excluded, 'blocks', {
    get: () => {
      throw new Error('Excluded turn content read');
    },
  });
  const result = await collectChatEvidence(
    rows([
      transcript[0],
      message('hidden', 'user', 'hidden', { hidden: true }),
      message('ha', 'assistant', 'hidden answer'),
      excluded,
      message('a2', 'assistant', 'excluded answer'),
      message('u3', 'user', 'accepted'),
      message('a3', 'assistant', 'secret', { parentBlockId: 'child' }),
    ]),
    new Set(['u1', 'u3']),
    () => true,
  );
  expect(result.map((entry) => entry.text)).toEqual([
    'Use pnpm for this repository.',
    'accepted',
  ]);
});

test('pipeline/CLI/terminal/synthetic dispatches are never queued by the turn recorder', async () => {
  const options = {
    projectId: 'project',
    worktreeId: 'wt',
    chatId: 'cli',
    userMessageId: 'u1',
    originalUserText: 'ignored',
  };
  chatLearningTurnRecorder.begin('cli', 'audit', options);
  chatLearningTurnRecorder.complete('cli', 'audit', 'success');
  chatLearningTurnRecorder.begin('terminal', 'audit', {
    ...options,
    skillSuggestionEligible: true,
    chatMode: 'terminal',
  });
  chatLearningTurnRecorder.complete('terminal', 'audit', 'success');
  await new Promise((resolve) => setImmediate(resolve));
  expect(
    (
      await readLearningState(
        localMemoryScopeDir({ scope: 'workspace', workspaceId: 'project' }),
      )
    ).turns,
  ).toEqual([]);
});

test('daily reservation is durable and global across scopes; unknown/error usage never refunds it', async () => {
  const dir = join(root, 'budget');
  const now = Date.now();
  expect(await reserveLearningBudget(dir, now)).toBe(true);
  expect(await reserveLearningBudget(dir, now)).toBe(false);
  expect(await reserveLearningBudget(dir, now - 86_400_000)).toBe(false);
  expect(await reserveLearningBudget(dir, now + 86_400_000)).toBe(true);
  expect(CHAT_LEARNING_INTERVAL_MS).toBe(21_600_000);
});

test('turn evidence redacts secrets before dispatch and invented evidence cannot be saved', async () => {
  await queue();
  transcript[0] = message(
    'u1',
    'user',
    'api_key=sk-1234567890abcdefghijklmnop Use pnpm.',
  );
  helper.mockResolvedValue({
    value: {
      facts: [
        {
          text: 'Invented preference',
          evidence: [{ turnId: 'u1', role: 'user', quote: 'I prefer npm' }],
        },
      ],
    },
    usage: {},
  });
  expect(
    await learnFromChats({ scope: 'workspace', workspaceId: 'project' }),
  ).toEqual({ status: 'learned', notes: 0 });
  expect(sent[0]).not.toContain('sk-1234567890abcdefghijklmnop');
});

test('turning learning off while the model runs discards its result and keeps existing memories', async () => {
  await queue();
  helper.mockImplementation((): Promise<Generation> => {
    preferences.localMemoryLearnFromChats = false;
    return Promise.resolve({ value: { facts: [] }, usage: {} });
  });
  expect(
    await learnFromChats({ scope: 'workspace', workspaceId: 'project' }),
  ).toEqual({ status: 'skipped', notes: 0 });
  expect(
    await localMemoryStore.listDocuments({
      scope: 'workspace',
      workspaceId: 'project',
    }),
  ).toEqual([]);
});

test('accepted assistant recommendations retain both speakers; an unaccepted answer cannot ground a memory', async () => {
  await queue('project', 'chat', 'u1');
  await queue('project', 'chat', 'u2');
  transcript = [
    message('u1', 'user', 'Which database should we use?'),
    message('a1', 'assistant', 'Use SQLite for the offline cache.'),
    message('u2', 'user', 'Agreed, use SQLite for our cache.'),
  ];
  helper.mockResolvedValue({
    value: {
      facts: [
        {
          text: 'The cache uses SQLite, as recommended and accepted.',
          evidence: [
            {
              turnId: 'u1',
              role: 'assistant',
              quote: 'Use SQLite for the offline cache.',
            },
            {
              turnId: 'u2',
              role: 'user',
              quote: 'Agreed, use SQLite for our cache.',
            },
          ],
        },
        {
          text: 'Unaccepted database advice',
          evidence: [
            {
              turnId: 'u1',
              role: 'assistant',
              quote: 'Use SQLite for the offline cache.',
            },
          ],
        },
      ],
    },
    usage: {},
  });
  expect(
    await learnFromChats({ scope: 'workspace', workspaceId: 'project' }),
  ).toEqual({ status: 'learned', notes: 1 });
  expect(sent[0]).toContain('Use SQLite for the offline cache.');
  expect(sent[0]).toContain('Agreed, use SQLite for our cache.');
});

test('account switch during the final policy read cannot publish into the new account replica', async () => {
  await queue();
  const generation = await helper();
  helper.mockImplementation((): Promise<Generation> => {
    let checks = 0;
    policyReadEffect = (): void => {
      checks += 1;
      if (checks === 2) {
        jest.mocked(peekCanopyCloudAccountId).mockReturnValue('new-account');
        setLocalMemoryReplicaLocator({
          signedInAccountId: () => 'new-account',
          replicaDir: () => join(root, 'new-account-project'),
        });
      }
    };
    return Promise.resolve(generation);
  });
  const result = await learnFromChats({
    scope: 'workspace',
    workspaceId: 'project',
  });
  expect(result.notes).toBe(0);
  expect(
    await localMemoryStore.listDocuments({
      scope: 'workspace',
      workspaceId: 'project',
    }),
  ).toEqual([]);
});

test('a deleted queued chat is retired and does not starve the next chat', async () => {
  await queue('project', 'deleted-chat');
  await queue('project', 'kept-chat', 'u2');
  missingChat = 'deleted-chat';
  transcript = [message('u2', 'user', 'Use pnpm for this repository.')];
  helper.mockResolvedValue({
    value: {
      facts: [
        {
          text: 'Use pnpm.',
          evidence: [
            {
              turnId: 'u2',
              role: 'user',
              quote: 'Use pnpm for this repository.',
            },
          ],
        },
      ],
    },
    usage: {},
  });
  await expect(
    learnFromChats({ scope: 'workspace', workspaceId: 'project' }),
  ).resolves.toEqual({ status: 'learned', notes: 1 });
  expect(reads).toEqual(['deleted-chat', 'kept-chat']);
  expect(
    (
      await readLearningState(
        localMemoryScopeDir({ scope: 'workspace', workspaceId: 'project' }),
      )
    ).turns,
  ).toEqual([]);
});

test('flag-off core learning does no account, transcript, model or storage work', async () => {
  flag = false;
  jest.mocked(peekCanopyCloudAccountId).mockClear();
  await expect(
    learnFromChats({ scope: 'workspace', workspaceId: 'project' }),
  ).resolves.toEqual({ status: 'skipped', notes: 0 });
  expect(peekCanopyCloudAccountId).not.toHaveBeenCalled();
  expect(reads).toEqual([]);
  expect(helper).not.toHaveBeenCalled();
});

test.each(['cold', 'oversized', 'empty'])(
  'bounded attempts advance past %s chats without retiring their eligible turns',
  async (kind) => {
    deferredKind = kind;
    for (let i = 0; i < 10; i += 1) {
      const chat = `deferred-${i}`;
      deferredChats.add(chat);
      await queue('project', chat, 'u1');
      await queue('project', chat, 'u2');
    }
    await queue('project', 'readable-chat', 'u1');
    const scope = { scope: 'workspace' as const, workspaceId: 'project' };
    expect(await learnFromChats(scope)).toEqual({
      status: 'skipped',
      notes: 0,
    });
    expect(reads).toHaveLength(10);
    expect(helper).not.toHaveBeenCalled();
    const before = await readLearningState(localMemoryScopeDir(scope));
    expect(before.turns).toHaveLength(21);
    expect(before.lastAttemptAt).toBeUndefined();
    // A concurrent recorder update must preserve the durable cursor and FIFO.
    await queue('project', 'deferred-0', 'u3');
    const retained = await readLearningState(localMemoryScopeDir(scope));
    expect(await learnFromChats(scope)).toEqual({
      status: 'learned',
      notes: 1,
    });
    expect(reads).toHaveLength(11);
    expect(reads[10]).toBe('readable-chat');
    expect(helper).toHaveBeenCalledTimes(1);
    expect(
      (await localMemoryStore.listDocuments(scope))[0]?.source?.chatId,
    ).toBe('readable-chat');
    const after = await readLearningState(localMemoryScopeDir(scope));
    expect(after.turns).toEqual(
      retained.turns.filter((turn) => turn.chatId !== 'readable-chat'),
    );
  },
);

test('missing structured extraction preserves eligible turns and its spending reservation', async () => {
  await queue();
  const usage = { totalCostUsd: 0.01 };
  helper.mockResolvedValueOnce({ value: null, usage });
  const scope = { scope: 'workspace' as const, workspaceId: 'project' };
  await expect(learnFromChats(scope)).rejects.toMatchObject({ usage });
  expect((await readLearningState(localMemoryScopeDir(scope))).turns).toEqual([
    expect.objectContaining({ userMessageId: 'u1', chatId: 'chat' }),
  ]);
  expect(await localMemoryStore.listDocuments(scope)).toEqual([]);
  expect(
    await reserveLearningBudget(
      join(root, 'memory-learning-budget'),
      Date.now(),
    ),
  ).toBe(false);
});

test('a valid empty extraction consumes evidence without creating notes', async () => {
  await queue();
  helper.mockResolvedValueOnce({ value: { facts: [] }, usage: {} });
  const scope = { scope: 'workspace' as const, workspaceId: 'project' };
  await expect(learnFromChats(scope)).resolves.toEqual({
    status: 'learned',
    notes: 0,
  });
  expect((await readLearningState(localMemoryScopeDir(scope))).turns).toEqual(
    [],
  );
  expect(await localMemoryStore.listDocuments(scope)).toEqual([]);
});
