import { runtimeChatEventToPortalMessage } from '@canopy/agent-transcript/portal/runtime-chat-projection';
import type { CoreChatSendReceiptResult } from '@canopy/protocol/canopy-core';
import type {
  ChatCommandRequest,
  ChatCommandResult,
  ChatCommandExecutionOptions,
} from '@canopy/desktop-shared/types';
import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from '../../../__tests__/helpers/chat-state-service-fixture';
import { handlePortalChatRetryFailure } from '../chat-retry-failure-adapter';
import type { PortalAdapterContext } from '../types';
import type { PortalChatRetryFailurePayload } from '@canopy/protocol/portal';
import { hasActiveTransientRetryForChat } from '../../../lib/transient-error-retry-service';
import {
  queryPortalChatState,
  queryPortalChatTranscriptPage,
} from '../chat-state-query';
jest.mock('../../../lib/transient-error-retry-service', () => ({
  hasActiveTransientRetryForChat: jest.fn(() => false),
}));
jest.mock('../chat-state-query', () => ({
  queryPortalChatState: jest.fn(),
  queryPortalChatTranscriptPage: jest.fn(),
}));
jest.mock('../../../observability', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };
const target = { ...scope, chatId: 'chat-1' };
const body = JSON.stringify({
  error: {
    canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
    code: 'upstream_unavailable',
  },
});
let fixture: ChatStateServiceFixture;
let context: PortalAdapterContext;
const completeMock = jest.fn();
const failMock = jest.fn();
const dispatchMock = jest.fn<
  Promise<ChatCommandResult>,
  [ChatCommandRequest, ChatCommandExecutionOptions?]
>();
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(hasActiveTransientRetryForChat).mockReturnValue(false);
  fixture = createChatStateServiceFixture();
  await fixture.createChat(scope);
  await fixture.repository.transact(
    scope,
    [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'prompt-1',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Fix my file' }],
          inputMode: 'voice',
        },
      },
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'failure-1',
          role: 'system',
          timestamp: 2,
          blocks: [{ type: 'text', text: body }],
        },
      },
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: { turnEnds: { 'prompt-1': { outcome: 'failed', endedAt: 3 } } },
      },
      {
        type: 'runtime.patched',
        chatId: 'chat-1',
        runtime: {
          status: 'failed',
          queuedMessageIds: [],
          activeTurn: { userMessageId: 'prompt-1', startedAt: 1 },
        },
      },
    ],
    { source: 'provider' },
  );
  jest
    .mocked(queryPortalChatState)
    .mockImplementation((_ctx, request) => fixture.service.getState(request));
  jest
    .mocked(queryPortalChatTranscriptPage)
    .mockImplementation((_ctx, request) =>
      fixture.service.getTranscriptPage(request),
    );
  context = {
    sessionId: 'session-1',
    canReadAssets: (): boolean => true,
    chatStatePort: fixture.service,
    getWindow: (): null => null,
    enqueueEvent: jest.fn(),
    complete: completeMock,
    fail: failMock,
    queryChatSendReceipt: async (
      request,
    ): Promise<CoreChatSendReceiptResult> => {
      if (!request.scope.chatId || !request.identity)
        throw new Error('missing receipt identity');
      const result = await fixture.service.getPortalSendReceipt({
        ...scope,
        commandId: request.commandId,
        identity: {
          chatId: request.scope.chatId,
          userMessageId: request.identity.userMessageId,
          fingerprint: request.identity.fingerprint,
        },
      });
      return result;
    },
    dispatchChatCommand: dispatchMock.mockImplementation((request, options) =>
      fixture.service.command(request, options),
    ),
  };
});
afterEach(async () => {
  await fixture.dispose();
});
async function run(
  action: 'check' | 'retry' = 'retry',
  key = 'retry-1',
  override: Partial<PortalChatRetryFailurePayload> = {},
): Promise<void> {
  const payload: PortalChatRetryFailurePayload = {
    ...target,
    turnId: 'prompt-1',
    failedMessageId: 'failure-1',
    ...override,
    ...(action === 'check' ? { action } : { action, idempotencyKey: key }),
  };
  await handlePortalChatRetryFailure(
    {
      id: `wire-${key}`,
      type: 'portal.chat.retry_failure',
      payload,
      sequence: 1,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    },
    context,
  );
}
it('advertises only a terminal current failure, then accepts duplicate requests exactly once', async () => {
  await run('check');
  expect(completeMock).toHaveBeenLastCalledWith(expect.anything(), {
    available: true,
  });
  await Promise.all([run(), run()]);
  expect(failMock).not.toHaveBeenCalled();
  const page = await fixture.service.getTranscriptPage(target);
  expect(
    page.messages.filter((m) => m.role === 'user').map((m) => m.id),
  ).toEqual(['prompt-1', 'retry-1']);
  const retried = page.messages.find((m) => m.id === 'retry-1');
  expect(retried?.inputMode).toBe('voice');
  expect(retried?.blocks).toContainEqual({ type: 'text', text: 'Fix my file' });
  await run();
  expect(completeMock).toHaveBeenLastCalledWith(expect.anything(), {
    outcome: 'already_applied',
    userMessageId: 'retry-1',
  });
});
it('rejects automatic retry activity and does not dispatch', async () => {
  jest.mocked(hasActiveTransientRetryForChat).mockReturnValue(true);
  await run('check');
  expect(completeMock).toHaveBeenLastCalledWith(expect.anything(), {
    available: false,
  });
  await run();
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(failMock).toHaveBeenCalledWith(
    expect.anything(),
    'conflict',
    expect.any(String),
  );
});
it('rejects a newer turn', async () => {
  await fixture.repository.transact(
    scope,
    [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'new-prompt',
          role: 'user',
          timestamp: 4,
          blocks: [{ type: 'text', text: 'new question' }],
        },
      },
    ],
    { source: 'provider' },
  );
  await run();
  expect(dispatchMock).not.toHaveBeenCalled();
});
it('rejects a nonterminal turn even if its error text already arrived', async () => {
  await fixture.repository.transact(
    scope,
    [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: { turnEnds: {} },
      },
    ],
    { source: 'provider' },
  );
  await run();
  expect(dispatchMock).not.toHaveBeenCalled();
});
it('rechecks automatic retry at canonical acceptance', async () => {
  context.dispatchChatCommand = jest.fn(async (request, options) => {
    jest.mocked(hasActiveTransientRetryForChat).mockReturnValue(true);
    return fixture.service.command(request, options);
  });
  await run();
  expect(failMock).toHaveBeenCalled();
  expect(
    (await fixture.service.getTranscriptPage(target)).messages.filter(
      (m) => m.role === 'user',
    ),
  ).toHaveLength(1);
});
it('revision fence rejects a newer turn arriving after the read', async () => {
  context.dispatchChatCommand = jest.fn(async (request, options) => {
    await fixture.repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'new-prompt',
            role: 'user',
            timestamp: 4,
            blocks: [{ type: 'text', text: 'new question' }],
          },
        },
      ],
      { source: 'provider' },
    );
    return fixture.service.command(request, options);
  });
  await run();
  expect(failMock).toHaveBeenCalled();
  expect(
    (await fixture.service.getTranscriptPage(target)).messages.some(
      (m) => m.id === 'retry-1',
    ),
  ).toBe(false);
});

