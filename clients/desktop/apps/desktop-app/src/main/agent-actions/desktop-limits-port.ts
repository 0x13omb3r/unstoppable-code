import {
  AGENT_ACTION_LIMITS,
  createInMemoryAgentActionLimits,
  createInMemoryAgentActionReceipts,
  type AgentActionLimitsPort,
  type AgentActionReceiptStore,
} from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';

/** The single desktop user every limit counts against. */
export const DESKTOP_AGENT_ACTOR_KEY = 'local-desktop-user';

/**
 * Process-local reservations; the desktop runs one main process per user.
 * Reservations are keyed by the write's idempotency key, so a retried tool
 * call keeps its original slot. There is no per-turn, hourly or depth cap:
 * the user runs these agents on their own machine and accounts.
 */
export const DESKTOP_AGENT_ACTION_LIMITS = {
  ...AGENT_ACTION_LIMITS,
  perParentTurn: Number.POSITIVE_INFINITY,
  perUserPerHour: Number.POSITIVE_INFINITY,
  maxDepth: Number.POSITIVE_INFINITY,
};

export const desktopAgentActionLimits: AgentActionLimitsPort =
  createInMemoryAgentActionLimits({ limits: DESKTOP_AGENT_ACTION_LIMITS });

/**
 * Process-local results of agent writes, so a retried tool call returns the
 * original result. A retry after a restart, or past the oldest of the last
 * 500, runs as a new write.
 */
export const desktopAgentActionReceipts: AgentActionReceiptStore<CanopyInjectedToolRuntime> =
  createInMemoryAgentActionReceipts({ maxEntries: 500 });
