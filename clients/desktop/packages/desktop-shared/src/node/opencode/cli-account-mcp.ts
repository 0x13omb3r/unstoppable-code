import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import {
  normalizeMcpServerFile,
  type AccountMcpConnection,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  getMcpHttpAuthHandler,
  getMcpHttpAuthDefault,
  isMcpHttpAuthHandler,
} from '@canopy/execution-engine/lib/mcp-http-auth';
import { buildManagedMcpServerName } from '@canopy/execution-engine/node/plugins/mcp-server-name';
import {
  readPluginMcpConfigObjects,
  type ResolvedPluginRuntime,
} from '@canopy/execution-engine/node/plugins/plugin-resolver';
import {
  accountMcpConnectionForRef,
  matchAccountMcpConnection,
} from '../../lib/effective-plugin-selections';
import type { ChatTabPluginSelections } from '../../types';
import { readHeadlessPreferences } from '../approvals/headless-session';
import type { CliOpenCodeAccount } from './cli-account';
import { openCodeCapabilityDigest } from './capability-snapshot';

const connectionsSchema = z.object({
  connections: z.array(
    z.object({
      id: z.string().min(1),
      serverKey: z.string().min(1),
      configId: z.string().min(1),
      displayName: z.string(),
      routeId: z.string().min(1),
      status: z.enum([
        'PENDING',
        'CONNECTED',
        'REAUTH_REQUIRED',
        'DISCONNECTED',
      ]),
      enabledTools: z.array(z.string()).nullable(),
      kind: z.enum(['CURATED', 'CUSTOM']),
      enabled: z.boolean().optional(),
    }),
  ),
});

interface AccountRoute {
  connection: AccountMcpConnection;
  fingerprint: string;
}

/** Captures explicit account connections, leaving OAuth tokens on the hosted service. */
export class CliOpenCodeAccountMcp {
  readonly routes = new Map<string, AccountRoute>();
  private rows: AccountMcpConnection[] | undefined;

  constructor(
    private readonly account: CliOpenCodeAccount | undefined,
    private readonly signal: AbortSignal,
  ) {}

  private async connections(): Promise<AccountMcpConnection[]> {
    if (!this.account)
      throw new Error(
        'An authenticated CLI account is required for connected MCP servers.',
      );
    const snapshot = await this.account.snapshot(this.signal);
    if (
      !['mcp-connections-v1', 'mcp-proxy-v1'].every((capability) =>
        snapshot.capabilities.includes(capability),
      )
    )
      throw new Error('Account MCP connections are unavailable.');
    const { connections } = connectionsSchema.parse(
      await this.account.request('/api/v1/mcp-connections', this.signal),
    );
    if (
      new Set(connections.map((row) => row.id)).size !== connections.length ||
      new Set(
        connections.map((row) => JSON.stringify([row.serverKey, row.configId])),
      ).size !== connections.length
    )
      throw new Error('Account MCP connections are ambiguous.');
    return connections;
  }

  private add(
    name: string,
    connection: AccountMcpConnection | undefined,
  ): void {
    if (
      !connection ||
      connection.status !== 'CONNECTED' ||
      connection.enabled === false
    )
      throw new Error(
        'A selected account MCP connection is missing, disconnected or disabled.',
      );
    if (this.routes.has(name))
      throw new Error('Selected MCP server identities collide.');
    this.routes.set(name, {
      connection,
      fingerprint: openCodeCapabilityDigest(connection),
    });
  }

