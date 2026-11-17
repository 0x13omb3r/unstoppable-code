import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import ts from 'typescript';

jest.mock('../../lib/chat-visuals-feature-flag', () => ({
  chatVisualsEligible: (): boolean => false,
}));

import { CANOPY_MCP_WORKTREE_SESSION_PATH } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import {
  CanopyToolRouter,
  type CanopyWorktreeSessionRoute,
} from '../canopy-tool-router';
import { McpHttpProxyService } from '../http-proxy-service';
import { canopyRouteFixtures } from './helpers/canopy-route-fixtures';

interface ModuleImport {
  specifier: string;
  names: string[];
  typeOnly: boolean;
}

function importsOf(file: string): ModuleImport[] {
  const path = join(__dirname, '..', file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: ModuleImport[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name) names.push(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          names.push((element.propertyName ?? element.name).text);
      found.push({
        specifier: node.moduleSpecifier.text,
        names,
        typeOnly: clause?.isTypeOnly === true,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names: string[] = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          names.push((element.propertyName ?? element.name).text);
      found.push({
        specifier: node.moduleSpecifier.text,
        names,
        typeOnly: node.isTypeOnly,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument))
        found.push({ specifier: argument.text, names: [], typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const specifiers = (file: string): string[] =>
  importsOf(file).map(({ specifier }) => specifier);

describe('MCP proxy boundaries (CAN-4125)', () => {
  it('the agent connection service imports no tool, window or transport module', () => {
    const imported = specifiers('agent-mcp-connections.ts');
    expect(imported.length).toBeGreaterThan(0);
    for (const forbidden of [
      'electron',
      '../lib/window-send',
      './http-proxy-service',
      './canopy-tool-router',
      './canopy-route-tools',
    ])
      expect(imported).not.toContain(forbidden);
    for (const prefix of [
      '../canopy-tools/',
      '../app-advisor/',
      '../pipeline-editor/',
    ])
      expect(imported.filter((s) => s.startsWith(prefix))).toEqual([]);
  });

  it('the tool router and listing reach presentation only through the interface port', () => {
    for (const file of ['canopy-tool-router.ts', 'canopy-route-tools.ts']) {
      const imports = importsOf(file);
      const imported = imports.map(({ specifier }) => specifier);
      expect(imported.length).toBeGreaterThan(0);
      for (const forbidden of [
        'electron',
        '../lib/window-send',
        '../canopy-tools/show-files-runtime',
        './agent-mcp-connections',
      ])
        expect(imported).not.toContain(forbidden);
      const names = imports.flatMap((entry) => entry.names);
      for (const forbidden of [
        'requestAnswersFromRenderer',
        'requestShowFiles',
        'mainWindowOnlyToolSurfaces',
        'sendToWindow',
      ])
        expect(names).not.toContain(forbidden);
    }
  });

  it('the interface port imports no connection or plugin module', () => {
    const imports = importsOf('interface-tool-requests.ts');
    const imported = imports.map(({ specifier }) => specifier);
    expect(imported).not.toContain('./agent-mcp-connections');
    expect(imported.filter((s) => s.startsWith('../plugins/'))).toEqual([]);
    // ShowVisual stages through core.chat.visual.stage, not the port (CAN-5996).
    expect(imported).not.toContain('../canopy-tools/show-visual-host');
    expect(imports.flatMap((entry) => entry.names)).not.toContain(
      'createShowVisualHost',
    );
    for (const entry of imports)
      if (entry.specifier === './canopy-tool-router')
        expect(entry.typeOnly).toBe(true);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === 'object' && address ? address.port : 0;
}

/**
 * Sends the headers and half of a tools/list body, waits until the handler has
 * authenticated against the registered route, runs `during`, then sends the
 * rest. The handler goes from its authentication lookup through the token and
 * method checks into the awaited body read without yielding, and that read
 * cannot finish before the rest of the body is sent, so `during` always runs
 * inside the body read.
 */
async function postAroundBodyRead(
  url: string,
  route: CanopyWorktreeSessionRoute,
  during: () => unknown,
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  // A call-through spy: its first recorded lookup of this session key is the
  // handler's authentication, made in the same tick it enters the body read.
  const lookup = jest.spyOn(CanopyToolRouter.prototype, 'route');
  const authLookup = async (): Promise<
    CanopyWorktreeSessionRoute | undefined
  > => {
    for (;;) {
      const index = lookup.mock.calls.findIndex(
        ([sessionKey]) => sessionKey === route.sessionKey,
      );
      if (index >= 0) {
        const result = lookup.mock.results[index];
        return result?.type === 'return' ? result.value : undefined;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  try {
    const response = new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        const req = request(
          url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              authorization: `Bearer ${route.authToken}`,
              'content-length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => (text += String(chunk)));
            res.on('end', () => {
              try {
                resolve({
                  status: res.statusCode ?? 0,
                  body: JSON.parse(text),
                });
              } catch (error) {
                reject(
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
            });
          },
        );
        req.on('error', reject);
        req.write(body.slice(0, 10));
        void authLookup()
          .then(async (found) => {
            // The handler authenticated against the registered route itself,
            // so a -32004 below can only come from the post-read recheck.
            expect(found).toBe(route);
            await during();
            req.end(body.slice(10));
          })
          .catch(reject);
      },
    );
    return await response;
  } finally {
    lookup.mockRestore();
  }
}

// A route replaced or torn down while its request body is still arriving must
// never dispatch through the route the handler authenticated against.
describe('worktree session route recheck after the body read', () => {
  let service: McpHttpProxyService;
  beforeEach(async () => {
    service = new McpHttpProxyService();
    await service.ensureStarted(await freePort());
  });
  afterEach(async () => service.shutdown());

  const sessionUrl = (sessionKey: string): string => {
    const url = service.getCanopyWorktreeMcpUrl(sessionKey);
    expect(
      new URL(url).pathname.startsWith(CANOPY_MCP_WORKTREE_SESSION_PATH),
    ).toBe(true);
    return url;
  };

  it('answers -32004 when the route is replaced during the body read', async () => {
    const route = canopyRouteFixtures()[0];
    await service.registerCanopyWorktreeSessionRoute(route);
    const result = await postAroundBodyRead(
      sessionUrl(route.sessionKey),
      route,
      () => service.registerCanopyWorktreeSessionRoute({ ...route }),
    );
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ id: 7, error: { code: -32004 } });
  });

  it('answers -32004 when the route is torn down during the body read', async () => {
    const route = canopyRouteFixtures()[0];
    await service.registerCanopyWorktreeSessionRoute(route);
    const result = await postAroundBodyRead(
      sessionUrl(route.sessionKey),
      route,
      () => service.unregisterCanopyWorktreeSessionRoute(route.sessionKey),
    );
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ id: 7, error: { code: -32004 } });
  });

  it('dispatches through an unchanged route', async () => {
    const route = canopyRouteFixtures()[0];
    await service.registerCanopyWorktreeSessionRoute(route);
    const result = await postAroundBodyRead(
      sessionUrl(route.sessionKey),
      route,
      () => undefined,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: 7, result: {} });
    expect(result.body).not.toHaveProperty('error');
  });
});
