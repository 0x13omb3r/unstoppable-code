import { useCallback, useMemo, useRef } from 'react';
import type { HarnessCompatibilityHarness } from '@canopy/protocol/plugins';
import { MCP_INSTALL_HARNESSES } from '@canopy/protocol/mcp-servers';
import { useProviderAvailability } from './useProviderAvailability';
import { useCursorChatAvailable } from './useCursorChatAvailable';
import {
  useAccountProxyStatus,
  useAccountProxyStore,
} from '@/stores/accountProxyStore';

/**
 * The harnesses the user has set up (CAN-6815): Claude Code and Codex with a
 * sign-in, credits or a ready account proxy, and Cursor, Copilot and OpenCode
 * once connected. A read still loading does not count yet, so one Add never
 * installs for a harness that turns out not to be set up.
 *
 * `enabled` false skips the Cursor probe and returns nothing. Desktop main
 * also confirms Cursor, Copilot, OpenCode and native sign-ins itself, so the
 * caller only needs to wait for `settled` before installing.
 */
export interface SetUpHarnesses {
  readonly harnesses: readonly HarnessCompatibilityHarness[];
  /** Claude Code and Codex sign-in, credits and account-proxy reads have answered. */
  readonly settled: boolean;
}

export function useSetUpHarnesses(enabled: boolean): SetUpHarnesses {
  const availability = useProviderAvailability();
  // The model picker treats Cursor as always selectable; its own connection
  // check says whether it is set up.
  const cursor = useCursorChatAvailable(enabled);
  // Account-proxy access counts as set up; wait until it has been read and
  // a saved connection's accounts have loaded.
  const proxy = useAccountProxyStatus();
  const proxyRefreshing = useAccountProxyStore((state) => state.refreshing);
  const proxySettled =
    window.api?.accountProxy === undefined ||
    (proxy !== null &&
      !proxyRefreshing &&
      !(proxy.connection && proxy.refreshedAt === null));
  return useMemo(() => {
    if (!enabled) return { harnesses: [], settled: true };
    const setUp: Record<HarnessCompatibilityHarness, boolean> = {
      claude:
        !availability.claude.loading &&
        (availability.claude.nativeAuth || availability.claude.creditsEligible),
      codex:
        !availability.codex.loading &&
        (availability.codex.nativeAuth || availability.codex.creditsEligible),
      cursor,
      copilot: availability.copilot.selectable,
      opencode: availability.opencode.selectable,
    };
    // A harness is answered once it reads set up, or once its sign-in,
    // credits and proxy reads have all answered conclusively. A failed read
    // is not an answer, so Add keeps waiting and then sends it as pending.
    const answered = (harness: 'claude' | 'codex'): boolean => {
      const read = availability[harness];
      return (
        setUp[harness] ||
        (proxySettled &&
          !read.loading &&
          read.nativeAuthInconclusive !== true &&
          read.creditsInconclusive !== true)
      );
    };
    return {
      harnesses: MCP_INSTALL_HARNESSES.filter((harness) => setUp[harness]),
      settled: answered('claude') && answered('codex'),
    };
  }, [availability, cursor, enabled, proxySettled]);
}

/** How long Add waits for the renderer's sign-in, credits and proxy reads. */
export const HARNESS_DISCOVERY_WAIT_MS = 15_000;

/** The harnesses whose setup the renderer's `settled` read covers. */
const DISCOVERY_PENDING_HARNESSES: readonly HarnessCompatibilityHarness[] = [
  'claude',
  'codex',
];

export interface SettledSetUpHarnesses {
  readonly harnesses: HarnessCompatibilityHarness[];
  readonly pendingHarnesses: HarnessCompatibilityHarness[];
}

/**
 * One Add for every harness (CAN-6815, CAN-6816): waits, within a bound, for
 * the sign-in, credits and proxy reads to answer, so a read still loading at
 * Add does not leave Claude Code or Codex out. What is still unanswered at
 * the deadline goes as pending: main records it as failed, so its row offers
 * Try again.
 */
export function useSettledSetUpHarnesses(
  enabled: boolean,
): () => Promise<SettledSetUpHarnesses> {
  const setUpHarnesses = useSetUpHarnesses(enabled);
  const ref = useRef(setUpHarnesses);
  ref.current = setUpHarnesses;
  return useCallback(async (): Promise<SettledSetUpHarnesses> => {
    const deadline = Date.now() + HARNESS_DISCOVERY_WAIT_MS;
    while (!ref.current.settled && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const { harnesses, settled } = ref.current;
    const pendingHarnesses: HarnessCompatibilityHarness[] = settled
      ? []
      : DISCOVERY_PENDING_HARNESSES.filter(
          (harness) => !harnesses.includes(harness),
        );
    return { harnesses: [...harnesses], pendingHarnesses };
  }, []);
}
