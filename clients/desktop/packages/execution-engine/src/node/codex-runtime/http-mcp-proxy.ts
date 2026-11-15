import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type {
  McpCredentialRef,
  McpUpstreamAuthorization,
  McpUpstreamAuthorizer,
} from '@canopy/core-runtime/node/mcp-auth';
import { isRecord } from '../lib/type-guards';
import type { CodexStdioMcpToolCallGate } from './mcp-stdio-gate';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * A route's upstream credential (CAN-6168): authorized once per upstream
 * request, its header written into that request's own headers only.
 */
export interface CodexHttpMcpRouteAuthorizer {
  readonly credentials: McpUpstreamAuthorizer;
  readonly credential: McpCredentialRef;
}

interface HttpMcpRoute {
  ownerId: string;
  upstreamUrl: URL;
  headers: Record<string, string>;
  authorizer?: CodexHttpMcpRouteAuthorizer;
  activeRequests: Set<ClientRequest>;
  toolCallGate?: CodexStdioMcpToolCallGate;
  pendingGates: Set<AbortController>;
}

export interface CodexHttpMcpProxyLease {
  routeId: string;
  url: string;
}

function normalizedHeaders(
  incoming: IncomingHttpHeaders,
  fixed: Record<string, string>,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const normalized = key.toLowerCase();
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      normalized !== 'authorization'
    ) {
      headers[normalized] = value;
    }
  }
  for (const [key, value] of Object.entries(fixed)) {
    headers[key.toLowerCase()] = value;
  }
  return headers;
}

function responseHeaders(
  incoming: IncomingHttpHeaders,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(incoming).filter(
      ([key, value]) =>
        value !== undefined && !HOP_BY_HOP_HEADERS.has(key.toLowerCase()),
    ),
  ) as Record<string, string | string[]>;
}

export class CodexHttpMcpProxyService {
  private readonly routes = new Map<string, HttpMcpRoute>();
  private server: Server | null = null;
  private port: number | null = null;
  private startPromise: Promise<void> | null = null;

  async registerRoute(options: {
    ownerId: string;
    upstreamUrl: string;
    headers?: Record<string, string>;
    toolCallGate?: CodexStdioMcpToolCallGate;
    authorizer?: CodexHttpMcpRouteAuthorizer;
  }): Promise<CodexHttpMcpProxyLease> {
    await this.ensureStarted();
    const routeId = randomBytes(24).toString('hex');
    this.routes.set(routeId, {
      ownerId: options.ownerId,
      toolCallGate: options.toolCallGate,
      pendingGates: new Set(),
      upstreamUrl: new URL(options.upstreamUrl),
      headers: { ...(options.headers ?? {}) },
      ...(options.authorizer && { authorizer: options.authorizer }),
      activeRequests: new Set<ClientRequest>(),
    });
    return {
      routeId,
      url: `http://127.0.0.1:${String(this.port)}/mcp/${routeId}`,
    };
  }

