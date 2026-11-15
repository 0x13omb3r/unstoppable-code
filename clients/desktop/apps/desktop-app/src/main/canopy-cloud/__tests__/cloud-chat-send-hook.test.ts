import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_CATALOG_QUERY_DEFINITIONS,
  CoreChatArchiveParamsSchema,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import type { RelayBindingConnection } from '../../canopy-runtime/renderer-relay/definitions';
import type { KeepInStepOutcome } from '../../skills/publish-skill-to-cloud';
import {
  cloudChatSelectionReadParams,
  withCloudChatSendHook,
  withCloudChatSendHookProvider,
  type CloudChatSendHookDeps,
} from '../cloud-chat-send-hook';
import {
  CloudTurnNoticeStore,
  MAX_NOTED_TURNS_PER_CHAT,
  MAX_NOTICES_PER_TURN,
} from '../cloud-turn-notices';

const SEND_PARAMS = {
  scope: { workspaceId: 'ws-1', worktreeId: 'task-1' },
  commandId: 'cmd-1',
  chatId: 'chat-1',
  messageId: 'msg-1',
  text: 'Go',
  _meta: { idempotencyKey: 'cmd-1' },
};

const request = (
  method: `core.${string}.${string}`,
  params: Record<string, unknown>,
): CanopyJsonRpcMessage => ({
  jsonrpc: '2.0',
  id: 'req-1',
  method,
  params,
});

interface Harness {
  sent: CanopyJsonRpcMessage[];
  /** Hands the next message to `connection.receive`. */
  deliver: (message: CanopyJsonRpcMessage) => Promise<CanopyJsonRpcMessage>;
  connection: RelayBindingConnection;
  store: CloudTurnNoticeStore;
  keptInStep: (readonly string[])[];
  dir: string;
}

function harness(
  outcome: () => Promise<KeepInStepOutcome>,
  overrides: Partial<CloudChatSendHookDeps> = {},
  timeoutMs?: number,
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-turn-notices-'));
  const store = CloudTurnNoticeStore.inDataDir(dir);
  const sent: CanopyJsonRpcMessage[] = [];
  const keptInStep: (readonly string[])[] = [];
  const incoming: CanopyJsonRpcMessage[] = [];
  const inner: RelayBindingConnection = {
    connectionId: 'conn-1',
    signal: new AbortController().signal,
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    receive: () => {
      const next = incoming.shift();
      return next
        ? Promise.resolve(next)
        : Promise.reject(new Error('nothing to receive'));
    },
    openChannel: () => Promise.reject(new Error('unused')),
    onChannel: () => () => undefined,
    close: () => undefined,
  };
  const deps: CloudChatSendHookDeps = {
    accountId: () => Promise.resolve('acct-1'),
    hasKeepInStepSkills: () => Promise.resolve(true),
    selectedItemIds: () =>
      Promise.resolve([
        'skill:cloud-custom/remote-1',
        'plugin:marketplace:m/p',
        'skill:cloud-curated/c',
      ]),
    keepInStep: (remoteIds) => {
      keptInStep.push(remoteIds);
      return outcome();
    },
    recordNotices: (...args) => store.record(...args),
    pruneNotices: (...args) => store.prune(...args),
    ...overrides,
  };
  const connection = withCloudChatSendHook(inner, deps, timeoutMs);
  return {
    sent,
    deliver: (message) => {
      incoming.push(message);
      return connection.receive();
    },
    keptInStep,
    store,
    dir,
    connection,
  };
}

