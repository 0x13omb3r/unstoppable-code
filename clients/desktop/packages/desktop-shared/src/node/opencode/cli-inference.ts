import { randomUUID } from 'node:crypto';
import { resolveGatewayModelEntry } from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  AI_CREDITS_WORK_OWNER_HEADER,
  AI_CREDITS_ORG_PROJECT_HEADER,
} from '@canopy/protocol/llm-gateway';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { isOpenCodeGatewayRouteSupported } from '../../lib/opencode-gateway-models';
import { openCodeCapabilityDigest } from './capability-snapshot';
import {
  prepareOpenCodeInferenceRoute,
  type OpenCodeInferenceRoute,
} from './inference-route';
import { CodexGatewayProxyService } from './gateway-proxy';
import type { CliOpenCodeAccount } from './cli-account';
import type { CliOpenCodeOwner } from './cli-owner';
import type { ThinkingLevel } from '@canopy/protocol/thinking';

export interface CliOpenCodeInference {
  route: OpenCodeInferenceRoute;
  supportedThinkingLevels: readonly ThinkingLevel[];
  close(): Promise<void>;
  failureError(fallback?: unknown): Error & { api_error_status?: number };
}

/** The shared broker retains the cloud key; the worker sees only a loopback lease. */
export async function openCliOpenCodeInference(options: {
  model: string;
  account: CliOpenCodeAccount;
  owner: CliOpenCodeOwner;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}): Promise<CliOpenCodeInference> {
  const entry = resolveGatewayModelEntry(options.model);
  if (
    !entry ||
    entry.origin === 'org-gateway' ||
    !isOpenCodeGatewayRouteSupported(entry)
  )
    throw new Error('This managed model is unavailable to the standalone CLI.');
  const fingerprint = openCodeCapabilityDigest(entry);
  const assertCurrent = async (): Promise<void> => {
    options.signal.throwIfAborted();
    await options.assertCurrent();
    await options.account.assertModel(
      options.model,
      options.owner.owner,
      options.signal,
    );
    if (
      openCodeCapabilityDigest(resolveGatewayModelEntry(options.model)) !==
      fingerprint
    )
      throw new Error('The model changed during this workflow.');
    options.signal.throwIfAborted();
  };
  await assertCurrent();
  const broker = new CodexGatewayProxyService();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', onAbort);
    await broker.shutdown();
  };
  const onAbort = (): void => {
    void close();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const protocol =
    entry.recommendedHarness === 'claude'
      ? 'anthropic-messages'
      : 'openai-responses';
  const headers = {
    [AI_CREDITS_WORK_OWNER_HEADER]: serializeWorkspaceContext(
      options.owner.owner,
    ),
    ...(options.owner.organizationProjectId
      ? { [AI_CREDITS_ORG_PROJECT_HEADER]: options.owner.organizationProjectId }
      : {}),
  };
  try {
    const lease = await broker.registerRoute({
      sessionId: `opencode-cli:${randomUUID()}`,
      upstreamUrl: `${options.account.origin}/api/v1/llm-proxy/${protocol === 'anthropic-messages' ? 'anthropic' : 'openai/responses'}`,
      allowedPaths: [
        protocol === 'anthropic-messages' ? '/v1/messages' : '/responses',
      ],
      forwardHeaders:
        protocol === 'anthropic-messages'
          ? ['anthropic-version', 'anthropic-beta']
          : [],
      stripCacheControl: entry.promptCachePassthrough === false,
      upstreamSignal: () => options.signal,
      inferencePolicy: {
        providerType: 'opencode',
        modelId: entry.gatewayId,
        toolSchemaProfile: entry.toolSchemaProfile,
        headers,
      },
      resolveToken: async () => {
        try {
          if (closed) return null;
          await assertCurrent();
          return closed
            ? null
            : options.account.authorization().slice('Bearer '.length);
        } catch {
          return null;
        }
      },
    });
    if (closed) {
      // Registration may finish after abort closed the starting listener.
      broker.unregisterRoute(lease.routeId);
      await broker.shutdown();
      throw new Error('OpenCode inference setup stopped.');
    }
    options.signal.throwIfAborted();
    const fundingKey = openCodeCapabilityDigest({
      account: options.account.identity,
      owner: options.owner,
      origin: options.account.origin,
    });
    const { route } = prepareOpenCodeInferenceRoute({
      bindingKey: openCodeCapabilityDigest({
        fundingKey,
        model: entry.gatewayId,
        protocol,
      }),
      selection: { modelId: options.model, fundingKey },
      protocol,
      baseUrl: lease.baseUrl,
      headers,
      model: {
        id: entry.gatewayId,
        contextWindow: entry.contextWindow,
        outputLimit: Math.min(16_384, entry.contextWindow),
        supportsVision: entry.supportsImages === true,
      },
    });
    return {
      route,
      supportedThinkingLevels: [...entry.supportedThinkingLevels],
      close,
      failureError: (fallback) => {
        const failure = lease.readInferenceFailure?.();
        return Object.assign(
          new Error(
            failure?.proxyFailure?.message ??
              (fallback instanceof Error
                ? fallback.message
                : 'Managed inference failed.'),
          ),
          failure?.status ? { api_error_status: failure.status } : {},
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
