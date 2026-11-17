import { createHash } from 'node:crypto';
import { parseCanopyProxyError } from '@canopy/protocol/llm-gateway';
import type {
  PortalChatRetryFailurePayload,
  PortalChatRetryFailureResult,
} from '@canopy/protocol/portal';
import type {
  ChatStateSnapshot,
  PersistedChatMessage,
  PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { computeUsageLimitResumePrompt } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import { assertUntrustedChatInput } from '../../agent-messaging/untrusted-input';
import { hasActiveTransientRetryForChat } from '../../lib/transient-error-retry-service';
import { validateId, validateMessageAnchorId } from '../../lib/validation';
import {
  queryPortalChatState,
  queryPortalChatTranscriptPage,
} from './chat-state-query';
import type { PortalAdapterContext } from './types';
import { isRecord } from './validation';

/**
 * The authorized transcript port pages full rows, not individual message IDs.
 * Keep only qualification evidence while walking back: a long execution must
 * not retain every tool/progress body in memory. The cap fails closed after
 * 64 pages (at most 32,000 default-page rows), including malformed continuations.
 */
async function readFailureContext(
  context: PortalAdapterContext,
  payload: PortalChatRetryFailurePayload,
): Promise<PersistedChatMessage[]> {
  let before: number | undefined;
  let revision: number | undefined;
  let retained: PersistedChatMessage[] = [];
  for (let pageIndex = 0; pageIndex < 64; pageIndex += 1) {
    const page = await queryPortalChatTranscriptPage(context, {
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      chatId: payload.chatId,
      ...(before === undefined ? {} : { before }),
      ...(revision === undefined ? {} : { transcriptRevision: revision }),
    });
    if (revision !== undefined && page.transcriptRevision !== revision)
      return [];
    revision = page.transcriptRevision;
    const messages = [...page.messages, ...retained];
    const newest = [...messages].reverse();
    const user = newest.find((message) => message.role === 'user');
    if (user && user.id !== payload.turnId) return [];
    const failure = newest.find(
      (message) =>
        message.role !== 'user' &&
        message.blocks.some(
          (block) =>
            block.type === 'text' && parseCanopyProxyError(block.text) !== null,
        ),
    );
    const execution = newest.find((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'turn_timer' &&
          block.userMessageId === payload.turnId &&
          typeof block.completedAt === 'number',
      ),
    );
    const assistant = newest.find(
      (message) =>
        message.role === 'assistant' &&
        message.blocks.some(
          (block) => block.type === 'text' && block.text.trim().length > 0,
        ),
    );
    const evidence = new Set([user, failure, execution, assistant]);
    retained = messages.filter((message) => evidence.has(message));
    // Canonical failure IDs also support older transcripts without timers.
    // Projected live IDs still require the matching completed execution.
    if (user && (execution || failure?.id === payload.failedMessageId))
      return retained;
    if (page.before === undefined) return retained;
    if (
      !Number.isSafeInteger(page.before) ||
      page.before < 0 ||
      (before !== undefined && page.before >= before)
    )
      return [];
    before = page.before;
  }
  return [];
}

/** Current canonical turn, not the browser's cached status or a quoted error. */
function failedPrompt(
  state: ChatStateSnapshot,
  messages: readonly PersistedChatMessage[],
  payload: PortalChatRetryFailurePayload,
): PersistedChatMessage | undefined {
  const tab = state.tabsFile.tabs.find(
    (candidate) => candidate.id === payload.chatId,
  );
  const runtime = state.runtimeByChatId[payload.chatId];
  if (!tab || tab.turnEnds?.[payload.turnId]?.outcome !== 'failed')
    return undefined;
  if (
    runtime &&
    (!['idle', 'failed', 'completed', 'cancelled', 'interrupted'].includes(
      runtime.status,
    ) ||
      (runtime.activeTurn &&
        runtime.activeTurn.userMessageId !== payload.turnId) ||
      runtime.queuedMessageIds.length > 0)
  )
    return undefined;
  const user = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  if (user?.id !== payload.turnId) return undefined;
  const lastFailure = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role !== 'user' &&
        message.blocks.some(
          (block) =>
            block.type === 'text' && parseCanopyProxyError(block.text) !== null,
        ),
    );
  // Live Portal rows use the execution's stable proxy-refusal id, while
  // canonical error rows keep reducer message ids. Bind the live id to the
  // latest completed canonical execution for this same failed prompt.
  let latestExecutionId: string | undefined;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (
        block.type === 'turn_timer' &&
        block.userMessageId === payload.turnId &&
        typeof block.completedAt === 'number'
      )
        latestExecutionId = block.turnId;
    }
  }
  const projectedFailureId =
    latestExecutionId === undefined
      ? undefined
      : `${payload.chatId}:${latestExecutionId}:proxy-refusal`;
  if (
    !lastFailure ||
    (lastFailure.id !== payload.failedMessageId &&
      projectedFailureId !== payload.failedMessageId) ||
    !lastFailure.blocks.some(
      (block) =>
        block.type === 'text' &&
        parseCanopyProxyError(block.text)?.code === 'upstream_unavailable',
    ) ||
    messages.indexOf(lastFailure) < messages.indexOf(user)
  )
    return undefined;
  // A success after the notice makes that notice historical even in old files
  // whose turn-end stamp was not replaced during recovery.
  if (
    messages
      .slice(messages.indexOf(lastFailure) + 1)
      .some(
        (message) =>
          message.role === 'assistant' &&
          message.blocks.some(
            (block) => block.type === 'text' && block.text.trim().length > 0,
          ),
      )
  )
    return undefined;
  return user;
}