it('does not accept an idempotency key reused for a different failed prompt', async () => {
  await run();
  await run('retry', 'retry-1', { failedMessageId: 'other-failure' });
  expect(failMock).toHaveBeenLastCalledWith(
    expect.anything(),
    'conflict',
    expect.any(String),
  );
  expect(
    (await fixture.service.getTranscriptPage(target)).messages.filter(
      (m) => m.role === 'user',
    ),
  ).toHaveLength(2);
});
it('rejects a different failure notice in the same turn', async () => {
  await run('retry', 'retry-1', { failedMessageId: 'old-failure' });
  expect(dispatchMock).not.toHaveBeenCalled();
});
it('pairing revocation at commit leaves the prompt unsent', async () => {
  let allowed = true;
  context.canReadAssets = (): boolean => allowed;
  context.dispatchChatCommand = jest.fn(async (request, options) => {
    allowed = false;
    return fixture.service.command(request, options);
  });
  await run();
  expect(failMock).toHaveBeenCalled();
  expect(
    (await fixture.service.getTranscriptPage(target)).messages.filter(
      (m) => m.role === 'user',
    ),
  ).toHaveLength(1);
});

it('two independent retry keys cannot send the same failure twice', async () => {
  await Promise.all([run('retry', 'retry-a'), run('retry', 'retry-b')]);
  const users = (
    await fixture.service.getTranscriptPage(target)
  ).messages.filter((message) => message.role === 'user');
  expect(users).toHaveLength(2);
  expect(
    users.filter((message) => message.id.startsWith('retry-')),
  ).toHaveLength(1);
});
it('ordinary desktop sends keep their existing non-revisioned behavior', async () => {
  const result = await fixture.service.command({
    schemaVersion: 1,
    commandId: 'desktop-send',
    ...scope,
    expectedRevision: 0,
    command: {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'desktop-message',
      text: 'Normal desktop send',
    },
  });
  expect(result.outcome).toBe('applied');
});

