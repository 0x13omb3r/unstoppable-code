import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  CLOUD_ACCOUNT,
  handleCloudRequest,
} from '../mock-server/routes/cloud.mjs';
import {
  CLOUD_RUN_OPERATIONS,
  cloudRunManifestOperations,
} from './cloudPipelinesManifest.js';
import {
  HOST_OPERATIONS,
  createFakeCloudRuns,
} from '../../../../../scripts/lib/fake-cloud-runs-web-core.mjs';

const CONNECTIONS = '/api/cloud/core/connections';
const START = 'core.pipeline.execution.start';
/**
 * The JSON-RPC code for each error kind, as `CANOPY_JSON_RPC_ERROR_CODES`
 * has it (not imported, so the Electron lane loads one protocol copy).
 */
const JSON_RPC_ERROR_CODES = {
  invalid_argument: -32602,
  unauthenticated: -32001,
  permission_denied: -32002,
  not_found: -32003,
  already_exists: -32004,
  conflict: -32005,
  failed_precondition: -32006,
  capability_unavailable: -32007,
  cancelled: -32008,
  deadline_exceeded: -32009,
  unavailable: -32010,
  resource_exhausted: -32011,
  internal: -32603,
};
const PREFLIGHT = 'core.pipeline.cloudModels.preflight';
const MANIFEST = 'core.runtime.manifest.get';
const HASH = 'a'.repeat(64);

/**
 * Per-test Cloud for cloud workflow runs (CAN-6187): a fake web core over the
 * real POST + SSE binding, one curated workflow, and the suite's Cloud
 * routes for everything else. There is no cloud runner yet, so a start is
 * only recorded.
 *
 * The web core answers `core.runtime.initialize` for the signed-in mock
 * account, reports every cloud run operation available once
 * `state.cloudRuns` is on, lists one model step for the preflight until
 * choices are saved, and records every start the desktop sends.
 *
 * Cloud runs themselves (CAN-6326) come from `cloudRuns`: seeded runs whose
 * reads, events and controls go over the connection's SSE pushes, as on the
 * web core (see `scripts/lib/fake-cloud-runs-web-core.mjs`).
 */
