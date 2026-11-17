import { createHash, randomUUID } from 'node:crypto';
import {
  agentActionIdempotencyKey,
  type AgentActionCall,
} from '@canopy/agent-actions';
import type {
  CanopyCallerDescriptor,
  CoreWorktreeHooksSetPausedResult,
} from '@canopy/protocol/canopy-core';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

/**
 * CAN-5830: the domain writes a worktree or Cowork chat's DispatchAction
 * sends as canonical core operations, through the CAN-4125 `worktreeActions`
 * row. App Advisor reaches the same handlers without these: its action runs
 * key and grant its writes.
 */
export interface WorktreeChatCoreWrites {
  setHooksPaused(request: {
    workspaceId: string;
    worktreeId: string;
    change: { kind: 'pause' | 'resume'; hookKeys: string[] };
  }): Promise<CoreWorktreeHooksSetPausedResult>;
  /**
   * The execution id a script run started by this tool call uses, so a retry
   * finds that run instead of starting another. Derived from the project,
   * worktree and the call's shared agent action key (workspace, chat, actor,
   * running turn and tool call); undefined without a tool call id or a known
   * turn.
   */
  scriptRunId(target: {
    projectId: string;
    worktreeId: string;
  }): string | undefined;
}

/**
 * SetBaseBranch's key: one per chat, tool call and action (CAN-6024).
 * Without a tool call id the call gets its own key and is not retry-safe.
 */
export function worktreeChatActionKey(
  chatId: string,
  toolUseId: string | undefined,
  actionType: string,
): string {
  return toolUseId
    ? `agent-chat-action:${chatId}:${toolUseId}:${actionType}`
    : `agent-chat-action:${chatId}:untracked:${randomUUID()}:${actionType}`;
}

/**
 * A DispatchAction write's key: the shared agent action key of its
 * workspace, chat, actor, running turn and tool call. The tool call id is the
 * provider's tool_use id, which a reconnect never reuses; without one it is
 * the registration's id with the request id, and the turn bounds any reuse.
 * The operation compares
 * the request it sees again under the key, so the same call asking for
 * something else is refused. Without a tool call id or a known turn the call
 * gets its own key and is not retry-safe.
 */
export function worktreeChatCallKey(
  chatId: string,
  call: AgentActionCall<unknown> | undefined,
  actionType: string,
): string {
  return call?.toolUseId && call.turnKey
    ? agentActionIdempotencyKey(actionType, call, null)
    : `agent-chat-action:${chatId}:untracked:${randomUUID()}:${actionType}`;
}

function worktreeChatCaller(chatId: string): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: ['core.worktree.write'],
  };
}

export function worktreeChatCoreWrites(input: {
  chatId: string;
  call?: AgentActionCall<unknown>;
}): WorktreeChatCoreWrites {
  return {
    scriptRunId(target) {
      const { call } = input;
      if (!call?.toolUseId || !call.turnKey) return undefined;
      const digest = createHash('sha256')
        .update(
          JSON.stringify([
            target.projectId,
            target.worktreeId,
            input.chatId,
            agentActionIdempotencyKey('worktree.run_script', call, null),
          ]),
        )
        .digest('hex');
      return `agent-run-${digest}`;
    },
    async setHooksPaused(request) {
      const { activeAgentCoreOperations } =
        await import('./active-agent-core-operations');
      const idempotencyKey = worktreeChatCallKey(
        input.chatId,
        input.call,
        request.change.kind === 'pause' ? 'hook.pause' : 'hook.resume',
      );
      return activeAgentCoreOperations('worktreeActions').instruction(
        'core.worktree.hooks.setPaused',
        { ...request, _meta: { idempotencyKey } },
        {
          caller: worktreeChatCaller(input.chatId),
          metadata: { idempotencyKey },
        },
      );
    },
  };
}
