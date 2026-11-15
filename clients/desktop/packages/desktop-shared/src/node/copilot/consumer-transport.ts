import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  COPILOT_RECIPIENT_LIMITS,
  CopilotLocalFrameSchema,
  CopilotToolReplyResultSchema,
  type CopilotCallbackRequest,
  type CopilotCallbackReply,
  type CopilotRecipientAudience,
  type CopilotRecipientCommand,
  type CopilotRecipientOutcome,
  type CopilotRecipientPurpose,
  type CopilotRecipientResult,
} from '@canopy/protocol/copilot-recipient';
import type { CopilotProcessOwner } from '@canopy/copilot-recipient/runtime';
import type { CopilotTurnRequest } from '@canopy/copilot-recipient/turn-driver';
import { redactCopilotTextParts } from '@canopy/copilot-recipient/text-redaction';
import type { CopilotRecipientHandle } from './recipient-handle';
import { copilotModelsFromSdk } from '@canopy/execution-engine/lib/copilot-models';

export interface CopilotConsumerChannel {
  opened: CopilotRecipientOutcome;
  receive(encoded: string): Promise<void>;
  disconnect(): void;
}
export interface CopilotConsumerLaunchOptions {
  owner: CopilotProcessOwner;
  cwd?: string;
  workspaceId?: string;
  executionKind?: 'agent' | 'pipeline';
  restrictedEnvironment?: boolean;
  environment?: Record<string, string>;
}
export interface CopilotConsumerPort {
  /** Trusted projection retains paths, secretValues and timeoutMs; only its opaque key travels. */
  projectPolicy(
    request: CopilotTurnRequest | undefined,
    launch?: CopilotConsumerLaunchOptions,
  ): Promise<string>;
  releasePolicy(key: string): void;
  open(
    purpose: CopilotRecipientPurpose,
    audience: CopilotRecipientAudience,
    policyKey: string | undefined,
    write: (encoded: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<CopilotConsumerChannel>;
}
class CopilotConsumerUnavailableError extends Error {
  readonly code = 'unavailable';
  constructor() {
    super('Copilot runtime is unavailable.');
    this.name = 'CopilotConsumerUnavailableError';
  }
}
const failed = (): CopilotConsumerUnavailableError =>
  new CopilotConsumerUnavailableError();

export interface CopilotVaultFieldCoverage {
  disposition:
    | 'parity'
    | 'bounded'
    | 'tool-observations'
    | 'buffered-revisions'
    | 'unavailable';
  accepts?(value: unknown): boolean;
}

/** Adding a legacy field requires a disposition and paired golden evidence. */
export const COPILOT_VAULT_TURN_FIELDS = {
  workingDirectory: { disposition: 'parity' },
  configDirectory: { disposition: 'parity' },
  model: { disposition: 'bounded' },
  reasoningEffort: { disposition: 'bounded' },
  signal: { disposition: 'parity' },
  authorize: { disposition: 'bounded' },
  requestManagedPermission: { disposition: 'unavailable' },
  systemPrompt: { disposition: 'parity' },
  tools: { disposition: 'bounded' },
  mcpServers: { disposition: 'parity' },
  skillDirectories: { disposition: 'parity' },
  onUserInputRequest: { disposition: 'bounded' },
  onEvent: { disposition: 'tool-observations' },
  turnId: { disposition: 'bounded' },
  sessionId: { disposition: 'bounded' },
  prompt: { disposition: 'bounded' },
  preparePrompt: { disposition: 'bounded' },
  onPromptAccepted: { disposition: 'parity' },
  timeoutMs: { disposition: 'parity' },
  secretValues: { disposition: 'bounded' },
  emit: { disposition: 'buffered-revisions' },
  onSession: { disposition: 'parity' },
  onToolsReady: { disposition: 'bounded' },
  onMcpToolsReady: { disposition: 'unavailable' },
  onSessionUnavailable: { disposition: 'parity' },
  beforePrompt: { disposition: 'parity' },
} satisfies Record<keyof CopilotTurnRequest, CopilotVaultFieldCoverage>;

export function copilotVaultFieldsCovered(
  input: object,
  fields: Readonly<Record<string, CopilotVaultFieldCoverage>>,
): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return false;
  return Reflect.ownKeys(input).every((key) => {
    if (
      typeof key !== 'string' ||
      !Object.prototype.hasOwnProperty.call(fields, key)
    )
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    // Validate before callers spread: accessors and hidden/inherited fields can be lost or change.
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
    const row = fields[key];
    const value: unknown = descriptor.value;
    return (
      value === undefined ||
      (!!row &&
        row.disposition !== 'unavailable' &&
        (!row.accepts || row.accepts(value)))
    );
  });
}
const serverStatus = z.enum([
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
  'stopped',
  'not_configured',
]);

/** Function callbacks never cross the channel; only one correlated reply can satisfy each ask. */
export function createCopilotConsumerHandle(options: {
  port: CopilotConsumerPort;
  account: CopilotRecipientHandle['account'];
  generation: number;
  signal: AbortSignal;
  purpose?: 'session' | 'models' | 'quota';
  launch?: CopilotConsumerLaunchOptions;
  current(): boolean;
}): CopilotRecipientHandle {
  let closed = false;
  let turnUsed = false;
  const closing = new AbortController();
  const channels = new Set<CopilotConsumerChannel>();
  function admit(): void {
    if (closed || options.signal.aborted || !options.current()) throw failed();
  }
  const close = (): Promise<void> => {
    closed = true;
    closing.abort();
    for (const channel of channels) channel.disconnect();
    channels.clear();
    options.signal.removeEventListener('abort', onAbort);
    return Promise.resolve();
  };
  const onAbort = (): void => {
    void close();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  async function run(
    purpose: CopilotRecipientPurpose,
    signal: AbortSignal,
    request?: CopilotTurnRequest,
  ): Promise<CopilotRecipientResult> {
    admit();
    signal.throwIfAborted();
    const audience: CopilotRecipientAudience = request?.sessionId
      ? {
          kind: 'resume',
          operationId: request.turnId,
          sessionId: request.sessionId,
        }
      : { kind: 'create', operationId: request?.turnId ?? randomUUID() };
    let policyKey: string | undefined;
    let channel: CopilotConsumerChannel | undefined;
    let envelope: Omit<CopilotRecipientCommand, 'kind'> | undefined;
    let outcome: CopilotRecipientOutcome | undefined;
    let sequence = 0;
    let requestId = 1;
    let sessionId = request?.sessionId;
    let recovered = false;
    let open = true;
    const acquisitionSignal = AbortSignal.any([
      signal,
      options.signal,
      closing.signal,
    ]);
    let cancelAcquisition: () => void = () => undefined;
    const cancel = (): void => {
      open = false;
      cancelAcquisition();
      channel?.disconnect();
    };
    const check = (): void => {
      admit();
      signal.throwIfAborted();
      if (!open) throw failed();
    };
    async function callback(
      ask: CopilotCallbackRequest,
    ): Promise<CopilotCallbackReply> {
      check();
      if (!request) throw failed();
      switch (ask.kind) {
        case 'approval': {
          if (!sessionId) return { kind: 'approval', allow: false };
          try {
            const args: unknown = JSON.parse(ask.argumentsJson);
            const decision = await request.authorize({
              toolName: ask.toolName,
              toolArgs: args,
              sessionId,
              workingDirectory: request.workingDirectory,
              timestamp: new Date(),
            });
            check();
            return {
              kind: 'approval',
              allow: decision.decision === 'allow',
              ...(decision.message === undefined
                ? {}
                : {
                    message: redactCopilotTextParts(
                      [decision.message],
                      [
                        ...(request.secretValues ?? []),
                        request.workingDirectory,
                        request.configDirectory,
                      ],
                    )[0],
                  }),
              ...(decision.decision === 'allow' &&
              decision.modifiedArgs !== undefined
                ? {
                    modifiedArgumentsJson: JSON.stringify(
                      decision.modifiedArgs,
                    ),
                  }
                : {}),
            };
          } catch {
            return { kind: 'approval', allow: false };
          }
        }
        case 'permission':
          return { kind: 'permission', allow: false };
        case 'tool': {
          const tool = request.tools?.find(
            (tool) => tool.name === ask.toolName,
          );
          const handler = tool?.handler;
          if (!handler || !sessionId) throw failed();
          const args: unknown = JSON.parse(ask.argumentsJson);
          const result: unknown = await handler(args, {
            sessionId,
            toolCallId: ask.toolCallId,
            toolName: ask.toolName,
            arguments: args,
            signal,
          });
          check();
          return typeof result === 'string'
            ? { kind: 'tool', result }
            : {
                kind: 'tool',
                result: '',
                structured: CopilotToolReplyResultSchema.parse(result),
              };
        }
        case 'input': {
          if (!request.onUserInputRequest || !sessionId) throw failed();
          const answer = await request.onUserInputRequest(
            {
              question: ask.question,
              choices: ask.choices,
              allowFreeform: ask.allowFreeform,
            },
            { sessionId },
          );
          check();
          return { kind: 'input', ...answer };
        }
        case 'history':
          return {
            kind: 'history',
            prompt:
              (await request.preparePrompt?.(ask.sessionId)) ?? request.prompt,
          };
        case 'observation':
          request.onEvent?.(ask.event);
          return { kind: 'observation', accepted: true };
        case 'notice':
          switch (ask.name) {
            case 'session':
              if (!ask.sessionId) throw failed();
              sessionId = ask.sessionId;
              await request.onSession(sessionId);
              break;
            case 'prompt-accepted':
              if (!ask.sessionId) throw failed();
              await request.onPromptAccepted?.(ask.sessionId);
              break;
            case 'before-prompt':
              await request.beforePrompt?.();
              break;
            case 'session-unavailable':
              recovered = true;
              await request.onSessionUnavailable?.();
              break;
            case 'tools-ready':
              if (!ask.digest || !/^[a-f0-9]{64}$/.test(ask.digest))
                throw failed();
              await request.onToolsReady?.(
                { version: 1, digest: ask.digest },
                (ask.servers ?? []).map((server) => ({
                  name: server.name,
                  status: serverStatus.parse(server.status),
                })),
              );
          }
          check();
          return { kind: 'notice', accepted: true };
      }
    }
    try {
      if (request || options.launch)
        policyKey = await options.port.projectPolicy(request, options.launch);
      check();
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancelAcquisition = (): void => reject(failed());
      });
      // An open port may throw synchronously after triggering cancellation.
      void cancelled.catch(() => undefined);
      acquisitionSignal.addEventListener('abort', cancel, { once: true });
      if (acquisitionSignal.aborted) cancel();
      check();
      const opening = options.port.open(
        purpose,
        audience,
        policyKey,
        async (encoded) => {
          check();
          if (
            Buffer.byteLength(encoded, 'utf8') >
            COPILOT_RECIPIENT_LIMITS.frameBytes
          )
            throw failed();
          const frame = CopilotLocalFrameSchema.parse(JSON.parse(encoded));
          if (frame.kind === 'response') {
            if (frame.requestId === 1) {
              if (outcome) throw failed();
              outcome = frame.outcome;
            } else if (
              frame.requestId > requestId ||
              frame.outcome.kind !== 'accepted'
            )
              throw failed();
            return;
          }
          if (frame.kind !== 'message' || !envelope) throw failed();
          const message = frame.message;
          if (
            message.handle !== envelope.handle ||
            message.generation !== envelope.generation ||
            message.sequence !== ++sequence
          )
            throw failed();
          if (message.kind === 'event') {
            if (!request || message.event.kind !== 'patch') throw failed();
            await request.emit(message.event.patch);
            check();
            return;
          }
          // The writer must acknowledge before a reply's own acknowledged write can run.
          void Promise.resolve()
            .then(async () => {
              const reply = await callback(message.request);
              check();
              if (!channel || !envelope) throw failed();
              await channel.receive(
                JSON.stringify({
                  requestId: ++requestId,
                  command: {
                    ...envelope,
                    kind: 'reply',
                    correlationId: message.correlationId,
                    reply,
                  },
                }),
              );
            })
            .catch(cancel);
        },
        acquisitionSignal,
      );
      const acquired = opening.then((candidate) => {
        if (!open || acquisitionSignal.aborted) {
          candidate.disconnect();
          throw failed();
        }
        return candidate;
      });
      channel = await Promise.race([acquired, cancelled]);
      channels.add(channel);
      check();
      if (channel.opened.kind !== 'opened') throw failed();
      envelope = {
        version: 1,
        handle: channel.opened.handle,
        generation: channel.opened.generation,
        audience,
        purpose,
      };
      check();
      await channel.receive(
        JSON.stringify({
          requestId: 1,
          command: {
            ...envelope,
            kind: 'run',
            ...(request
              ? {
                  turn: {
                    prompt: request.prompt,
                    model: request.model,
                    reasoningEffort: request.reasoningEffort,
                    recoverMissingSession: !!request.onSessionUnavailable,
                    observeTools: !!request.onEvent,
                  },
                }
              : {}),
          },
        }),
      );
      check();
      const completed = CopilotLocalFrameSchema.parse({
        kind: 'response',
        requestId: 1,
        outcome,
      });
      if (
        completed.kind !== 'response' ||
        completed.outcome.kind !== 'completed' ||
        completed.outcome.result.kind !== purpose
      )
        throw failed();
      return completed.outcome.result;
    } catch {
      // Missing resume is notified to its owner, then retried only under a fresh create audience.
      if (
        recovered &&
        request?.onSessionUnavailable &&
        request.sessionId &&
        open
      )
        return run('turn', signal, {
          ...request,
          sessionId: undefined,
          onSessionUnavailable: undefined,
        });
      signal.throwIfAborted();
      options.signal.throwIfAborted();
      throw failed();
    } finally {
      open = false;
      acquisitionSignal.removeEventListener('abort', cancel);
      channel?.disconnect();
      if (channel) channels.delete(channel);
      if (policyKey) options.port.releasePolicy(policyKey);
    }
  }
  const handle: CopilotRecipientHandle = {
    account: options.account,
    generation: options.generation,
    close,
    async runTurn(request) {
      if ((options.purpose ?? 'session') !== 'session' || turnUsed)
        throw failed();
      turnUsed = true;
      try {
        if (!copilotVaultFieldsCovered(request, COPILOT_VAULT_TURN_FIELDS))
          throw failed();
        const result = await run('turn', request.signal, request);
        if (result.kind !== 'turn') throw failed();
        return {
          sessionId: result.sessionId,
          text: result.text,
          usage: result.usage,
        };
      } finally {
        await close();
      }
    },
    async listModels(signal) {
      if (options.purpose === 'quota') throw failed();
      const result = await run('models', signal);
      if (result.kind !== 'models') throw failed();
      return copilotModelsFromSdk(
        result.models.map((model) => ({
          id: model.id,
          name: model.name,
          policy: { state: 'enabled' },
          capabilities: {
            supports: { vision: model.supportsVision, reasoningEffort: true },
            limits: { max_context_window_tokens: model.contextWindow },
          },
          supportedReasoningEfforts: model.reasoningEfforts,
        })),
      );
    },
    async getQuota(signal) {
      if (options.purpose !== 'quota') throw failed();
      const result = await run('quota', signal);
      if (result.kind !== 'quota') throw failed();
      return {
        quotaSnapshots: Object.fromEntries(
          result.snapshots.map((snapshot) => [
            snapshot.id,
            {
              remainingPercentage: snapshot.remainingPercentage ?? NaN,
              isUnlimitedEntitlement: snapshot.unlimited,
              resetDate: snapshot.resetsAt,
            },
          ]),
        ),
      };
    },
  };
  return Object.freeze(handle);
}