/** Additive capability: old hosts never receive this command. No renderer send. */
export async function handlePortalChatRetryFailure(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  let validated = false;
  try {
    const value = command.payload;
    assertUntrustedChatInput(value);
    if (!isRecord(value)) throw new Error('Invalid retry payload.');
    const { projectId, worktreeId, chatId, turnId, failedMessageId } = value;
    validateId(projectId, 'projectId');
    validateId(worktreeId, 'worktreeId');
    validateId(chatId, 'chatId');
    validateMessageAnchorId(turnId, 'turnId');
    validateMessageAnchorId(failedMessageId, 'failedMessageId');
    const failure = { projectId, worktreeId, chatId, turnId, failedMessageId };
    const payload: PortalChatRetryFailurePayload = (() => {
      if (value.action === 'check') return { ...failure, action: 'check' };
      if (value.action !== 'retry') throw new Error('Invalid retry action.');
      validateId(value.idempotencyKey, 'idempotencyKey');
      return {
        ...failure,
        action: 'retry',
        idempotencyKey: value.idempotencyKey,
      };
    })();
    if (
      (command.target?.workspaceLocalId &&
        command.target.workspaceLocalId !== projectId) ||
      (command.target?.worktreeLocalId &&
        command.target.worktreeLocalId !== worktreeId) ||
      (command.target?.chatLocalId && command.target.chatLocalId !== chatId)
    )
      throw new Error('Retry target mismatch.');
    if (
      [
        APP_ADVISOR_PROJECT_ID,
        PIPELINE_EDITOR_PROJECT_ID,
        STANDALONE_CHAT_PROJECT_ID,
      ].includes(payload.projectId)
    )
      throw new Error('This chat scope does not support failure recovery.');
    validated = true;
    const authorized = (): boolean =>
      Boolean(context.sessionId) && context.canReadAssets?.() === true;
    if (
      !authorized() ||
      !context.dispatchChatCommand ||
      !context.queryChatSendReceipt
    ) {
      context.fail(
        command,
        'permission_denied',
        'Chat recovery is unavailable.',
      );
      return;
    }
    const target = {
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      chatId: payload.chatId,
    };
    const canCommitSend = (): boolean =>
      authorized() && !hasActiveTransientRetryForChat(target);
    const complete = (result: PortalChatRetryFailureResult): void =>
      context.complete(command, result);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          'portal.chat.retry_failure',
          target,
          payload.turnId,
          payload.failedMessageId,
        ]),
      )
      .digest('hex');
    // Probe BEFORE current-failure checks: a committed retry has already made
    // the old notice historical. Its durable receipt still acknowledges replay.
    if (payload.action === 'retry') {
      const probe = await context.queryChatSendReceipt({
        scope: {
          workspaceId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
        },
        commandId: payload.idempotencyKey,
        identity: { userMessageId: payload.idempotencyKey, fingerprint },
      });
      if (!authorized())
        throw new Error('Chat recovery authorization changed.');
      if (probe.outcome === 'matched') {
        complete({
          outcome: 'already_applied',
          userMessageId: payload.idempotencyKey,
        });
        return;
      }
      if (probe.outcome === 'conflict') {
        context.fail(command, 'conflict', 'The retry identity has changed.');
        return;
      }
    }
    const state = await queryPortalChatState(context, target);
    const messages = await readFailureContext(context, payload);
    const prompt = failedPrompt(state, messages, payload);
    if (payload.action === 'check') {
      complete({ available: prompt !== undefined && canCommitSend() });
      return;
    }
    if (!prompt || !canCommitSend()) {
      context.fail(
        command,
        'conflict',
        'This failure is no longer available to retry.',
      );
      return;
    }
    const original = computeUsageLimitResumePrompt([prompt]);
    const result = await context.dispatchChatCommand(
      {
        schemaVersion: 1,
        commandId: payload.idempotencyKey,
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        origin: 'portal',
        expectedRevision: state.revision,
        command: {
          type: 'chat.send_message',
          chatId: target.chatId,
          userMessageId: payload.idempotencyKey,
          text: original.text,
          ...(original.fileReferences
            ? { fileReferences: original.fileReferences }
            : {}),
          ...(original.attachmentPaths
            ? { attachmentPaths: original.attachmentPaths }
            : {}),
          ...(original.attachmentPromptContexts
            ? { attachmentPromptContexts: original.attachmentPromptContexts }
            : {}),
          ...(original.inputMode ? { inputMode: original.inputMode } : {}),
        },
      },
      {
        canCommitSend,
        portalSend: {
          chatId: target.chatId,
          userMessageId: payload.idempotencyKey,
          fingerprint,
        },
      },
    );
    if (result.outcome === 'applied' || result.outcome === 'already_applied') {
      complete({
        outcome: result.outcome,
        userMessageId: payload.idempotencyKey,
      });
    } else {
      context.fail(
        command,
        'conflict',
        result.reason ?? 'The failure changed before the retry was accepted.',
      );
    }
  } catch {
    context.fail(
      command,
      validated ? 'execution_failed' : 'invalid_payload',
      'Chat recovery is unavailable.',
      validated,
    );
  }
}
