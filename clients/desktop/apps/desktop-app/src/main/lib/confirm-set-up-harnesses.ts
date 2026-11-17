import type { HarnessCompatibilityHarness } from '@canopy/protocol/plugins';
import { MCP_INSTALL_HARNESSES } from '@canopy/protocol/mcp-servers';
import { logMainProcessWarn } from './main-process-logging';

// ---------------------------------------------------------------------------
// Which harnesses the user has set up, as desktop main can check them itself
// at one Add for every harness (CAN-6815 for MCP servers, CAN-6816 for plugins
// and skills). The renderer sends its own list too.
// ---------------------------------------------------------------------------

/** What this process could check itself at Add. */
export interface ConfirmedSetUpHarnesses {
  readonly confirmed: readonly HarnessCompatibilityHarness[];
  /** Checks that timed out or failed: neither set up nor absent. */
  readonly pending: readonly HarnessCompatibilityHarness[];
}

/** How long one Add waits for a harness's own check (CAN-6815). */
const HARNESS_CONFIRM_TIMEOUT_MS = 15_000;

type HarnessCheck = 'ready' | 'absent' | 'pending';

/** A check that times out or throws is pending, never a confirmed absence. */
async function checkHarness(
  check: () => Promise<boolean | 'pending'>,
): Promise<HarnessCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check().then(
        (ready): HarnessCheck =>
          ready === 'pending' ? 'pending' : ready ? 'ready' : 'absent',
      ),
      new Promise<HarnessCheck>((resolve) => {
        timer = setTimeout(
          () => resolve('pending'),
          HARNESS_CONFIRM_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    logMainProcessWarn(
      '[harness-installs]',
      `A harness setup check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'pending';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The harnesses main can confirm are set up, each by a bounded check:
 * Cursor, Copilot and OpenCode by their connection status, Claude Code and
 * Codex by their sign-in (the cached probe the window reads, run when cold)
 * or a user-supplied key. A check that does not answer is pending, so the
 * install records it as failed with Try again. Credits and account-proxy
 * access are known to the renderer, which sends its own list too.
 */
export async function confirmSetUpHarnesses(): Promise<ConfirmedSetUpHarnesses> {
  const [
    cursorFlag,
    cursorModule,
    copilotFlag,
    copilot,
    opencodeFlag,
    opencode,
    auth,
    supplied,
  ] = await Promise.all([
    import('../cursor/feature-flag'),
    import('../cursor/runtime-availability'),
    import('../copilot/feature-flag'),
    import('../copilot/connection'),
    import('../opencode/feature-flag'),
    import('../opencode/connection'),
    import('../auth/provider-auth-state'),
    import('../agents/user-supplied-credential'),
  ]);
  const signedIn = (
    provider: 'claude' | 'codex',
    status: () => Promise<{ authenticated: boolean; probeFailed?: boolean }>,
  ): Promise<HarnessCheck> =>
    checkHarness(async () => {
      if (supplied.hasUserSuppliedProviderCredential(provider)) return true;
      const result = await status();
      if (result.authenticated) return true;
      // A failed probe is unknown, not signed out.
      return result.probeFailed === true ? 'pending' : false;
    });
  const [claude, codex, cursor, copilotCheck, opencodeCheck] =
    await Promise.all([
      signedIn('claude', () =>
        auth.getCachedClaudeAuthStatusObserved('mcp-harness-install'),
      ),
      signedIn('codex', () =>
        auth.getCachedCodexAuthStatusObserved('mcp-harness-install'),
      ),
      // The status probes themselves, not the availability helpers that turn
      // a failed probe into "not set up": a failure must stay pending. A
      // harness switched off by its flag is not set up.
      checkHarness(async () => {
        if (!cursorFlag.isCursorHarnessEnabled()) return false;
        const status = await cursorModule.probeCursorRuntimeStatus();
        return status.supported && status.enabled && status.installed;
      }),
      checkHarness(async () => {
        if (!copilotFlag.isCopilotHarnessEnabled()) return false;
        const status = await copilot.copilotConnectionStatus();
        return (
          status.supported &&
          status.installed &&
          status.enabled &&
          Boolean(status.account)
        );
      }),
      checkHarness(async () => {
        if (!opencodeFlag.isOpenCodeHarnessEnabled()) return false;
        const status = await opencode.opencodeConnectionStatus();
        return status.supported && status.installed && status.enabled;
      }),
    ]);
  const checks: Record<HarnessCompatibilityHarness, HarnessCheck> = {
    claude,
    codex,
    cursor,
    copilot: copilotCheck,
    opencode: opencodeCheck,
  };
  return {
    confirmed: MCP_INSTALL_HARNESSES.filter(
      (harness) => checks[harness] === 'ready',
    ),
    pending: MCP_INSTALL_HARNESSES.filter(
      (harness) => checks[harness] === 'pending',
    ),
  };
}