  async select(
    selections: ChatTabPluginSelections,
  ): Promise<ChatTabPluginSelections> {
    if (!selections.mcpServerRefs?.length) return selections;
    const preferences = await readHeadlessPreferences();
    const defaultHandler = isMcpHttpAuthHandler(
      preferences.mcpHttpAuthDefaultHandler,
    )
      ? preferences.mcpHttpAuthDefaultHandler
      : 'canopy';
    const local = [];
    let index: unknown;
    try {
      index = JSON.parse(
        await readFile(
          join(getCanopyDataDir(), 'mcp-servers', 'index.json'),
          'utf8',
        ),
      );
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
    if (
      index !== undefined &&
      (!isRecord(index) ||
        !Array.isArray(index.servers) ||
        !index.servers.every(
          (row: unknown) => isRecord(row) && typeof row.id === 'string',
        ) ||
        new Set(index.servers.map((row: { id: string }) => row.id)).size !==
          index.servers.length)
    )
      throw new Error('The MCP catalog index is unreadable or ambiguous.');
    for (const ref of selections.mcpServerRefs ?? []) {
      if (
        ref.serverId.includes('/') ||
        ref.serverId.includes('\\') ||
        ref.serverId.includes('..')
      )
        throw new Error('Invalid selected MCP server id.');
      let raw: unknown;
      try {
        raw = JSON.parse(
          await readFile(
            join(
              getCanopyDataDir(),
              'mcp-servers',
              `server-${ref.serverId}.json`,
            ),
            'utf8',
          ),
        );
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      }
      const file =
        raw === undefined
          ? undefined
          : normalizeMcpServerFile(raw, ref.serverId);
      const config = file?.server.configs.find(
        (candidate) => candidate.id === ref.configId,
      );
      if (file && (!config || !config.enabled))
        throw new Error('A selected MCP configuration is disabled or missing.');
      if (file?.server.definition.type === 'command') {
        local.push(ref);
        continue;
      }
      const rows: unknown[] =
        isRecord(index) && Array.isArray(index.servers) ? index.servers : [];
      const entry = rows.find(
        (row): row is Record<string, unknown> =>
          isRecord(row) && row.id === ref.serverId,
      );
      const indexEntry = entry
        ? {
            scope:
              entry.scope === 'account'
                ? ('account' as const)
                : ('device' as const),
            authHandler: isMcpHttpAuthHandler(entry.authHandler)
              ? entry.authHandler
              : undefined,
          }
        : undefined;
      const handler = getMcpHttpAuthHandler(
        selections,
        { kind: 'standalone', ...ref },
        file
          ? getMcpHttpAuthDefault(
              file.server.definition,
              indexEntry,
              defaultHandler,
            )
          : 'account',
      ).handler;
      if (handler !== 'account') {
        if (file?.server.definition.oauth)
          throw new Error(
            'This MCP server uses device OAuth. Connect it to the account before running it with the desktop closed.',
          );
        local.push(ref);
        continue;
      }
      this.rows ??= await this.connections();
      const connection = file
        ? matchAccountMcpConnection(this.rows, {
            curatedKey: file.server.definition.curated?.key,
            accountConnectionId:
              typeof entry?.accountConnectionId === 'string'
                ? entry.accountConnectionId
                : undefined,
            configId: ref.configId,
          })
        : accountMcpConnectionForRef(ref, this.rows);
      const name = buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts: [
          file?.server.definition.name ??
            connection?.displayName ??
            ref.serverId,
        ],
        identityParts: [ref.serverId, ref.configId],
      });
      this.add(name, connection);
    }
    return { ...selections, mcpServerRefs: local };
  }

  async plugins(
    selections: ChatTabPluginSelections,
    resolved: ResolvedPluginRuntime,
  ): Promise<void> {
    const preferences = await readHeadlessPreferences();
    const defaultHandler = isMcpHttpAuthHandler(
      preferences.mcpHttpAuthDefaultHandler,
    )
      ? preferences.mcpHttpAuthDefaultHandler
      : 'canopy';
    for (const plugin of resolved.opencodePlugins ?? []) {
      for (const [serverName, raw] of Object.entries(
        readPluginMcpConfigObjects(plugin),
      )) {
        if (typeof raw.url !== 'string' || raw.enabled === false) continue;
        const target = {
          kind: 'plugin' as const,
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
          serverName,
        };
        const handler = getMcpHttpAuthHandler(
          selections,
          target,
          defaultHandler,
        ).handler;
        if (handler !== 'account') {
          if (raw.oauth !== undefined)
            throw new Error(
              'This plugin needs an account MCP connection for desktop-closed execution.',
            );
          continue;
        }
        this.rows ??= await this.connections();
        const connection = matchAccountMcpConnection(this.rows, {
          curatedKey:
            isRecord(raw.curated) && typeof raw.curated.key === 'string'
              ? raw.curated.key
              : undefined,
        });
        const name = buildManagedMcpServerName({
          kind: 'plugin',
          friendlyParts: [plugin.pluginName, serverName],
          identityParts: [plugin.marketplaceId, plugin.pluginName, serverName],
        });
        if (!Object.prototype.hasOwnProperty.call(resolved.mcpServers, name))
          throw new Error('The selected plugin MCP server was not resolved.');
        this.add(name, connection);
        delete resolved.mcpServers[name];
      }
    }
  }

  definitions(): Record<string, unknown> {
    const account = this.account;
    if (!account && this.routes.size)
      throw new Error('Account MCP authority is unavailable.');
    return Object.fromEntries(
      [...this.routes].map(([name, { connection }]) => [
        name,
        {
          type: 'http',
          url: `${account?.origin}/api/v1/mcp-proxy/${encodeURIComponent(connection.routeId)}`,
          headers: { Authorization: account?.authorization() },
        },
      ]),
    );
  }

  async assertCurrent(name: string): Promise<void> {
    const route = this.routes.get(name);
    if (!route) return;
    const current = (await this.connections()).find(
      (row) => row.id === route.connection.id,
    );
    if (!current || openCodeCapabilityDigest(current) !== route.fingerprint)
      throw new Error('The selected account MCP connection changed.');
  }
}
