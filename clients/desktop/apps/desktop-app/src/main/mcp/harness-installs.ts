import { homedir } from 'node:os';
import {
  buildManagedMcpServerName,
  normalizeManagedMcpServerLabel,
} from '@canopy/execution-engine/node/plugins/mcp-server-name';
import type {
  McpServerFile,
  McpServersIndexFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { projectStandaloneMcpServersForCodex } from '@canopy/plugin-interop';
import type {
  HarnessCompatibility,
  HarnessCompatibilityHarness,
} from '@canopy/protocol/plugins';
import {
  MCP_HARNESS_INSTALL_REASON_MAX_LENGTH,
  MCP_INSTALL_HARNESSES,
  MCP_SERVER_HARNESS_INSTALLS_VERSION,
  isMcpInstallHarness,
  mcpHarnessInstallTargets,
  parseMcpServerHarnessInstalls,
  type InstallMcpServerForHarnessesRequest,
  type McpHarnessInstallState,
  type McpServerHarnessInstalls,
  type RetryMcpServerHarnessInstallRequest,
} from '@canopy/protocol/mcp-servers';
import { buildCopilotMcpServers } from '../copilot/mcp-servers';
import { buildCursorMcpServers } from '../cursor/mcp-servers';
import {
  cursorMcpCapabilities,
  resolveMcpExecutable,
} from '../cursor/mcp-executable';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { buildOpenCodeMcpServers } from '../opencode/mcp-servers';
import { getMcpHarnessInstallsFilePath } from '../lib/paths';
import {
  createHarnessInstallRecordStore,
  type HarnessInstallRecordStore,
  type HarnessInstallStoreDisk,
} from '../lib/harness-install-store';
import type { ConfirmedSetUpHarnesses } from '../lib/confirm-set-up-harnesses';

// ---------------------------------------------------------------------------
// One Add for every harness (CAN-6815, behind the `customize-discovery` Labs
// experiment; the renderer only calls this while it is on).
//
// Canopy keeps one standalone server and one sign-in per configuration, and
// each harness's adapter builds its own MCP table from that install when a
// session starts. Installing for a harness stages the server through that
// harness's own adapter, exactly as a session would hand it over, and records
// whether the harness accepted it. The record lives in its own file: the
// index, the server file, its ids and its sign-in are never rewritten, and
// older app versions keep using the install as before.
//
// Staging never reads or copies a credential: it hands each adapter the
// server's URL or command alone, without headers or tokens.
// ---------------------------------------------------------------------------

const HARNESS_LABELS: Record<HarnessCompatibilityHarness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  opencode: 'OpenCode',
};