  revokeOwner(ownerId: string): void {
    for (const [routeId, route] of Array.from(this.routes.entries())) {
      if (route.ownerId !== ownerId) continue;
      this.routes.delete(routeId);
      for (const gate of route.pendingGates) gate.abort();
      for (const request of Array.from(route.activeRequests)) {
        request.destroy();
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const route of Array.from(this.routes.values())) {
      for (const gate of route.pendingGates) gate.abort();
      for (const request of Array.from(route.activeRequests)) {
        request.destroy();
      }
    }
    this.routes.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    this.startPromise = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.server && this.port !== null) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.proxy(request, response).catch(() => {
          if (response.destroyed) return;
          if (!response.headersSent) response.writeHead(403);
          response.end();
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Codex HTTP MCP proxy did not bind loopback'));
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve();
      });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async proxy(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const match = request.url?.match(/^\/mcp\/([a-f0-9]{48})$/);
    const route = match?.[1] ? this.routes.get(match[1]) : undefined;
    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"MCP proxy route unavailable"}');
      return;
    }
    let body: Buffer | undefined;
    if (route.toolCallGate) {
      const cancellation = new AbortController();
      route.pendingGates.add(cancellation);
      const interrupt = (): void => {
        request.destroy();
      };
      cancellation.signal.addEventListener('abort', interrupt, { once: true });
      const bodyDeadline = setTimeout(() => cancellation.abort(), 30_000);
      bodyDeadline.unref();
      const cancel = (): void => cancellation.abort();
      request.once('aborted', cancel);
      response.once('close', cancel);
      try {
        if (request.method === 'POST') {
          const parts: Buffer[] = [];
          let size = 0;
          for await (const part of request) {
            if (!Buffer.isBuffer(part)) throw new Error('Invalid MCP body.');
            size += part.length;
            if (size > 2 * 1024 * 1024)
              throw new Error('MCP body exceeds limit.');
            parts.push(part);
          }
          body = Buffer.concat(parts);
          const message: unknown = JSON.parse(body.toString('utf8'));
          if (!isRecord(message) || message.jsonrpc !== '2.0')
            throw new Error('Invalid MCP message.');
          if (message.method === 'tools/call') {
            if (
              !isRecord(message.params) ||
              typeof message.params.name !== 'string' ||
              !(await route.toolCallGate({
                toolName: message.params.name,
                arguments: message.params.arguments ?? {},
                signal: cancellation.signal,
              }))
            )
              throw new Error('MCP tool denied.');
          } else if (
            ![
              'initialize',
              'notifications/initialized',
              'notifications/cancelled',
              'tools/list',
              'ping',
            ].includes(String(message.method))
          ) {
            throw new Error('MCP method denied.');
          }
        } else if (request.method !== 'GET' && request.method !== 'DELETE') {
          throw new Error('MCP method denied.');
        }
        if (
          cancellation.signal.aborted ||
          this.routes.get(match?.[1] ?? '') !== route
        )
          throw new Error('MCP route revoked.');
      } finally {
        clearTimeout(bodyDeadline);
        cancellation.signal.removeEventListener('abort', interrupt);
        route.pendingGates.delete(cancellation);
        request.removeListener('aborted', cancel);
        response.removeListener('close', cancel);
      }
    }
    if (!route.authorizer) {
      this.forward(request, response, route, route.headers, undefined, body);
      return;
    }
    // Held until the upstream request opens, then piped as is.
    request.pause();
    void authorizeUpstream(route.upstreamUrl, route.authorizer).then(
      (granted): void => {
        // The client went away while the owner decided: an unused
        // authorization goes stale on its own.
        if (response.destroyed) return;
        if (granted.kind !== 'authorized') {
          request.resume();
          writeAuthorizationFailure(response, granted.kind);
          return;
        }
        // The header lives only in this request's own map: never on the
        // route, never logged.
        const headers: Record<string, string> = { ...route.headers };
        if (granted.authorization.apply(headers) !== 'applied') {
          request.resume();
          writeAuthorizationFailure(response, 'unavailable');
          return;
        }
        this.forward(
          request,
          response,
          route,
          headers,
          granted.authorization,
          body,
        );
      },
    );
  }

  private forward(
    request: IncomingMessage,
    response: ServerResponse,
    route: HttpMcpRoute,
    fixedHeaders: Record<string, string>,
    authorization?: McpUpstreamAuthorization,
    body?: Buffer,
  ): void {
    if (!this.isLive(route)) {
      request.resume();
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"MCP proxy route unavailable"}');
      return;
    }
    const requestImpl =
      route.upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = requestImpl(
      route.upstreamUrl,
      {
        method: request.method,
        headers: normalizedHeaders(request.headers, fixedHeaders),
      },
      (upstreamResponse) => {
        // The upstream refused the token this request carried: the owner
        // invalidates exactly that one. As in process, no retry.
        if (upstreamResponse.statusCode === 401 && authorization)
          void authorization.rejected();
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          responseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    route.activeRequests.add(upstream);
    const cleanup = (): void => {
      route.activeRequests.delete(upstream);
    };
    upstream.once('close', cleanup);
    upstream.once('error', () => {
      cleanup();
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end('{"error":"MCP upstream request failed"}');
        return;
      }
      response.destroy();
    });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy();
    });
    if (body) upstream.end(body);
    else request.pipe(upstream);
    request.resume();
  }

  /** False once the route was revoked, as while its request was authorized. */
  private isLive(route: HttpMcpRoute): boolean {
    for (const candidate of this.routes.values())
      if (candidate === route) return true;
    return false;
  }
}

async function authorizeUpstream(
  upstreamUrl: URL,
  authorizer: CodexHttpMcpRouteAuthorizer,
): Promise<
  | { kind: 'authorized'; authorization: McpUpstreamAuthorization }
  | { kind: 'none' }
  | { kind: 'unavailable' }
> {
  try {
    const outcome = await authorizer.credentials.authorize({
      credential: authorizer.credential,
      purpose: 'mcp.upstream.forward',
      upstreamUrl: upstreamUrl.href,
    });
    return outcome.status === 'authorized'
      ? { kind: 'authorized', authorization: outcome.authorization }
      : { kind: 'none' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** As in process: no credential asks the client to sign in; an owner that can't decide is unavailable. */
function writeAuthorizationFailure(
  response: ServerResponse,
  kind: 'none' | 'unavailable',
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const status = kind === 'none' ? 401 : 503;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error:
        kind === 'none'
          ? { code: -32001, message: 'MCP server authorization required.' }
          : { code: -32000, message: 'MCP server authorization unavailable.' },
    }),
  );
}
