/**
 * The web core client for cloud workflow schedules (CAN-6183):
 * `core.pipeline.schedule.*` on main's own web core connection, one
 * connection per call, as attachment uploads do.
 */
import { randomUUID } from 'node:crypto';
import {
  CORE_PIPELINE_CLOUD_MODEL_INSTRUCTION_DEFINITIONS,
  CORE_PIPELINE_CLOUD_MODEL_QUERY_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  PIPELINE_SCHEDULE_FIRED_THROUGH_REVISION,
  PIPELINE_SCHEDULE_INSTRUCTION_DEFINITIONS,
  PIPELINE_SCHEDULE_QUERY_DEFINITIONS,
  PipelineScheduleListResultSchema,
  PipelineScheduleResultSchema,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  defineCanopyQueryRegistry,
  type CoreWorkspace,
  type CoreWorktree,
  type PipelineSchedule,
} from '@canopy/protocol/canopy-core';
import {
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
} from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import {
  connectWebCore,
  type WebCoreBindingOptions,
} from '../canopy-cloud/web-core-connection';
import {
  CloudScheduleRemoteError,
  type CloudScheduleRemote,
} from './cloud-schedules';
import type { CloudSchedulePlace } from './cloud-schedule-destinations';
import { githubRepositoryOfRemote } from '../pipelines/cloud-run-local-checkout';

/** The cloud places a move re-points a schedule at (CAN-6917). */
const PLACE_QUERIES = defineCanopyQueryRegistry('core', {
  'core.workspace.list': CORE_QUERY_DEFINITIONS['core.workspace.list'],
  'core.worktree.list': CORE_QUERY_DEFINITIONS['core.worktree.list'],
});

const DEFINITIONS = {
  queries: composeCanopyQueryRegistries(
    CORE_TRANSPORT_QUERY_DEFINITIONS,
    PIPELINE_SCHEDULE_QUERY_DEFINITIONS,
    CORE_PIPELINE_CLOUD_MODEL_QUERY_DEFINITIONS,
    PLACE_QUERIES,
  ),
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    PIPELINE_SCHEDULE_INSTRUCTION_DEFINITIONS,
    CORE_PIPELINE_CLOUD_MODEL_INSTRUCTION_DEFINITIONS,
  ),
  streams: {},
} as const;

/** The operations whose revision 2 a move needs (CAN-6917). */
const GUARDED_OPERATIONS = [
  'core.pipeline.schedule.create',
  'core.pipeline.schedule.delete',
] as const;
/** How long one manifest read answers whether the guard is served. */
const GUARD_TTL_MS = 60_000;
const PLACE_PAGE = 500;

type ScheduleClient = CanopyClient<
  typeof DEFINITIONS.queries,
  typeof DEFINITIONS.instructions
>;

const CALL_TIMEOUT_MS = 30_000;
const LIST_PAGE = 200;

function remoteError(error: unknown): CloudScheduleRemoteError {
  if (error instanceof CloudScheduleRemoteError) return error;
  return new CloudScheduleRemoteError(
    error instanceof CanopyClientError || error instanceof CanopyTransportError
      ? error.payload
      : null,
  );
}