/** One server as a session hands it to an adapter, without secrets. */
export interface StagedMcpServer {
  readonly name: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

/** Hands a server to one harness's adapter; throws why it was refused. */
export type McpHarnessStager = (
  server: StagedMcpServer,
) => void | Promise<void>;

function refused(
  harness: HarnessCompatibilityHarness,
  reason: string | undefined,
): Error {
  return new Error(
    reason ?? `${HARNESS_LABELS[harness]} did not accept this server.`,
  );
}

/** The adapters every harness session uses for standalone servers. */
export const MCP_HARNESS_STAGERS: Record<
  HarnessCompatibilityHarness,
  McpHarnessStager
> = {
  // The Claude Agent SDK takes the resolver's map as it is.
  claude: ({ definition }) => {
    const type = definition.type;
    if (
      !(type === 'http' && typeof definition.url === 'string') &&
      !(type === 'stdio' && typeof definition.command === 'string')
    )
      throw refused('claude', undefined);
  },
  codex: ({ name, definition }) => {
    const projected = projectStandaloneMcpServersForCodex({
      pluginName: 'standalone',
      mcpServers: { [name]: definition },
    });
    if (projected.config[name] === undefined)
      throw refused('codex', projected.warnings[0]);
  },
  cursor: async ({ name, definition }) => {
    // The transports the installed CLI last advertised, and the executable
    // lookup a session uses, so a refusal a session would hit is recorded.
    const home = homedir();
    const built = await buildCursorMcpServers({
      canopy: null,
      resolvedMcpServers: { [name]: definition },
      capabilities: cursorMcpCapabilities(),
      resolveExecutable: (command, base) =>
        resolveMcpExecutable(
          command,
          getEnhancedEnv({ includeCanopySecrets: false, environment: false })
            .PATH,
          base ?? home,
          home,
        ),
    });
    if (!built.servers.some((server) => server.name === name))
      throw refused('cursor', built.warnings[0]);
  },
  copilot: ({ name, definition }) => {
    const servers = buildCopilotMcpServers({
      definitions: { [name]: definition },
      cwd: homedir(),
    });
    if (!Object.prototype.hasOwnProperty.call(servers, name))
      throw refused(
        'copilot',
        'Copilot reserves this server name for a built-in server.',
      );
  },
  opencode: ({ name, definition }) => {
    const servers = buildOpenCodeMcpServers({
      definitions: { [name]: definition },
      cwd: homedir(),
    });
    if (!servers.some((server) => server.name === name))
      throw refused('opencode', undefined);
  },
};

/**
 * The server one configuration hands to a session, named as the plugin
 * resolver names it, with the URL or command alone.
 */
export function stagedMcpServer(
  file: McpServerFile,
  configId: string,
): StagedMcpServer | undefined {
  const { definition } = file.server;
  const config = file.server.configs.find((entry) => entry.id === configId);
  if (config === undefined) return undefined;
  const name = buildManagedMcpServerName({
    kind: 'dynamic',
    friendlyParts:
      normalizeManagedMcpServerLabel(config.name) !== 'default'
        ? [definition.name, config.name]
        : [definition.name],
    identityParts: [definition.id, config.id],
  });
  if (definition.type === 'http' && definition.url)
    return { name, definition: { type: 'http', url: definition.url } };
  if (definition.type === 'command' && definition.command)
    return {
      name,
      definition: {
        type: 'stdio',
        command: definition.command,
        args: [...(definition.args ?? []), ...config.extraArgs],
      },
    };
  return undefined;
}

// ---------------------------------------------------------------------------
// Record store: `mcp-servers/harness-installs.json`.
// ---------------------------------------------------------------------------

/** A newer app wrote the record file; this one only reads around it. */
export class McpHarnessInstallsNewerError extends Error {
  constructor() {
    super('A newer version of the app saved these install records.');
    this.name = 'McpHarnessInstallsNewerError';
  }
}

export type McpHarnessInstallStore =
  HarnessInstallRecordStore<McpServerHarnessInstalls>;

/**
 * The record file. Writes rewrite only the named server's record and keep
 * every other entry as found, including ones this version cannot read.
 */
export function createMcpHarnessInstallStore(
  path: () => string = getMcpHarnessInstallsFilePath,
  disk?: HarnessInstallStoreDisk,
): McpHarnessInstallStore {
  return createHarnessInstallRecordStore({
    path,
    collection: 'servers',
    parse: parseMcpServerHarnessInstalls,
    newerError: () => new McpHarnessInstallsNewerError(),
    ...(disk !== undefined ? { disk } : {}),
  });
}

// ---------------------------------------------------------------------------
// Install, retry, forget, serve.
// ---------------------------------------------------------------------------

export type { ConfirmedSetUpHarnesses };

export interface McpHarnessInstallDeps {
  readonly store: McpHarnessInstallStore;
  readonly loadServer: (serverId: string) => Promise<McpServerFile | undefined>;
  readonly compatibility: (
    file: McpServerFile,
  ) => Promise<HarnessCompatibility | undefined>;
  readonly stagers: Record<HarnessCompatibilityHarness, McpHarnessStager>;
  readonly now: () => string;
  /**
   * Harnesses this process checks on its own. Confirmed ones join the
   * renderer's list, and ones whose check did not answer join its pending
   * list, so a harness whose renderer probe is still pending at Add is never
   * left out.
   */
  readonly confirmedSetUpHarnesses?: () => Promise<ConfirmedSetUpHarnesses>;
}

function failureReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return (message || 'This harness did not accept this server.').slice(
    0,
    MCP_HARNESS_INSTALL_REASON_MAX_LENGTH,
  );
}

async function stage(
  deps: McpHarnessInstallDeps,
  harness: HarnessCompatibilityHarness,
  server: StagedMcpServer,
): Promise<McpHarnessInstallState> {
  try {
    await deps.stagers[harness](server);
    return { status: 'installed', updatedAt: deps.now() };
  } catch (cause) {
    return {
      status: 'failed',
      reason: failureReason(cause),
      updatedAt: deps.now(),
    };
  }
}

async function requireServer(
  deps: McpHarnessInstallDeps,
  serverId: string,
  configId: string,
): Promise<{ file: McpServerFile; server: StagedMcpServer }> {
  const file = await deps.loadServer(serverId);
  if (file === undefined) throw new Error('This MCP server is not installed.');
  const server = stagedMcpServer(file, configId);
  if (server === undefined)
    throw new Error('This MCP server has no configuration to install.');
  return { file, server };
}

