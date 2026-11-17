// ---------------------------------------------------------------------------
// One Add for every harness (CAN-6815, behind the `customize-discovery` Labs
// experiment).
//
// Canopy keeps one standalone MCP server and one sign-in per server
// configuration; each harness's adapter builds its own MCP table from that
// one install when a session starts. The record below sits on top of the
// install: it lists the harnesses one Add installed the server for and what
// happened for each. It never holds a URL, header, token or other secret.
//
// Desktop main keeps these records in their own file beside the MCP index and
// adds them to index rows it serves, so the index and server files are never
// rewritten and older app versions keep reading their installs unchanged.
//
// Pure: no Node, Electron, React or app imports.
// ---------------------------------------------------------------------------

import type {
  HarnessCompatibility,
  HarnessCompatibilityHarness,
} from '../plugins/harness-compatibility';
import type { HarnessInstallMode } from '../plugins/harness-installs';

/** Every harness one Add can install for, in the Works with filter's order. */
export const MCP_INSTALL_HARNESSES: readonly HarnessCompatibilityHarness[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
];

/** Wire version of {@link McpServerHarnessInstalls}. */
export const MCP_SERVER_HARNESS_INSTALLS_VERSION = 1;

/** Longest failure reason a record keeps; longer ones are cut. */
export const MCP_HARNESS_INSTALL_REASON_MAX_LENGTH = 300;

/** What happened when one Add installed a server for one harness. */
export type McpHarnessInstallState =
  | { readonly status: 'installed'; readonly updatedAt: string }
  | {
      readonly status: 'failed';
      /** Why, in words the row can show. Never a secret. */
      readonly reason: string;
      readonly updatedAt: string;
    };

/** The install record one Add writes for one server. */
export interface McpServerHarnessInstalls {
  readonly version: number;
  /** The configuration one Add installed; its sign-in is shared. */
  readonly configId: string;
  readonly harnesses: Readonly<
    Partial<Record<HarnessCompatibilityHarness, McpHarnessInstallState>>
  >;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Installs a saved server for these harnesses (CAN-6815). */
export interface InstallMcpServerForHarnessesRequest {
  readonly serverId: string;
  readonly configId: string;
  /** The harnesses the user has set up; main keeps those that load MCP. */
  readonly harnesses: readonly HarnessCompatibilityHarness[];
  /**
   * Harnesses whose setup check had not answered when Add gave up waiting.
   * Main records each one it cannot confirm itself as failed, so its row
   * offers Try again instead of leaving it out.
   */
  readonly pendingHarnesses?: readonly HarnessCompatibilityHarness[];
  /**
   * `add` (the default) is a new Add: harness states recorded before it
   * started are replaced. `catch-up` adds harnesses set up since (CAN-6817)
   * and keeps every state already recorded.
   */
  readonly mode?: HarnessInstallMode;
}

/** Retries one harness of an earlier install (CAN-6815). */
export interface RetryMcpServerHarnessInstallRequest {
  readonly serverId: string;
  readonly harness: HarnessCompatibilityHarness;
}

export function isMcpInstallHarness(
  value: unknown,
): value is HarnessCompatibilityHarness {
  return MCP_INSTALL_HARNESSES.some((harness) => harness === value);
}

/**
 * Whether a harness can load a server, as its compatibility rates it. Without
 * a rating every harness can: they all load MCP servers the same way.
 */
export function mcpServerLoadsOnHarness(
  compatibility: HarnessCompatibility | undefined,
  harness: HarnessCompatibilityHarness,
): boolean {
  const result = compatibility?.harnesses[harness];
  if (result === undefined) return true;
  switch (result.level) {
    case 'native':
    case 'full':
      return true;
    case 'partial':
      return !result.missing.includes('mcpServers');
    case 'unsupported':
      return false;
  }
}

/**
 * The harnesses one Add installs for: the set-up harnesses that can load the
 * server, each once, in {@link MCP_INSTALL_HARNESSES} order.
 */
export function mcpHarnessInstallTargets(
  setUp: readonly HarnessCompatibilityHarness[],
  compatibility: HarnessCompatibility | undefined,
): HarnessCompatibilityHarness[] {
  return MCP_INSTALL_HARNESSES.filter(
    (harness) =>
      setUp.includes(harness) &&
      mcpServerLoadsOnHarness(compatibility, harness),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseState(value: unknown): McpHarnessInstallState | undefined {
  if (!isRecord(value) || !isTimestamp(value.updatedAt)) return undefined;
  if (value.status === 'installed')
    return { status: 'installed', updatedAt: value.updatedAt };
  if (
    value.status === 'failed' &&
    typeof value.reason === 'string' &&
    value.reason.trim().length > 0
  )
    return {
      status: 'failed',
      reason: value.reason.slice(0, MCP_HARNESS_INSTALL_REASON_MAX_LENGTH),
      updatedAt: value.updatedAt,
    };
  return undefined;
}

/**
 * Reads a record at a trust boundary. Unknown versions are absent, an unknown
 * harness or a bad state is dropped without poisoning its siblings, and the
 * result is a sanitized copy.
 */
export function parseMcpServerHarnessInstalls(
  value: unknown,
): McpServerHarnessInstalls | undefined {
  if (
    !isRecord(value) ||
    value.version !== MCP_SERVER_HARNESS_INSTALLS_VERSION ||
    typeof value.configId !== 'string' ||
    value.configId.length === 0 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isRecord(value.harnesses)
  )
    return undefined;
  const harnesses: Partial<
    Record<HarnessCompatibilityHarness, McpHarnessInstallState>
  > = {};
  for (const harness of MCP_INSTALL_HARNESSES) {
    const state = parseState(value.harnesses[harness]);
    if (state !== undefined) harnesses[harness] = state;
  }
  return {
    version: MCP_SERVER_HARNESS_INSTALLS_VERSION,
    configId: value.configId,
    harnesses,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** The harnesses a record lists as installed, in order. */
export function mcpInstalledHarnesses(
  record: McpServerHarnessInstalls | undefined,
): HarnessCompatibilityHarness[] {
  return MCP_INSTALL_HARNESSES.filter(
    (harness) => record?.harnesses[harness]?.status === 'installed',
  );
}

/** The harnesses a record lists as failed, with why, in order. */
export function mcpFailedHarnessInstalls(
  record: McpServerHarnessInstalls | undefined,
): { harness: HarnessCompatibilityHarness; reason: string }[] {
  return MCP_INSTALL_HARNESSES.flatMap((harness) => {
    const state = record?.harnesses[harness];
    return state?.status === 'failed'
      ? [{ harness, reason: state.reason }]
      : [];
  });
}
