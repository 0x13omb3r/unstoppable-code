import { recordConsolidationRun } from '../../memory/local/consolidation-state';
import type * as WorkerThreads from 'node:worker_threads';
import { buildSync } from 'esbuild';
import { fstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTranscriptLog } from '../../lib/chat-transcript-log';
import { runChatLearningWorker } from '../../memory/local/transcript-learning-runner';
import { CHAT_LEARNING_WORKER_LIMITS } from '../../memory/local/transcript-learning-protocol';
import { localMemoryStore } from '../../memory/local/memory-store';
import { setLocalMemoryReplicaLocator } from '../../memory/local/scope-resolver';
import { installChatLearningFlagSource } from '../../memory/local/transcript-learning-gate';
import { isE2eBuild } from '../../lib/e2e-gate';
import { runChatLearningPassForE2e } from '../../memory/local/transcript-learning-e2e';
import {
  startLocalMemoryConsolidationScheduler,
  stopLocalMemoryConsolidationScheduler,
  localMemoryConsolidationSchedulerTestExports,
} from '../../memory/local/consolidation-scheduler';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';

let entry = '';
let root = '';
let directory = '';
jest.mock('node:worker_threads', (): object => {
  const actual = jest.requireActual<typeof WorkerThreads>(
    'node:worker_threads',
  );
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(_filename: string, options: WorkerThreads.WorkerOptions) {
        super(
          _filename.endsWith('local-memory-chat-learning-worker.js')
            ? entry
            : _filename,
          options,
        );
      }
    },
  };
});
jest.mock('../../agents/session-manager', (): object => ({
  getAllActiveSessionInfos: () => [],
  subscribeChatSessionActivity: () => (): void => {},
}));
jest.mock('../../lib/e2e-gate', (): object => ({
  isE2eBuild: jest.fn(() => false),
}));
jest.mock('../../lib/preferences-store', (): object => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ localMemoryEnabled: true }),
  ),
}));
jest.mock('../../memory/local/consolidation-state', (): object => ({
  readConsolidationState: () => Promise.resolve(null),
  recordConsolidationRun: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../memory/local/transcript-learning-request', (): object => {
  throw new Error('Flag-off scheduler imported learning');
});
jest.mock('../../memory/local/consolidation-task', (): object => ({
  collectConsolidationInput: () =>
    Promise.resolve({
      inboxFiles: [],
      importFiles: [],
      indexWithinLimits: true,
    }),
}));

const row = (id: string, text: string): PersistedChatMessage => ({
  id,
  role: 'user',
  timestamp: Date.now(),
  blocks: [{ type: 'text', text }],
});
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'learning-thread-'));
  entry = join(directory, 'worker.cjs');
  buildSync({
    entryPoints: [
      'apps/desktop-app/src/main/memory/local/transcript-learning-worker.ts',
    ],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'learning-files-'));
  setLocalMemoryReplicaLocator({
    signedInAccountId: () => 'account',
    replicaDir: () => join(root, 'memory'),
  });
});
afterEach(() => {
  jest.useRealTimers();
  localMemoryConsolidationSchedulerTestExports.reset();
  setLocalMemoryReplicaLocator(null);
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test('shipping flag-off scheduler takes one flag read without importing or awaiting learning', async () => {
  const flagRead = jest.fn(() => false);
  installChatLearningFlagSource({
    isEnabled: flagRead,
    subscribe: () => (): void => {},
  });
  startLocalMemoryConsolidationScheduler();
  try {
    await expect(
      localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation({
        scopeDir: root,
      }),
    ).resolves.toBeUndefined();
    expect(flagRead).toHaveBeenCalledTimes(1);
    expect(recordConsolidationRun).not.toHaveBeenCalled();
  } finally {
    stopLocalMemoryConsolidationScheduler();
  }
});

test('the benchmark pass refuses production and malformed scopes; E2E still has no automatic scheduler', async () => {
  const flagRead = jest.fn(() => false);
  installChatLearningFlagSource({
    isEnabled: flagRead,
    subscribe: () => (): void => {},
  });
  await expect(runChatLearningPassForE2e({ scope: 'user' })).rejects.toThrow(
    'unavailable',
  );
  expect(flagRead).not.toHaveBeenCalled();
  jest.mocked(isE2eBuild).mockReturnValue(true);
  try {
    await expect(
      runChatLearningPassForE2e({ scope: 'workspace' }),
    ).rejects.toThrow();
    await expect(
      runChatLearningPassForE2e({ scope: 'user', workspaceId: 'other' }),
    ).rejects.toThrow();
    startLocalMemoryConsolidationScheduler();
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      { scopeDir: root },
    );
    expect(flagRead).not.toHaveBeenCalled();
    await runChatLearningPassForE2e({ scope: 'user' });
    expect(flagRead).toHaveBeenCalledTimes(1);
    // The one-shot admission must not leave the scheduler enabled afterward.
    await localMemoryConsolidationSchedulerTestExports.attemptScopeConsolidation(
      { scopeDir: root },
    );
    expect(flagRead).toHaveBeenCalledTimes(1);
    expect(recordConsolidationRun).not.toHaveBeenCalled();
  } finally {
    jest.mocked(isE2eBuild).mockReturnValue(false);
  }
});

test('pinned canonical bytes become redacted sourced notes through the real bounded thread and canonical writer', async () => {
  const log = new ChatTranscriptLog(join(root, 'transcripts'));
  await log.replace(
    'chat',
    [
      row('excluded', 'Do not learn this.'),
      row('u1', 'Use pnpm. api_key=sk-1234567890abcdefghijklmnop'),
    ],
    1,
  );
  const preview = await log.captureCommittedPreview(
    'chat',
    await log.descriptor('chat'),
  );
  try {
    const result = await preview.consumeCommittedInThread(
      (snapshot, signal) =>
        runChatLearningWorker(
          { kind: 'extract', snapshot, allowed: ['u1'] },
          signal,
        ),
      CHAT_LEARNING_WORKER_LIMITS,
    );
    expect(result.kind).toBe('evidence');
    if (result.kind !== 'evidence') throw new Error('Missing evidence');
    expect(result.prompt).not.toContain('Do not learn this');
    expect(result.prompt).not.toContain('1234567890abcdefghijklmnop');
    const rendered = await runChatLearningWorker(
      {
        kind: 'render',
        evidence: result.evidence,
        value: {
          facts: [
            {
              text: 'Use pnpm.',
              evidence: [{ turnId: 'u1', role: 'user', quote: 'Use pnpm.' }],
            },
          ],
        },
        source: { provider: 'chat-extraction', chatId: 'chat' },
      },
      new AbortController().signal,
    );
    if (rendered.kind !== 'notes') throw new Error('Missing notes');
    const scope = { scope: 'workspace' as const, workspaceId: 'project' };
    await localMemoryStore.savePreparedNote(scope, rendered.notes[0]);
    expect(
      (await localMemoryStore.listDocuments(scope))[0]?.source?.chatId,
    ).toBe('chat');
    preview.assertComplete();
  } finally {
    await preview.close();
  }
});

test('the thread refuses corrupt digests and host capture defers active or oversized input', async () => {
  const log = new ChatTranscriptLog(join(root, 'transcripts'));
  await log.replace('chat', [row('u1', 'Use pnpm.')], 1);
  const descriptor = await log.descriptor('chat');
  await expect(
    log.captureCommittedPreview('chat', {
      ...descriptor,
      hasActiveSidecar: true,
    }),
  ).rejects.toThrow('bounded committed');
  await expect(
    log.captureCommittedPreview('chat', {
      ...descriptor,
      committedByteLength: 17 * 1024 * 1024,
    }),
  ).rejects.toThrow('bounded committed');
  const preview = await log.captureCommittedPreview('chat', descriptor);
  try {
    await expect(
      preview.consumeCommittedInThread(
        (snapshot, signal) =>
          runChatLearningWorker(
            {
              kind: 'extract',
              snapshot: { ...snapshot, digest: '0'.repeat(64) },
              allowed: ['u1'],
            },
            signal,
          ),
        CHAT_LEARNING_WORKER_LIMITS,
      ),
    ).rejects.toThrow();
  } finally {
    await preview.close();
  }
});

test('deadline and cancellation stop the thread before releasing borrowed descriptors', async () => {
  const previous = entry;
  const blocked = join(directory, 'blocked.cjs');
  writeFileSync(blocked, 'while (true) {}');
  entry = blocked;
  const request = {
    kind: 'extract' as const,
    snapshot: { fd: 0, size: 0, count: 0, digest: '0'.repeat(64) },
    allowed: [],
  };
  try {
    const controller = new AbortController();
    const cancelled = expect(
      runChatLearningWorker(request, controller.signal),
    ).rejects.toThrow('cancelled');
    controller.abort();
    await cancelled;
    jest.useFakeTimers();
    const timeout = expect(
      runChatLearningWorker(request, new AbortController().signal),
    ).rejects.toThrow('timed out');
    jest.advanceTimersByTime(5000);
    await timeout;
  } finally {
    entry = previous;
  }
});

test('preview close retains the borrowed descriptor until thread teardown settles', async () => {
  const log = new ChatTranscriptLog(join(root, 'transcripts'));
  await log.replace('chat', [row('u1', 'Use pnpm.')], 1);
  const preview = await log.captureCommittedPreview(
    'chat',
    await log.descriptor('chat'),
  );
  let release: () => void = () => {};
  const teardown = new Promise<void>((resolve) => {
    release = resolve;
  });
  let borrowedFd = -1;
  const pending = preview.consumeCommittedInThread(async (snapshot, signal) => {
    borrowedFd = snapshot.fd;
    try {
      await runChatLearningWorker(
        { kind: 'extract', snapshot, allowed: ['u1'] },
        signal,
      );
    } finally {
      await teardown;
    }
  }, CHAT_LEARNING_WORKER_LIMITS);
  const outcome = expect(pending).rejects.toThrow();
  const closing = preview.close();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(() => fstatSync(borrowedFd)).not.toThrow();
  } finally {
    release();
    await outcome;
    await closing;
  }
  expect(() => fstatSync(borrowedFd)).toThrow();
});