/**
 * Stages a saved server for each set-up harness that can load it, one at a
 * time, then commits the record. A harness that refuses it keeps its reason;
 * the others stay installed. No harness to install for writes nothing.
 */
export async function installMcpServerForHarnesses(
  deps: McpHarnessInstallDeps,
  request: InstallMcpServerForHarnessesRequest,
): Promise<McpServerHarnessInstalls | null> {
  // Checked again when the record is written: a removal while the harnesses
  // are staged discards this Add rather than recreating its record.
  const generation = removalGeneration(request.serverId);
  const startedAt = deps.now();
  const { file, server } = await requireServer(
    deps,
    request.serverId,
    request.configId,
  );
  const checked: ConfirmedSetUpHarnesses =
    (await deps.confirmedSetUpHarnesses?.()) ?? {
      confirmed: [],
      pending: [],
    };
  const compatibility = await deps.compatibility(file);
  // Catching up stages only harnesses the record has no state for; a
  // recorded one is neither staged again nor rewritten (CAN-6817).
  const latest =
    request.mode === 'catch-up'
      ? (await deps.store.read())[request.serverId]
      : undefined;
  const recorded = latest?.configId === request.configId ? latest : undefined;
  const absent = (harness: HarnessCompatibilityHarness): boolean =>
    recorded?.harnesses[harness] === undefined;
  const targets = mcpHarnessInstallTargets(
    [...request.harnesses, ...checked.confirmed].filter(isMcpInstallHarness),
    compatibility,
  ).filter(absent);
  // A harness whose setup check never answered is recorded as failed, not
  // dropped, so its row offers Try again once it is ready.
  const pending = mcpHarnessInstallTargets(
    [...(request.pendingHarnesses ?? []), ...checked.pending].filter(
      isMcpInstallHarness,
    ),
    compatibility,
  ).filter((harness) => !targets.includes(harness) && absent(harness));
  if (targets.length === 0 && pending.length === 0) return recorded ?? null;
  const harnesses: Partial<
    Record<HarnessCompatibilityHarness, McpHarnessInstallState>
  > = {};
  for (const harness of targets)
    harnesses[harness] = await stage(deps, harness, server);
  for (const harness of pending)
    harnesses[harness] = {
      status: 'failed',
      reason: "Its setup check didn't finish in time.",
      updatedAt: deps.now(),
    };
  const now = deps.now();
  let removed = false;
  // Merged into the latest record in one store step (CAN-6817), so a
  // concurrent Try again or sync keeps its own harnesses.
  const record = await deps.store.update(request.serverId, (existing) => {
    if (removalGeneration(request.serverId) !== generation) {
      removed = true;
      return existing;
    }
    const sameConfig =
      existing?.configId === request.configId ? existing : undefined;
    // A new Add keeps only what changed after it started; catching up a
    // newly set-up harness only adds harnesses the latest record has no
    // state for, and never rewrites a recorded one.
    const catchUp = request.mode === 'catch-up';
    const kept = catchUp
      ? sameConfig
      : keepMcpChangedSince(sameConfig, startedAt);
    const added: typeof harnesses = {};
    for (const harness of MCP_INSTALL_HARNESSES) {
      const state = harnesses[harness];
      if (state !== undefined && !(catchUp && kept?.harnesses[harness]))
        added[harness] = state;
    }
    return {
      version: MCP_SERVER_HARNESS_INSTALLS_VERSION,
      configId: request.configId,
      harnesses: { ...kept?.harnesses, ...added },
      createdAt: kept?.createdAt ?? now,
      updatedAt: now,
    };
  });
  return removed ? null : (record ?? null);
}

function keepMcpChangedSince(
  record: McpServerHarnessInstalls | undefined,
  since: string,
): McpServerHarnessInstalls | undefined {
  if (record === undefined) return undefined;
  const harnesses: Partial<
    Record<HarnessCompatibilityHarness, McpHarnessInstallState>
  > = {};
  for (const harness of MCP_INSTALL_HARNESSES) {
    const state = record.harnesses[harness];
    if (state !== undefined && state.updatedAt >= since)
      harnesses[harness] = state;
  }
  return Object.keys(harnesses).length === 0
    ? undefined
    : { ...record, harnesses };
}

// Removals this process has seen, per server. An Add, Try again or sync that
// started before one never writes its record after it (CAN-6817).
const removalGenerations = new Map<string, number>();