/** The remote main uses, bound to its web core credentials. */
export function createWebCoreCloudScheduleRemote(
  binding: WebCoreBindingOptions,
  clientVersion: string,
  currentAccountId: () => Promise<string | null>,
): CloudScheduleRemote {
  async function call<Result>(
    run: (client: ScheduleClient) => Promise<Result>,
  ): Promise<Result> {
    const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    let client: ScheduleClient;
    try {
      client = await createCanopyClient({
        connection: await connectWebCore(binding, signal),
        clientName: 'canopy-desktop-cloud-schedules',
        clientVersion,
        definitions: DEFINITIONS,
        signal,
      });
    } catch (error) {
      throw remoteError(error);
    }
    try {
      return await run(client);
    } catch (error) {
      throw remoteError(error);
    } finally {
      await client.close();
    }
  }

  // Whether this account's web core serves the single-fire guard, read
  // from its manifest at most once a minute.
  let guard: { readonly at: number; readonly answer: boolean } | null = null;
  async function singleFireGuard(): Promise<boolean> {
    if (guard !== null && Date.now() - guard.at < GUARD_TTL_MS)
      return guard.answer;
    const { operations } = await call((client) =>
      client.query('core.runtime.manifest.get', {}),
    );
    const answer = GUARDED_OPERATIONS.every((name) =>
      operations.some(
        (operation) =>
          operation.name === name &&
          operation.available &&
          typeof operation.schemaRevision === 'number' &&
          operation.schemaRevision >= PIPELINE_SCHEDULE_FIRED_THROUGH_REVISION,
      ),
    );
    guard = { at: Date.now(), answer };
    return answer;
  }
  /**
   * Revision 2 when served, so answers carry `firedThrough`. A manifest that
   * can't be read fails the call: a move back sent as revision 1 would lose
   * the slot the cloud fired last.
   */
  async function revision(): Promise<
    { revision: typeof PIPELINE_SCHEDULE_FIRED_THROUGH_REVISION } | object
  > {
    return (await singleFireGuard())
      ? { revision: PIPELINE_SCHEDULE_FIRED_THROUGH_REVISION }
      : {};
  }

  async function places(): Promise<CloudSchedulePlace[]> {
    return call(async (client) => {
      const workspaces: CoreWorkspace[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.query('core.workspace.list', {
          pageSize: PLACE_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        workspaces.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      const worktrees: CoreWorktree[] = [];
      cursor = undefined;
      do {
        const page: { items: CoreWorktree[]; nextCursor: string | null } =
          await client.query('core.worktree.list', {
            pageSize: PLACE_PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          });
        worktrees.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return workspaces.map((workspace) => {
        const root = workspace.repositorySources[0]?.remoteUrl;
        return {
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          kind: workspace.kind === 'cowork' ? 'cowork' : 'git',
          ownerOrganizationId: workspace.ownerOrganizationId ?? null,
          repository:
            root === undefined ? null : githubRepositoryOfRemote(root),
          tasks: worktrees
            .filter(
              (worktree) =>
                worktree.workspaceId === workspace.workspaceId &&
                worktree.state === 'ready',
            )
            .map((worktree) => ({
              worktreeId: worktree.worktreeId,
              name: worktree.name,
              branch: worktree.branch,
            })),
        };
      });
    });
  }

  const gone = (error: unknown): boolean =>
    error instanceof CloudScheduleRemoteError &&
    error.payload?.kind === 'not_found';

  async function list(sourceRecordId?: string): Promise<PipelineSchedule[]> {
    return call(async (client) => {
      const schedules: PipelineSchedule[] = [];
      let cursor: string | undefined;
      do {
        const page = PipelineScheduleListResultSchema.parse(
          await client.query('core.pipeline.schedule.list', {
            limit: LIST_PAGE,
            ...(sourceRecordId === undefined ? {} : { sourceRecordId }),
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        schedules.push(...page.schedules);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return schedules;
    });
  }

  return {
    accountId: currentAccountId,
    singleFireGuard,
    places,
    preflight: (params) =>
      call((client) =>
        client.query('core.pipeline.cloudModels.preflight', { ...params }),
      ),
    saveModels: (params) =>
      call((client) =>
        // Inherently idempotent: saving the same choices stores the same row.
        client.instruction('core.pipeline.cloudModels.save', {
          ...params,
          choices: [...params.choices],
        }),
      ),
    async create(params) {
      const { firedThrough, ...rest } = params;
      const guarded = await revision();
      const result = await call((client) =>
        client.instruction('core.pipeline.schedule.create', {
          ...rest,
          // Sent only to a web core that keeps it: an older one refuses it.
          ...('revision' in guarded && firedThrough !== undefined
            ? { firedThrough }
            : {}),
          ...guarded,
          _meta: { idempotencyKey: randomUUID() },
        }),
      );
      return PipelineScheduleResultSchema.parse(result).schedule;
    },
    async get(scheduleId) {
      try {
        const guarded = await revision();
        const result = await call((client) =>
          client.query('core.pipeline.schedule.get', {
            scheduleId,
            ...guarded,
          }),
        );
        return PipelineScheduleResultSchema.parse(result).schedule;
      } catch (error) {
        if (gone(error)) return null;
        throw error;
      }
    },
    async findBySourceRecord(sourceRecordId) {
      return (await list(sourceRecordId))[0] ?? null;
    },
    list: () => list(),
    async update(params) {
      const result = await call((client) =>
        client.instruction('core.pipeline.schedule.update', {
          ...params,
          _meta: { idempotencyKey: randomUUID() },
        }),
      );
      return PipelineScheduleResultSchema.parse(result).schedule;
    },
    async delete(scheduleId, idempotencyKey) {
      try {
        // The same params on a retry, so the key replays the first answer.
        const guarded = await revision();
        const result = await call((client) =>
          client.instruction('core.pipeline.schedule.delete', {
            scheduleId,
            ...guarded,
            _meta: { idempotencyKey },
          }),
        );
        return PipelineScheduleResultSchema.parse(result).schedule;
      } catch (error) {
        if (gone(error)) return null;
        throw error;
      }
    },
  };
}