export async function startCloudPipelinesWebCore({
  workflowName,
  rawPipeline,
}) {
  const key = 'cloud-run-on';
  const hash = createHash('sha256').update(rawPipeline).digest('hex');
  const summary = {
    key,
    name: workflowName,
    shortDescription: 'A ready-made workflow that runs anywhere.',
    icon: '',
    version: '1.0.0',
    triggerTypes: ['dispatch'],
    scopes: ['global', 'worktree', 'directory'],
    jobCount: 1,
    stepCount: 1,
    contentHash: hash,
    contentSizeBytes: Buffer.byteLength(rawPipeline),
    categories: ['development'],
    popular: true,
    sortOrder: 0,
    revision: 1,
    authorName: 'Canopy',
    authorUrl: null,
    docsUrl: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  /**
   * `starts` are the recorded runs; `refusedStarts` the starts refused
   * because a model step had no confirmed cloud model (recording nothing).
   * `preparing` is how many more starts at a pushed branch answer that its
   * cloud worktree is being set up (CAN-6869), recording nothing;
   * `preparingStarts` are those starts. `heldStarts` are starts held by
   * `holdNextStart` whose answer was lost (CAN-6869). `signedOut` is how
   * many more starts answer that the caller isn't signed in, recording
   * nothing.
   * @type {{ cloudRuns: boolean, starts: object[], refusedStarts: object[], preflights: object[], preparing: number, preparingStarts: object[], heldStarts: object[], signedOut: number }}
   */
  const state = {
    cloudRuns: false,
    starts: [],
    refusedStarts: [],
    preflights: [],
    preparing: 0,
    preparingStarts: [],
    heldStarts: [],
    signedOut: 0,
  };
  /** The next start's gate: it waits, then its answer is lost. */
  let held = null;
  // A cloud run's cost too (CAN-6881), for runs seeded with one.
  const cloudRuns = createFakeCloudRuns({
    operations: [...CLOUD_RUN_OPERATIONS, 'core.cost.cloudRun.get'],
  });
  /** connectionId -> { sse: ServerResponse | null, pending: object[], push } */
  const connections = new Map();
  const openConnection = () => {
    const connection = {
      sse: null,
      pending: [],
      push(message) {
        if (connection.sse === null) connection.pending.push(message);
        else connection.sse.write(`data: ${JSON.stringify(message)}\n\n`);
      },
    };
    return connection;
  };

  const send = (response, status, data) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  };
  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
  };
  const authorized = (request) =>
    /^Bearer (csk_|cwc_)/.test(request.headers.authorization ?? '');

  const preflight = (params) => ({
    definitionId: params.definitionId,
    scheduleId: null,
    definitionHash: HASH,
    policyFingerprint: HASH,
    saved: 'none',
    items: [
      {
        itemKey: 'review#0',
        reason: 'local_harness',
        parityId: 'R2',
        message: 'This step uses Cursor, which only runs on your computer.',
        jobId: 'review',
        stepIndex: 0,
        stepName: 'Review the change',
        uses: 'builtin/agent-prompt',
        model: 'cursor:gpt-5',
        harness: 'cursor',
        alternatives: [
          {
            modelId: 'anthropic/claude-opus-5.5',
            label: 'Opus 5.5',
            harness: 'claude',
          },
        ],
      },
    ],
  });

  const answer = (method, params, connection) => {
    const cloudRun = state.cloudRuns
      ? cloudRuns.answer(method, params, connection)
      : undefined;
    if (cloudRun !== undefined) return cloudRun;
    switch (method) {
      case 'core.runtime.initialize':
        return {
          runtime: {
            runtimeId: 'web-core-e2e',
            hostId: 'web-core-e2e',
            authorityId: 'web-core-e2e',
            profile: 'core+worker',
            daemonEpoch: 'web-core-e2e',
            protocolVersions: [1],
            state: 'ready',
            buildVersion: 'e2e',
          },
          selectedProtocolVersion: 1,
          capabilities: {
            operations: [
              MANIFEST,
              PREFLIGHT,
              ...HOST_OPERATIONS,
              ...(state.cloudRuns
                ? [
                    ...CLOUD_RUN_OPERATIONS.filter(
                      (name) => !name.endsWith('.events'),
                    ),
                    // A cloud run's cost (CAN-6881).
                    'core.cost.cloudRun.get',
                  ]
                : []),
            ],
            events: [],
            streams: state.cloudRuns
              ? ['worker.pipeline.execution.events']
              : [],
          },
          limits: {},
          authentication: {
            required: true,
            methods: [],
            principal: { userId: CLOUD_ACCOUNT.id },
          },
        };
      case MANIFEST:
        return {
          runtime: {
            runtimeId: 'web-core-e2e',
            hostId: 'web-core-e2e',
            authorityId: 'web-core-e2e',
            profile: 'core+worker',
            daemonEpoch: 'web-core-e2e',
            protocolVersions: [1],
            state: 'ready',
          },
          operations: cloudRunManifestOperations(state.cloudRuns),
          generatedAt: new Date().toISOString(),
        };
      case PREFLIGHT:
        state.preflights.push(params);
        return preflight(params);
      // What the relay host calls for its session (CAN-6326).
      case 'core.client.lease.acquire':
        return {
          leaseId: randomUUID(),
          clientInstanceId: params.clientInstanceId,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          renewAfterMs: 60_000,
          revision: 1,
        };
      case 'core.client.lease.renew':
        return {
          leaseId: randomUUID(),
          clientInstanceId: 'e2e',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          renewAfterMs: 60_000,
          revision: (params.expectedRevision ?? 0) + 1,
        };
      case 'core.client.lease.release':
        return {
          released: true,
          releasedRegistrationCount: 0,
          failedRequestIds: [],
        };
      case 'core.events.ack':
        return { acknowledgedCursor: params.cursor };
      case 'core.events.unsubscribe':
        return { unsubscribed: cloudRuns.unsubscribe(params.subscriptionId) };
      case START: {
        // A pushed branch's cloud worktree still being set up: nothing is
        // recorded, and the caller sends the same start again (CAN-6869).
        if (params.checkout !== undefined && state.preparing > 0) {
          state.preparing -= 1;
          state.preparingStarts.push(params);
          return {
            error: {
              kind: 'unavailable',
              code: 'core.pipeline.worktreePreparing',
              message: `Setting up a cloud worktree for ${params.checkout.branch}. The run starts once it's ready.`,
              retry: { kind: 'same_request', delayMs: 10_000 },
            },
          };
        }
        // Signed out since the start was first sent: nothing is recorded.
        if (state.signedOut > 0) {
          state.signedOut -= 1;
          return {
            error: {
              kind: 'unauthenticated',
              message: 'Sign in again.',
              retry: { kind: 'never' },
            },
          };
        }
        // As the run service does: a model step with no confirmed cloud
        // model refuses the start and records nothing.
        if (params.modelChoices === undefined) {
          state.refusedStarts.push(params);
          return {
            error: {
              kind: 'failed_precondition',
              code: 'core.pipeline.cloudModelsUnconfirmed',
              message: 'Choose a cloud model for each listed step.',
              retry: { kind: 'never' },
            },
          };
        }
        state.starts.push(params);
        const operationId = randomUUID();
        const now = new Date().toISOString();
        return {
          operation: {
            operationId,
            kind: 'core.pipeline.run',
            status: 'queued',
            revision: 1,
            parentOperationId: null,
            rootOperationId: operationId,
            authorityId: 'web-core-e2e',
            executionTargetId: null,
            runtimeDelegationId: null,
            scope: {},
            origin: { kind: 'client', sourceId: `user:${CLOUD_ACCOUNT.id}` },
            owner: { kind: 'principal', id: `user:${CLOUD_ACCOUNT.id}` },
            receipt: {
              idempotencyKey: params._meta?.idempotencyKey ?? null,
              acceptedAt: now,
              outcome: 'recorded',
            },
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            progress: null,
            outcome: null,
            error: null,
            cancellation: null,
            restart: null,
          },
          statusReason: null,
          admission: 'admitted',
          replayed: false,
        };
      }
      default:
        return undefined;
    }
  };

  const notServed = (id) => ({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: 'Not served.',
      data: {
        kind: 'capability_unavailable',
        message: 'Not served.',
        retry: { kind: 'never' },
      },
    },
  });

  /** The web core's POST + SSE binding: connections, calls and pushes. */
  const handleWebCore = async (request, response, url) => {
    if (!authorized(request)) {
      send(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'POST' && url.pathname === CONNECTIONS) {
      const connectionId = randomUUID();
      connections.set(connectionId, openConnection());
      send(response, 201, {
        connectionId,
        connectionToken: `cwc_${randomUUID()}`,
      });
      return;
    }
    const [connectionId, leg] = url.pathname
      .slice(CONNECTIONS.length + 1)
      .split('/');
    const connection = connections.get(connectionId) ?? openConnection();
    if (request.method === 'DELETE') {
      cloudRuns.dropConnection(connection);
      connection.sse?.end();
      connections.delete(connectionId);
      send(response, 200, {});
      return;
    }
    // The connection's pushes: stream items, held until the stream opens.
    if (request.method === 'GET' && leg === 'events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': open\n\n');
      connection.sse = response;
      for (const message of connection.pending.splice(0))
        connection.push(message);
      response.on('close', () => {
        if (connection.sse === response) connection.sse = null;
      });
      return;
    }
    if (request.method === 'GET') {
      send(response, 404, { error: 'not found' });
      return;
    }
    const message = await readBody(request);
    if (message === null || message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    // A held start waits for its release, then answers as a lost response
    // would reach the caller: unavailable, the outcome unknown.
    const lost = message.method === START && held !== null;
    if (lost) {
      const gate = held;
      held = null;
      state.heldStarts.push(message.params ?? {});
      gate.arrived();
      await gate.released;
    }
    const result = lost
      ? {
          error: {
            // No code: the start declares none for a lost answer.
            kind: 'unavailable',
            message: 'The cloud stopped answering.',
            retry: { kind: 'never' },
          },
        }
      : answer(message.method, message.params ?? {}, connection);
    send(
      response,
      200,
      result === undefined
        ? notServed(message.id)
        : 'error' in result
          ? {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                // The JSON-RPC code for the payload's kind, as the wire
                // requires.
                code: JSON_RPC_ERROR_CODES[result.error.kind] ?? -32603,
                message: result.error.message,
                data: result.error,
              },
            }
          : { jsonrpc: '2.0', id: message.id, result },
    );
  };

  /** The curated catalog, with this test's one workflow. */
  const handleCurated = (request, response, url) => {
    if (!authorized(request)) {
      send(response, 401, { error: 'Invalid API key' });
      return;
    }
    if (url.pathname.endsWith('/curated')) {
      send(response, 200, { version: 1, data: [summary], nextCursor: null });
      return;
    }
    if (url.pathname.split('/').at(-2) !== key) {
      send(response, 404, { error: 'Not found' });
      return;
    }
    send(response, 200, { ...summary, rawPipeline });
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (
      url.pathname === CONNECTIONS ||
      url.pathname.startsWith(`${CONNECTIONS}/`)
    ) {
      await handleWebCore(request, response, url);
      return;
    }
    if (url.pathname.includes('/pipelines/curated')) {
      handleCurated(request, response, url);
      return;
    }
    if (await handleCloudRequest(request, response, url)) return;
    send(response, 404, { error: 'Not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    curatedId: `curated:${key}`,
    state,
    cloudRuns,
    /**
     * Holds the next start until `release()`, then loses its answer; it
     * records nothing. `arrived` settles once that start is in.
     */
    holdNextStart() {
      let arrived = () => {};
      let release = () => {};
      const arrival = new Promise((resolve) => {
        arrived = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      held = { arrived, released };
      return { arrived: arrival, release };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