test('many short messages respect the entry cap and still verify the complete digest', async () => {
  const log = new ChatTranscriptLog(join(root, 'transcripts'));
  const messages: PersistedChatMessage[] = [
    row('u1', 'x'),
    ...Array.from({ length: 300 }, (_, i) => ({
      ...row(`a${i}`, 'x'),
      role: 'assistant' as const,
    })),
  ];
  await log.replace('chat', messages, 1);
  const descriptor = await log.descriptor('chat');
  for (const corrupt of [false, true]) {
    const preview = await log.captureCommittedPreview('chat', descriptor);
    try {
      const pending = preview.consumeCommittedInThread(
        (snapshot, signal) =>
          runChatLearningWorker(
            {
              kind: 'extract',
              snapshot: {
                ...snapshot,
                ...(corrupt ? { digest: '0'.repeat(64) } : {}),
              },
              allowed: ['u1'],
            },
            signal,
          ),
        CHAT_LEARNING_WORKER_LIMITS,
      );
      if (corrupt) await expect(pending).rejects.toThrow();
      else {
        const result = await pending;
        if (result.kind !== 'evidence') throw new Error('Missing evidence');
        expect(result.evidence).toHaveLength(256);
        preview.assertComplete();
      }
    } finally {
      await preview.close();
    }
  }
});