it('recognizes the host-projected live refusal id through its canonical execution timer', async () => {
  await fixture.repository.transact(
    scope,
    [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'execution-1:timer',
          role: 'system',
          timestamp: 3,
          blocks: [
            {
              type: 'turn_timer',
              turnId: 'execution-1',
              userMessageId: 'prompt-1',
              startedAt: 1,
              completedAt: 3,
            },
          ],
        },
      },
    ],
    { source: 'provider' },
  );
  const projected = runtimeChatEventToPortalMessage({
    scope: 'worktree',
    chatId: 'chat-1',
    fallbackMessageId: 'prompt-1:assistant',
    data: {
      type: 'codex',
      canopy_execution_turn_id: 'execution-1',
      canopy_turn_user_message_id: 'prompt-1',
      event: { type: 'turn.failed', error: { message: body } },
    },
  });
  if (!projected) throw new Error('Missing projected refusal');
  const failedMessageId = projected.messageId;
  await run('check', 'wire-check', { failedMessageId });
  expect(completeMock).toHaveBeenLastCalledWith(expect.anything(), {
    available: true,
  });
  await run('retry', 'retry-live', { failedMessageId });
  expect(failMock).not.toHaveBeenCalled();
  expect(
    (await fixture.service.getTranscriptPage(target)).messages.filter(
      (message) => message.role === 'user',
    ),
  ).toHaveLength(2);
});

async function seedLongFailedExecution(): Promise<string> {
  await fixture.repository.transact(
    scope,
    [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'long-execution:timer',
          role: 'system',
          timestamp: 3,
          blocks: [
            {
              type: 'turn_timer',
              turnId: 'long-execution',
              userMessageId: 'prompt-1',
              startedAt: 1,
              completedAt: 1_000,
            },
          ],
        },
      },
      ...Array.from({ length: 550 }, (_, index) => ({
        type: 'message.upserted' as const,
        chatId: 'chat-1',
        message: {
          id: `progress-${index}`,
          role: 'system' as const,
          timestamp: index + 4,
          blocks: [{ type: 'text' as const, text: 'Provider progress' }],
        },
      })),
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'long-failure',
          role: 'system',
          timestamp: 1_000,
          blocks: [{ type: 'text', text: body }],
        },
      },
    ],
    { source: 'provider' },
  );
  const latest = await fixture.service.getTranscriptPage(target);
  expect(latest.messages).toHaveLength(500);
  expect(latest.messages.some((message) => message.id === 'prompt-1')).toBe(
    false,
  );
  expect(
    latest.messages.some((message) => message.id === 'long-execution:timer'),
  ).toBe(false);
  return 'chat-1:long-execution:proxy-refusal';
}

it('recovers the current failed prompt and execution beyond the default transcript page', async () => {
  const failedMessageId = await seedLongFailedExecution();
  await run('check', 'long-check', { failedMessageId });
  expect(completeMock).toHaveBeenLastCalledWith(expect.anything(), {
    available: true,
  });
  await Promise.all([
    run('retry', 'long-retry', { failedMessageId }),
    run('retry', 'long-retry', { failedMessageId }),
  ]);
  expect(failMock).not.toHaveBeenCalled();
  const retried = (
    await fixture.service.getTranscriptPage(target)
  ).messages.filter((message) => message.id === 'long-retry');
  expect(retried).toHaveLength(1);
  expect(retried[0]?.blocks).toContainEqual({
    type: 'text',
    text: 'Fix my file',
  });
  expect(retried[0]?.inputMode).toBe('voice');
});

it('rejects the paged failure when a newer user turn exists', async () => {
  const failedMessageId = await seedLongFailedExecution();
  await fixture.repository.transact(
    scope,
    [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'newer-user-turn',
          role: 'user',
          timestamp: 1_001,
          blocks: [{ type: 'text', text: 'A different request' }],
        },
      },
    ],
    { source: 'renderer-command' },
  );
  await run('check', 'newer-check', { failedMessageId });
  expect(completeMock).toHaveBeenLastCalledWith(expect.anything(), {
    available: false,
  });
  await run('retry', 'newer-retry', { failedMessageId });
  expect(dispatchMock).not.toHaveBeenCalled();
});

it('rejects a projected notice from an older execution of the same prompt', async () => {
  await fixture.repository.transact(
    scope,
    [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'execution-2:timer',
          role: 'system',
          timestamp: 3,
          blocks: [
            {
              type: 'turn_timer',
              turnId: 'execution-2',
              userMessageId: 'prompt-1',
              startedAt: 1,
              completedAt: 3,
            },
          ],
        },
      },
    ],
    { source: 'provider' },
  );
  await run('retry', 'retry-old', {
    failedMessageId: 'chat-1:execution-1:proxy-refusal',
  });
  expect(dispatchMock).not.toHaveBeenCalled();
});