describe('desktop cloud chat send hook (CAN-6176, D9 revised)', () => {
  it('reads the chat selection in the only shape the web core accepts', () => {
    const send = {
      workspaceId: 'ws-1',
      worktreeId: 'task-1',
      chatId: 'chat-1',
      messageId: 'msg-1',
    };
    const params = cloudChatSelectionReadParams(send);
    const parsed =
      CORE_CATALOG_QUERY_DEFINITIONS[
        'core.catalog.selection.get'
      ].params.safeParse(params);
    expect(parsed.error).toBeUndefined();
    // The web core refuses a target, and any scope but the chat alone or the
    // workspace alone, so the protocol schema's wider shape is not enough.
    expect(parsed.data).toEqual({ scope: { chatId: 'chat-1' } });
  });

  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the selected cloud skills in step before the send goes, and notes nothing when it worked', async () => {
    const h = harness(() =>
      Promise.resolve({ republished: ['helper'], usedLastCopy: [] }),
    );
    cleanup.push(h.dir);
    await h.connection.send(request('core.chat.message.send', SEND_PARAMS));
    expect(h.keptInStep).toEqual([['remote-1']]);
    expect(h.sent).toHaveLength(1);
    expect(h.store.list('acct-1', 'chat-1')).toEqual({});
  });

  it('notes the turn when a republish failed, and the send still goes unchanged', async () => {
    const h = harness(() =>
      Promise.resolve({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'failed' }],
      }),
    );
    cleanup.push(h.dir);
    const send = request('core.chat.message.send', SEND_PARAMS);
    await h.connection.send(send);
    expect(h.sent).toEqual([send]);
    // Nothing yet: the turn is named by the send's receipt.
    expect(h.store.list('acct-1', 'chat-1')).toEqual({});
    const receipt: CanopyJsonRpcMessage = {
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        commandId: 'cmd-1',
        revision: 3,
        outcome: 'applied',
        // The web core's own id for the prompt, which the transcript turn
        // carries; never the send's `messageId`.
        messageId: 'transcript-msg-9',
      },
    };
    // The receipt passes through unchanged.
    await expect(h.deliver(receipt)).resolves.toEqual(receipt);
    expect(h.store.list('acct-1', 'chat-1')).toEqual({
      'transcript-msg-9': [{ kind: 'capability_copy_stale', name: 'helper' }],
    });
    // Never under the send's own messageId, which no transcript turn carries.
    expect(Object.keys(h.store.list('acct-1', 'chat-1'))).not.toContain(
      SEND_PARAMS.messageId,
    );
    // Another account sees none of it.
    expect(h.store.list('acct-2', 'chat-1')).toEqual({});
  });

  it('notes nothing on a send the core refused', async () => {
    const h = harness(() =>
      Promise.resolve({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'timed_out' }],
      }),
    );
    cleanup.push(h.dir);
    await h.connection.send(request('core.chat.message.send', SEND_PARAMS));
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: -32600, message: 'refused' },
    });
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { commandId: 'cmd-1', revision: 0, outcome: 'rejected' },
    });
    expect(h.store.list('acct-1', 'chat-1')).toEqual({});
  });

  it('notes the turn an uncertain send landed, once its receipt query matches it', async () => {
    const h = harness(() =>
      Promise.resolve({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'failed' }],
      }),
    );
    cleanup.push(h.dir);
    await h.connection.send(request('core.chat.message.send', SEND_PARAMS));
    // The send's answer was lost: it may have landed (same_idempotency_key).
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-1',
      error: {
        code: -32603,
        message: 'unavailable',
        data: {
          kind: 'unavailable',
          message: 'The response was lost; the send may have landed.',
          retry: { kind: 'same_idempotency_key' },
        },
      },
    });
    expect(h.store.list('acct-1', 'chat-1')).toEqual({});
    // Another send's receipt query is not this one's.
    await h.connection.send({
      ...request('core.chat.send.receipt', {
        scope: { workspaceId: 'ws-1', worktreeId: 'task-1', chatId: 'chat-1' },
        commandId: 'cmd-other',
      }),
      id: 'req-2',
    });
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-2',
      result: {
        outcome: 'matched',
        receipt: {
          commandId: 'cmd-other',
          revision: 2,
          outcome: 'applied',
          messageId: 'transcript-msg-other',
        },
      },
    });
    expect(h.store.list('acct-1', 'chat-1')).toEqual({});
    // The renderer's recovery asks after this send's command and finds it.
    await h.connection.send({
      ...request('core.chat.send.receipt', {
        scope: { workspaceId: 'ws-1', worktreeId: 'task-1', chatId: 'chat-1' },
        commandId: 'cmd-1',
      }),
      id: 'req-3',
    });
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-3',
      result: {
        outcome: 'matched',
        receipt: {
          commandId: 'cmd-1',
          revision: 3,
          outcome: 'applied',
          messageId: 'transcript-msg-9',
        },
      },
    });
    expect(h.store.list('acct-1', 'chat-1')).toEqual({
      'transcript-msg-9': [{ kind: 'capability_copy_stale', name: 'helper' }],
    });
  });

  it('notes the turn when the receipt query comes on a new connection after the old one dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-turn-notices-'));
    cleanup.push(dir);
    const store = CloudTurnNoticeStore.inDataDir(dir);
    const opened: { deliver: (message: CanopyJsonRpcMessage) => void }[] = [];
    const provider = withCloudChatSendHookProvider(
      () => {
        const incoming: CanopyJsonRpcMessage[] = [];
        opened.push({ deliver: (message) => incoming.push(message) });
        const connection: RelayBindingConnection = {
          connectionId: `conn-${opened.length}`,
          signal: new AbortController().signal,
          send: () => Promise.resolve(),
          receive: () => {
            const next = incoming.shift();
            return next
              ? Promise.resolve(next)
              : Promise.reject(new Error('nothing to receive'));
          },
          openChannel: () => Promise.reject(new Error('unused')),
          onChannel: () => () => undefined,
          close: () => undefined,
        };
        return Promise.resolve(connection);
      },
      {
        accountId: () => Promise.resolve('acct-1'),
        hasKeepInStepSkills: () => Promise.resolve(true),
        selectedItemIds: () => Promise.resolve(['skill:cloud-custom/remote-1']),
        keepInStep: () =>
          Promise.resolve({
            republished: [],
            usedLastCopy: [{ name: 'helper', reason: 'failed' }],
          }),
        recordNotices: (...args) => store.record(...args),
        pruneNotices: (...args) => store.prune(...args),
      },
    );
    const input: Parameters<typeof provider>[0] = {
      caller: {
        principalId: 'acct-1',
        clientInstanceId: 'window-1',
        authorityId: 'desktop',
        interfaceKind: 'desktop',
        grants: [],
      },
      webContentsId: 1,
      signal: new AbortController().signal,
    };
    const first = await provider(input);
    await first.send(request('core.chat.message.send', SEND_PARAMS));
    // The connection drops before the send's answer arrives.
    const second = await provider(input);
    await second.send({
      ...request('core.chat.send.receipt', {
        scope: { workspaceId: 'ws-1', worktreeId: 'task-1', chatId: 'chat-1' },
        commandId: 'cmd-1',
      }),
      id: 'req-2',
    });
    opened[1]?.deliver({
      jsonrpc: '2.0',
      id: 'req-2',
      result: {
        outcome: 'matched',
        receipt: {
          commandId: 'cmd-1',
          revision: 3,
          outcome: 'applied',
          messageId: 'transcript-msg-9',
        },
      },
    });
    await second.receive();
    expect(store.list('acct-1', 'chat-1')).toEqual({
      'transcript-msg-9': [{ kind: 'capability_copy_stale', name: 'helper' }],
    });
  });

  it('notes nothing when the receipt query finds the uncertain send never landed', async () => {
    const h = harness(() =>
      Promise.resolve({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'failed' }],
      }),
    );
    cleanup.push(h.dir);
    await h.connection.send(request('core.chat.message.send', SEND_PARAMS));
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-1',
      error: {
        code: -32603,
        message: 'unavailable',
        data: {
          kind: 'unavailable',
          message: 'The response was lost; the send may have landed.',
          retry: { kind: 'same_idempotency_key' },
        },
      },
    });
    const query = {
      ...request('core.chat.send.receipt', {
        scope: { workspaceId: 'ws-1', worktreeId: 'task-1', chatId: 'chat-1' },
        commandId: 'cmd-1',
      }),
      id: 'req-2',
    };
    await h.connection.send(query);
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-2',
      result: { outcome: 'missing' },
    });
    // Settled: a later query matching the command finds nothing owed.
    await h.connection.send({ ...query, id: 'req-3' });
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-3',
      result: {
        outcome: 'matched',
        receipt: {
          commandId: 'cmd-1',
          revision: 3,
          outcome: 'applied',
          messageId: 'transcript-msg-9',
        },
      },
    });
    expect(h.store.list('acct-1', 'chat-1')).toEqual({});
  });

  it('sends at the timeout without waiting for a slow republish', async () => {
    const h = harness(
      () => new Promise<KeepInStepOutcome>(() => undefined),
      {},
      20,
    );
    cleanup.push(h.dir);
    await h.connection.send(request('core.chat.message.send', SEND_PARAMS));
    expect(h.sent).toHaveLength(1);
  });

  it('still notes a slow republish when the reads before it ate most of the wait', async () => {
    // The selection read takes most of the hook's budget; the republish then
    // stalls, and answers at the hook's one deadline, before the send goes.
    const h = harness(
      () => new Promise<KeepInStepOutcome>(() => undefined),
      {
        selectedItemIds: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(['skill:cloud-custom/remote-1']), 120),
          ),
        // Without a deadline it would answer only at its own, much later.
        keepInStep: (_remoteIds, deadlineAt?: number) =>
          new Promise((resolve) =>
            deadlineAt === undefined
              ? undefined
              : setTimeout(
                  () =>
                    resolve({
                      republished: [],
                      usedLastCopy: [{ name: 'helper', reason: 'timed_out' }],
                    }),
                  Math.max(0, deadlineAt - Date.now()),
                ),
          ),
      },
      200,
    );
    cleanup.push(h.dir);
    await h.connection.send(request('core.chat.message.send', SEND_PARAMS));
    expect(h.sent).toHaveLength(1);
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        commandId: 'cmd-1',
        revision: 3,
        outcome: 'applied',
        messageId: 'transcript-msg-9',
      },
    });
    expect(h.store.list('acct-1', 'chat-1')).toEqual({
      'transcript-msg-9': [{ kind: 'capability_copy_stale', name: 'helper' }],
    });
  });

  it('never holds a send back on a failed read, a signed-out desktop or an unexpected shape', async () => {
    for (const overrides of [
      { selectedItemIds: (): Promise<never> => Promise.reject(new Error('x')) },
      { accountId: (): Promise<null> => Promise.resolve(null) },
      // No skill keeps its copy in step: no selection read at all.
      {
        hasKeepInStepSkills: (): Promise<boolean> => Promise.resolve(false),
        selectedItemIds: (): Promise<never> =>
          Promise.reject(new Error('read without a kept skill')),
      },
    ]) {
      const h = harness(
        () => Promise.resolve({ republished: [], usedLastCopy: [] }),
        overrides,
      );
      cleanup.push(h.dir);
      await h.connection.send(request('core.chat.message.send', SEND_PARAMS));
      expect(h.sent).toHaveLength(1);
      expect(h.keptInStep).toEqual([]);
    }
    const h = harness(() =>
      Promise.resolve({ republished: [], usedLastCopy: [] }),
    );
    cleanup.push(h.dir);
    await h.connection.send(request('core.chat.message.send', { text: 'x' }));
    await h.connection.send(request('core.chat.list', {}));
    expect(h.sent).toHaveLength(2);
    expect(h.keptInStep).toEqual([]);
  });

  it('forgets a chat’s notes when it is archived', async () => {
    const h = harness(() =>
      Promise.resolve({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'timed_out' }],
      }),
    );
    cleanup.push(h.dir);
    await h.connection.send(request('core.chat.message.send', SEND_PARAMS));
    await h.deliver({
      jsonrpc: '2.0',
      id: 'req-1',
      result: {
        commandId: 'cmd-1',
        revision: 1,
        outcome: 'applied',
        messageId: 'transcript-msg-9',
      },
    });
    expect(Object.keys(h.store.list('acct-1', 'chat-1'))).toEqual([
      'transcript-msg-9',
    ]);
    // A restore prunes nothing; the archive the desktop sends, checked
    // against the protocol's own schema, prunes the chat it closes.
    const archive = (
      action: Record<string, unknown>,
    ): Record<string, unknown> =>
      CoreChatArchiveParamsSchema.parse({
        projectId: 'ws-1',
        worktreeId: 'task-1',
        commandId: 'cmd-2',
        _meta: { idempotencyKey: 'cmd-2' },
        action,
      });
    await h.connection.send(
      request(
        'core.chat.archive',
        archive({ type: 'chat.restore_archive', archiveEntryId: 'entry-1' }),
      ),
    );
    expect(Object.keys(h.store.list('acct-1', 'chat-1'))).toEqual([
      'transcript-msg-9',
    ]);
    await h.connection.send(
      request(
        'core.chat.archive',
        archive({ type: 'chat.archive_tab', tabId: 'chat-1' }),
      ),
    );
    expect(h.store.list('acct-1', 'chat-1')).toEqual({});
    expect(h.sent).toHaveLength(3);
  });

  it('keeps the notes in a versioned file, and leaves a newer app’s file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-turn-notices-'));
    cleanup.push(dir);
    const store = CloudTurnNoticeStore.inDataDir(dir);
    const note = [{ kind: 'capability_copy_stale' as const, name: 'helper' }];
    store.record('acct-1', 'chat-1', 'msg-1', note);
    const file = join(dir, 'cloud-turn-notices.json');
    const written: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(written).toMatchObject({ version: 1 });
    expect(store.list('acct-1', 'chat-1')).toEqual({ 'msg-1': note });
    const newer = JSON.stringify({ version: 2, entries: {} });
    writeFileSync(file, newer);
    expect(store.list('acct-1', 'chat-1')).toEqual({});
    expect(() => store.record('acct-1', 'chat-1', 'msg-2', note)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(newer);
  });

  it('bounds the notes per turn and per chat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-turn-notices-'));
    cleanup.push(dir);
    const store = CloudTurnNoticeStore.inDataDir(dir);
    const many = Array.from({ length: 9 }, (_, index) => ({
      kind: 'capability_copy_stale' as const,
      name: `skill-${index}`,
    }));
    for (let turn = 0; turn < MAX_NOTED_TURNS_PER_CHAT + 5; turn += 1)
      store.record('acct-1', 'chat-1', `msg-${turn}`, many);
    const noted = store.list('acct-1', 'chat-1');
    expect(Object.keys(noted)).toHaveLength(MAX_NOTED_TURNS_PER_CHAT);
    expect(noted['msg-0']).toBeUndefined();
    expect(noted[`msg-${MAX_NOTED_TURNS_PER_CHAT + 4}`]).toHaveLength(
      MAX_NOTICES_PER_TURN,
    );
  });
});