function removalGeneration(serverId: string): number {
  return removalGenerations.get(serverId) ?? 0;
}

/** Stages one harness of an earlier install again and records the result. */
export async function retryMcpServerHarnessInstall(
  deps: McpHarnessInstallDeps,
  request: RetryMcpServerHarnessInstallRequest,
): Promise<McpServerHarnessInstalls> {
  if (!isMcpInstallHarness(request.harness))
    throw new Error('Unknown harness.');
  const generation = removalGeneration(request.serverId);
  const existing = (await deps.store.read())[request.serverId];
  if (existing?.harnesses[request.harness] === undefined)
    throw new Error(
      `This server was not installed for ${HARNESS_LABELS[request.harness]}.`,
    );
  const { server } = await requireServer(
    deps,
    request.serverId,
    existing.configId,
  );
  const state = await stage(deps, request.harness, server);
  const now = deps.now();
  let gone = false;
  // Only the retried harness changes, merged into the latest record.
  const record = await deps.store.update(request.serverId, (latest) => {
    if (
      latest === undefined ||
      latest.configId !== existing.configId ||
      removalGeneration(request.serverId) !== generation
    ) {
      gone = true;
      return latest;
    }
    return {
      ...latest,
      harnesses: { ...latest.harnesses, [request.harness]: state },
      updatedAt: now,
    };
  });
  if (gone || record === undefined) throw new Error('This server was removed.');
  return record;
}

/**
 * After the user saves a server (CAN-6817): stages every harness its record
 * lists with the saved definition, so each harness's adapter is checked
 * against what its sessions now get. A harness changed while this ran keeps
 * that newer state; a server or configuration that is gone keeps its record
 * as it is. Resolves the record written, or `undefined` when there was
 * nothing to sync.
 */
export async function resyncMcpServerHarnessInstalls(
  deps: McpHarnessInstallDeps,
  serverId: string,
): Promise<McpServerHarnessInstalls | undefined> {
  const generation = removalGeneration(serverId);
  const startedAt = deps.now();
  const existing = (await deps.store.read())[serverId];
  if (existing === undefined) return undefined;
  const file = await deps.loadServer(serverId);
  const server =
    file === undefined ? undefined : stagedMcpServer(file, existing.configId);
  if (server === undefined) return undefined;
  const fresh: Partial<
    Record<HarnessCompatibilityHarness, McpHarnessInstallState>
  > = {};
  for (const harness of MCP_INSTALL_HARNESSES)
    if (existing.harnesses[harness] !== undefined)
      fresh[harness] = await stage(deps, harness, server);
  const now = deps.now();
  return deps.store.update(serverId, (latest) => {
    if (
      latest === undefined ||
      latest.configId !== existing.configId ||
      removalGeneration(serverId) !== generation
    )
      return latest;
    const harnesses = { ...latest.harnesses };
    for (const harness of MCP_INSTALL_HARNESSES) {
      const state = fresh[harness];
      const current = latest.harnesses[harness];
      if (state === undefined) continue;
      if (current !== undefined && current.updatedAt > startedAt) continue;
      harnesses[harness] = state;
    }
    return { ...latest, harnesses, updatedAt: now };
  });
}

/**
 * Removing a server removes it from every harness it was installed for, and
 * its record with it (CAN-6817): checks still running discard their results,
 * and a removal the disk refuses is retried; until it lands every read in
 * this process leaves the record out. Resolves whether it is off the disk.
 */
export async function forgetMcpServerHarnessInstalls(
  store: McpHarnessInstallStore,
  serverId: string,
): Promise<boolean> {
  removalGenerations.set(serverId, removalGeneration(serverId) + 1);
  return store.remove(serverId);
}

/**
 * Adds each device row's record to the index it serves. A record whose
 * configuration is gone, or whose server is not on this device, is left out.
 */
export function withMcpHarnessInstalls(
  index: McpServersIndexFile,
  records: Readonly<Record<string, McpServerHarnessInstalls>>,
): McpServersIndexFile {
  if (Object.keys(records).length === 0) return index;
  return {
    ...index,
    servers: index.servers.map((entry) => {
      const record = Object.prototype.hasOwnProperty.call(records, entry.id)
        ? records[entry.id]
        : undefined;
      if (
        record === undefined ||
        entry.scope === 'account' ||
        entry.accountConnection !== undefined ||
        !entry.configs.some((config) => config.id === record.configId)
      )
        return entry;
      return { ...entry, harnessInstalls: record };
    }),
  };
}
