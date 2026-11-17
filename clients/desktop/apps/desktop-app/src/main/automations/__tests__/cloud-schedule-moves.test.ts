// CAN-6183 (plan CP-71): a workflow schedule moved to the cloud is stored
// server-side, kept here as a stub the scheduler never fires, and moving it
// back deletes the server record before the stub turns into a local record,
// so one slot never has two live records. The real automations service runs
// over a temporary automations file; the web core is an in-memory remote.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CloudModelPreflightItem,
  CloudModelPreflightResult,
  PipelineSchedule,
  PipelineScheduleCreateParams,
} from '@canopy/protocol/canopy-core';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type * as Paths from '../../lib/paths';
import type * as ResourceContext from '../../lib/resource-context';
import {
  CloudScheduleRemoteError,
  firesLocally,
  type CloudScheduleHost,
  type CloudScheduleRemote,
} from '../cloud-schedules';
import type {
  CloudSchedulePlace,
  LocalSchedulePlace,
} from '../cloud-schedule-destinations';
import { SharedPipelinePinMismatchError } from '../../pipelines/pipeline-package-service';
import type { AutomationsService } from '../service';

let mockDirectory = '';
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof Paths>('../../lib/paths'),
  getAutomationsFilePath: (): string => join(mockDirectory, 'automations.json'),
  getDataDir: (): string => mockDirectory,
}));
jest.mock('../../lib/resource-context', () => ({
  ...jest.requireActual<typeof ResourceContext>('../../lib/resource-context'),
  resourceContextEnabled: (): boolean => false,
}));
jest.setTimeout(30_000);

const ACCOUNT = 'account-1';
const REMOTE_ID = '00000000-0000-4000-8000-0000000000f1';

interface MemoryRemote {
  readonly remote: CloudScheduleRemote;
  readonly records: Map<string, PipelineSchedule>;
  readonly failures: {
    create?: 'lost' | 'refused';
    delete?: 'unreachable' | 'lost';
    preflight?: 'refused';
    /** The next save finds the workflow or model policy changed. */
    save?: 'stale';
  };
  /** What the web core serves and holds beyond the store (CAN-6917). */
  readonly cloud: {
    guard: boolean;
    places: CloudSchedulePlace[];
    /** Model steps a preflight lists for every schedule. */
    modelItems: CloudModelPreflightItem[];
    /** Schedules whose replacements were saved. */
    saved: Set<string>;
    /** What each create was sent, in order. */
    creates: Omit<PipelineScheduleCreateParams, '_meta'>[];
  };
}

/** The web core's schedule store, in memory, with its refusals. */
function memoryRemote(): MemoryRemote {
  const records = new Map<string, PipelineSchedule>();
  const failures: MemoryRemote['failures'] = {};
  const cloud: MemoryRemote['cloud'] = {
    guard: true,
    places: [],
    modelItems: [],
    saved: new Set(),
    creates: [],
  };
  const preflightOf = (scheduleId: string): CloudModelPreflightResult => ({
    definitionId: 'definition',
    scheduleId,
    definitionHash: 'a'.repeat(64),
    policyFingerprint: 'b'.repeat(64),
    items: cloud.modelItems,
    saved:
      cloud.modelItems.length === 0
        ? 'none'
        : cloud.saved.has(scheduleId)
          ? 'current'
          : 'none',
  });
  const deletes = new Map<string, PipelineSchedule | null>();
  const now = (): string => new Date().toISOString();
  // Synchronous bodies: a thrown refusal rejects the promise it returns.
  const settle = <T>(run: () => T): Promise<T> => {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };
  const create = (
    params: Omit<PipelineScheduleCreateParams, '_meta'>,
  ): PipelineSchedule => {
    cloud.creates.push(params);
    if (failures.create === 'refused')
      throw new CloudScheduleRemoteError({
        kind: 'permission_denied',
        code: 'core.pipeline.schedule.ownerDenied',
        message: "You can't schedule runs for this owner.",
        retry: { kind: 'never' },
      });
    const taken = [...records.values()].find(
      (record) => record.sourceRecordId === params.sourceRecordId,
    );
    if (taken)
      throw new CloudScheduleRemoteError({
        kind: 'already_exists',
        code: 'core.pipeline.schedule.sourceRecordTaken',
        message: 'This schedule is already in the cloud.',
        details: { scheduleId: taken.scheduleId },
        retry: { kind: 'never' },
      });
    const record: PipelineSchedule = {
      scheduleId: randomUUID(),
      revision: 1,
      owner: params.owner,
      name: params.name,
      sourcePipelineId: params.sourcePipelineId,
      sourceRecordId: params.sourceRecordId,
      workflow:
        params.workflow.kind === 'definition'
          ? params.workflow
          : {
              kind: 'snapshot',
              contentHash: params.workflow.contentHash,
              packageDigest: params.workflow.packageDigest,
            },
      trigger: params.trigger,
      runCondition: params.runCondition ?? null,
      enabled: params.enabled,
      inputs: { ...(params.inputs ?? {}) },
      destination: params.destination,
      createdAt: now(),
      updatedAt: now(),
      firedThrough: params.firedThrough ?? null,
      runDefinitionId:
        params.workflow.kind === 'definition'
          ? params.workflow.definitionId
          : `workflow-snapshot:${params.workflow.contentHash}`,
    };
    records.set(record.scheduleId, record);
    // The server stored it, but its answer never arrived.
    if (failures.create === 'lost') {
      delete failures.create;
      throw new CloudScheduleRemoteError(null);
    }
    return record;
  };
  const update = (
    params: Parameters<CloudScheduleRemote['update']>[0],
  ): PipelineSchedule => {
    const current = records.get(params.scheduleId);
    if (!current || current.revision !== params.expectedRevision)
      throw new CloudScheduleRemoteError({
        kind: 'conflict',
        message: 'This schedule changed.',
        retry: { kind: 'never' },
      });
    const { owner, workflow, ...fields } = params;
    const rest: Partial<typeof fields> = { ...fields };
    delete rest.scheduleId;
    delete rest.expectedRevision;
    const next: PipelineSchedule = {
      ...current,
      ...rest,
      ...(owner === undefined ? {} : { owner }),
      ...(workflow === undefined || workflow.kind === 'definition'
        ? workflow === undefined
          ? {}
          : { workflow }
        : {
            workflow: {
              kind: 'snapshot',
              contentHash: workflow.contentHash,
              packageDigest: workflow.packageDigest,
            },
          }),
      runCondition:
        params.runCondition === undefined
          ? current.runCondition
          : params.runCondition,
      revision: current.revision + 1,
      updatedAt: now(),
    };
    records.set(params.scheduleId, next);
    return next;
  };
  const remote: CloudScheduleRemote = {
    accountId: () => Promise.resolve(ACCOUNT),
    create: (params) => settle(() => create(params)),
    get: (scheduleId) => Promise.resolve(records.get(scheduleId) ?? null),
    findBySourceRecord: (sourceRecordId) =>
      Promise.resolve(
        [...records.values()].find(
          (record) => record.sourceRecordId === sourceRecordId,
        ) ?? null,
      ),
    list: () => Promise.resolve([...records.values()]),
    update: (params) => settle(() => update(params)),
    delete: (scheduleId, idempotencyKey) =>
      settle(() => {
        // A resend with the same key replays the first answer.
        const replayed = deletes.get(idempotencyKey);
        if (replayed !== undefined) return replayed;
        if (failures.delete === 'unreachable')
          throw new CloudScheduleRemoteError(null);
        const record = records.get(scheduleId) ?? null;
        records.delete(scheduleId);
        deletes.set(idempotencyKey, record);
        // The server deleted it, but its answer never arrived.
        if (failures.delete === 'lost') {
          delete failures.delete;
          throw new CloudScheduleRemoteError(null);
        }
        return record;
      }),
    singleFireGuard: () => Promise.resolve(cloud.guard),
    places: () => Promise.resolve(cloud.places),
    preflight: ({ scheduleId }) =>
      failures.preflight === 'refused'
        ? Promise.reject(
            new CloudScheduleRemoteError({
              kind: 'failed_precondition',
              code: 'core.pipeline.cloudRunRefused',
              message: 'This workflow uses the Orchestrator.',
              retry: { kind: 'never' },
            }),
          )
        : Promise.resolve(preflightOf(scheduleId)),
    saveModels: ({ scheduleId, choices }) => {
      if (failures.save === 'stale') {
        delete failures.save;
        return Promise.reject(
          new CloudScheduleRemoteError({
            kind: 'failed_precondition',
            code: 'core.pipeline.cloudModelsUnconfirmed',
            message: 'The workflow changed. Choose again.',
            retry: { kind: 'never' },
          }),
        );
      }
      if (choices.length === cloud.modelItems.length)
        cloud.saved.add(scheduleId);
      return Promise.resolve(preflightOf(scheduleId));
    },
  };
  return { remote, records, failures, cloud };
}

interface MemoryHost {
  readonly host: CloudScheduleHost;
  /** This computer's places, by project id. */
  readonly local: Map<string, LocalSchedulePlace>;
  /** The shared workflow's current version; a change mismatches a pin. */
  shared: { document: string; changed: boolean };
}

function memoryHost(): MemoryHost {
  const local = new Map<string, LocalSchedulePlace>();
  const state: MemoryHost = {
    local,
    shared: {
      document: 'name: Digest\non: dispatch\njobs: {}\n',
      changed: false,
    },
    host: {
      localPlace: (action) =>
        Promise.resolve(
          action.workspaceId === undefined
            ? null
            : (local.get(action.workspaceId) ?? null),
        ),
      pinnedSharedDocument: () =>
        state.shared.changed
          ? Promise.reject(
              new SharedPipelinePinMismatchError(REMOTE_ID, 'Digest'),
            )
          : Promise.resolve(state.shared.document),
    },
  };
  return state;
}

function schedule(
  id: string,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: 'Morning digest',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
      pipelineSource: 'shared',
      sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
      inputs: { project_id: 'p-1' },
    },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

async function seed(activities: ScheduledActivity[]): Promise<void> {
  await writeFile(
    join(mockDirectory, 'automations.json'),
    JSON.stringify({ version: 1, activities, recentRuns: [] }),
  );
}

function isActivity(value: unknown): value is ScheduledActivity {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string'
  );
}

async function stored(): Promise<ScheduledActivity[]> {
  const file: unknown = JSON.parse(
    await readFile(join(mockDirectory, 'automations.json'), 'utf8'),
  );
  if (
    typeof file !== 'object' ||
    file === null ||
    !('activities' in file) ||
    !Array.isArray(file.activities)
  )
    throw new Error('Unreadable automations file.');
  const activities: unknown[] = file.activities;
  return activities.filter(isActivity);
}

async function service(
  memory: MemoryRemote = memoryRemote(),
  host: MemoryHost = memoryHost(),
): Promise<
  MemoryRemote & { automations: AutomationsService; places: MemoryHost }
> {
  const { AutomationsService } = await import('../service');
  const automations = new AutomationsService();
  automations.setCloudScheduleRemote(memory.remote);
  automations.setCloudScheduleHost(host.host);
  return { automations, ...memory, places: host };
}

/** Records that fire for `id`: here when the local record is on, and in the cloud. */
async function liveRecords(
  id: string,
  records: Map<string, PipelineSchedule>,
): Promise<number> {
  const local = (await stored()).filter(
    (activity) =>
      activity.id === id && activity.enabled && firesLocally(activity),
  ).length;
  // A record the cloud holds off doesn't fire either.
  const cloud = [...records.values()].filter(
    (record) => record.sourceRecordId === id && record.enabled,
  ).length;
  return local + cloud;
}

beforeEach(async () => {
  mockDirectory = await mkdtemp(
    join(process.env.TMPDIR ?? process.cwd(), 'cloud-schedule-moves-'),
  );
});

afterEach(async () => {
  await rm(mockDirectory, { recursive: true, force: true });
});

describe('cloud workflow schedule moves (CAN-6183)', () => {
  it('stores a moved schedule server-side and keeps a stub this desktop never runs', async () => {
    await seed([schedule('s-1')]);
    const { automations, records } = await service();
    const moved = await automations.moveScheduleToCloud('s-1');
    expect(moved.ok).toBe(true);

    const [record] = [...records.values()];
    expect(record).toMatchObject({
      sourceRecordId: 's-1',
      owner: 'personal',
      enabled: true,
      workflow: {
        kind: 'definition',
        source: 'shared',
        definitionId: `shared:canopy-cloud:${REMOTE_ID}`,
      },
      trigger: { kind: 'cron', expression: '0 9 * * 1-5' },
      inputs: { project_id: 'p-1' },
      destination: { kind: 'global' },
    });
    const [stub] = await stored();
    // Stored off, so a desktop that predates the field never fires it.
    expect(stub).toMatchObject({
      executionLocation: 'cloud',
      enabled: false,
      cloudSchedule: {
        scheduleId: record.scheduleId,
        accountId: ACCOUNT,
        localEnabled: true,
      },
    });
    expect(stub.nextRunAt).toBeUndefined();
    expect(await liveRecords('s-1', records)).toBe(1);

    // The server record is authoritative: the service call behind
    // IPC_CHANNELS.automationsRunNow refuses a stub, and the one behind
    // IPC_CHANNELS.automationsUpdate changes the server record with what a
    // Trigger tab row edits, never the stub (CAN-6917).
    expect((await automations.runNow({ id: 's-1' })).ok).toBe(false);
    expect(
      (
        await automations.update({
          id: 's-1',
          ifCommand: 'test -f ready',
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
            pipelineSource: 'shared',
            sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
            inputs: { project_id: 'p-2' },
          },
        })
      ).ok,
    ).toBe(true);
    expect(records.get(record.scheduleId)).toMatchObject({
      runCondition: 'test -f ready',
      inputs: { project_id: 'p-2' },
    });
    // The Trigger tab's form clears what the schedule doesn't have.
    expect(
      (
        await automations.update({
          id: 's-1',
          schedule: {
            kind: 'cron',
            expression: '0 8 * * *',
            timezone: 'local',
          },
          targetRequirement: null,
          dependencies: null,
        })
      ).ok,
    ).toBe(true);
    expect(records.get(record.scheduleId)?.trigger).toMatchObject({
      expression: '0 8 * * *',
    });
    // Where it runs changes only by moving it.
    expect(
      (
        await automations.update({
          id: 's-1',
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'project' },
            workspaceId: 'local-project',
            pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
            pipelineSource: 'shared',
            sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
          },
        })
      ).ok,
    ).toBe(false);
    // An agent's edit is refused: the cloud record can't say who made it.
    expect(
      (
        await automations.update(
          { id: 's-1', enabled: false },
          undefined,
          undefined,
          {
            agentAuthor: {
              chat: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
              recordedAt: '2026-11-16T00:00:00.000Z',
            },
          },
        )
      ).ok,
    ).toBe(false);
    // Another workflow is a move back first.
    expect(
      (
        await automations.update({
          id: 's-1',
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId: 'curated:other',
            pipelineSource: 'curated',
          },
        })
      ).ok,
    ).toBe(false);

    // Desktop and web show one schedule: IPC_CHANNELS.automationsList's
    // projection shows the stub with the server's values.
    const edited = await automations.updateCloudSchedule('s-1', {
      enabled: false,
      schedule: { kind: 'cron', expression: '30 7 * * *', timezone: 'local' },
    });
    expect(edited.ok).toBe(true);
    const { projectOwnedChatAutomations } =
      await import('../owned-chat-projection');
    const [shown] = projectOwnedChatAutomations(
      await automations.list(),
    ).activities;
    expect(shown).toMatchObject({
      enabled: false,
      schedule: { expression: '30 7 * * *' },
      // Stored held off, turned on once its model check passed (CAN-6917),
      // then edited three times.
      cloudRecord: { scheduleId: record.scheduleId, revision: 5 },
    });
  });

  it('stores several schedules of one workflow', async () => {
    await seed([schedule('s-1'), schedule('s-2', { name: 'Evening digest' })]);
    const { automations, records } = await service();
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    expect((await automations.moveScheduleToCloud('s-2')).ok).toBe(true);
    expect(
      [...records.values()].map((record) => [
        record.sourceRecordId,
        record.sourcePipelineId,
      ]),
    ).toEqual([
      ['s-1', `shared:canopy-cloud:${REMOTE_ID}`],
      ['s-2', `shared:canopy-cloud:${REMOTE_ID}`],
    ]);
  });

  it('moves back by deleting the server record first, never leaving two live records', async () => {
    await seed([schedule('s-1')]);
    const { automations, records, failures } = await service();
    await automations.moveScheduleToCloud('s-1');
    const [record] = [...records.values()];
    // Edited in the cloud since this desktop last read it.
    records.set(record.scheduleId, {
      ...record,
      revision: 2,
      trigger: { kind: 'cron', expression: '15 6 * * *', timeZone: 'UTC' },
      runCondition: 'test -f ready',
    });

    // The server can't be reached: nothing here changes, the stub stays off.
    failures.delete = 'unreachable';
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(false);
    expect((await stored())[0].executionLocation).toBe('cloud');
    expect(await liveRecords('s-1', records)).toBe(1);

    // The server deleted it but the answer was lost: the stub stays off, and
    // the retry replays the deleted record under the same key.
    failures.delete = 'lost';
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(false);
    expect(records.size).toBe(0);
    expect((await stored())[0].executionLocation).toBe('cloud');
    expect(await liveRecords('s-1', records)).toBe(0);
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(true);
    expect(records.size).toBe(0);
    const [local] = await stored();
    expect(local.executionLocation).toBeUndefined();
    expect(local.cloudSchedule).toBeUndefined();
    // It comes back as the cloud held it.
    expect(local).toMatchObject({
      enabled: true,
      schedule: { kind: 'cron', expression: '15 6 * * *', timezone: 'local' },
      ifCommand: 'test -f ready',
    });
    expect(local.nextRunAt).toBeDefined();
    expect(await liveRecords('s-1', records)).toBe(1);

    // And back again: still exactly one live record.
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    expect(await liveRecords('s-1', records)).toBe(1);
  });

  it('moves back with the owner and workflow the cloud record holds', async () => {
    await seed([schedule('s-1')]);
    const { automations, records } = await service();
    await automations.moveScheduleToCloud('s-1');
    const [record] = [...records.values()];
    const org = 'org:00000000-0000-4000-8000-00000000000a';
    records.set(record.scheduleId, {
      ...record,
      revision: 2,
      owner: org,
      workflow: {
        kind: 'definition',
        source: 'curated',
        definitionId: 'curated:digest',
      },
    });
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(true);
    const [local] = await stored();
    expect(local.executionContext).toBe(org);
    expect(local.action).toMatchObject({
      type: 'worktree_pipeline',
      pipelineSource: 'curated',
      pipelineId: 'curated:digest',
    });
    expect(
      local.action.type === 'worktree_pipeline' && local.action.sharedPipeline,
    ).toBeFalsy();
  });

  it('keeps a move whose answer was lost paused until it is resolved', async () => {
    await seed([schedule('s-1'), schedule('s-2')]);
    const { automations, records, failures } = await service();

    // A refused move puts the local record back as it was.
    failures.create = 'refused';
    expect((await automations.moveScheduleToCloud('s-2')).ok).toBe(false);
    expect((await stored())[1]).toMatchObject({ enabled: true });
    expect((await stored())[1].executionLocation).toBeUndefined();

    // The server stored it but the answer was lost: paused here, and held
    // off there until a move finishes (CAN-6917).
    failures.create = 'lost';
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(false);
    const [pending] = await stored();
    expect(pending).toMatchObject({
      executionLocation: 'cloud',
      enabled: false,
    });
    expect(pending.cloudSchedule?.scheduleId).toBeUndefined();
    expect(records.size).toBe(1);
    expect(await liveRecords('s-1', records)).toBe(0);

    // Moving again takes over the record the first move left.
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    expect(records.size).toBe(1);
    const [record] = [...records.values()];
    expect((await stored())[0].cloudSchedule?.scheduleId).toBe(
      record.scheduleId,
    );
    expect(await liveRecords('s-1', records)).toBe(1);
  });

  // IPC_CHANNELS.automationsDelete calls the service's delete.
  it('deletes a cloud schedule server-side before its stub', async () => {
    await seed([schedule('s-1')]);
    const { automations, records, failures } = await service();
    await automations.moveScheduleToCloud('s-1');
    failures.delete = 'unreachable';
    expect((await automations.delete({ id: 's-1' })).ok).toBe(false);
    expect(await stored()).toHaveLength(1);
    delete failures.delete;
    expect((await automations.delete({ id: 's-1' })).ok).toBe(true);
    expect(records.size).toBe(0);
    expect(await stored()).toHaveLength(0);
  });

  it('never fires a stub or a location it does not know, and keeps both', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await seed([
      // As if a stub were stored on: the location alone keeps it unfired.
      schedule('stub', {
        executionLocation: 'cloud',
        cloudSchedule: {
          scheduleId: randomUUID(),
          accountId: ACCOUNT,
          movedAt: past,
          localEnabled: true,
        },
        nextRunAt: past,
      }),
      schedule('elsewhere', {
        executionLocation: 'device:other',
        nextRunAt: past,
      }),
    ]);
    const { automations } = await service();
    await automations.start();
    automations.stop();
    const snapshot = await automations.list();
    expect(snapshot.recentRuns).toEqual([]);
    expect(
      snapshot.activities.map((activity) => [
        activity.id,
        activity.executionLocation,
      ]),
    ).toEqual([
      ['stub', 'cloud'],
      ['elsewhere', 'device:other'],
    ]);
    expect((await automations.runNow({ id: 'elsewhere' })).ok).toBe(false);
    expect((await automations.update({ id: 'elsewhere', name: 'x' })).ok).toBe(
      false,
    );
  });
});

// CAN-6917 (plan CP-47): the Run in control, which calls the service's
// moves through IPC_CHANNELS.automationsMoveSchedule
// (api.automations.moveSchedule). A moved schedule fires each
// slot in one place only, also while a move is in flight, across restarts,
// and whatever either clock says; a project, task or new worktree is
// re-pointed at the owner's cloud place or the person is asked to pick one;
// a move checks models and the reviewed shared workflow first.
describe('choosing where a schedule runs (CAN-6917)', () => {
  const CLOUD_PROJECT = '00000000-0000-4000-8000-0000000000c1';
  const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000c2';
  const CLOUD_TASK = '00000000-0000-4000-8000-0000000000d1';
  /** A slot at `hour` local time on 17 Nov 2026, as its instant. */
  const at = (hour: number, minute = 0, second = 0): Date =>
    new Date(2026, 10, 17, hour, minute, second);
  const hourly = {
    kind: 'cron' as const,
    expression: '0 * * * *',
    timezone: 'local' as const,
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Run records for `scheduledFor`, after a start-up due check. */
  async function firedAfterRestart(
    memory: MemoryRemote,
    host: MemoryHost,
    scheduledFor: Date,
  ): Promise<number> {
    const restarted = await service(memory, host);
    await restarted.automations.start();
    restarted.automations.stop();
    const { recentRuns } = await restarted.automations.list();
    return recentRuns.filter(
      (run) =>
        run.scheduledFor !== undefined &&
        Date.parse(run.scheduledFor) === scheduledFor.getTime(),
    ).length;
  }

  it('never fires a moved schedule twice in one slot, whichever clock runs ahead', async () => {
    jest.useFakeTimers({
      now: at(9, 0, 30),
      advanceTimers: true,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    // This computer fired 09:00 just before the move.
    await seed([
      schedule('s-1', {
        schedule: hourly,
        lastScheduledFor: at(9).toISOString(),
      }),
    ]);
    const memory = memoryRemote();
    const host = memoryHost();
    const { automations, records, cloud } = await service(memory, host);
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    // The cloud is told, so it never fires 09:00 by a clock behind this one.
    expect(cloud.creates[0]?.firedThrough).toBe(at(9).toISOString());
    expect(await liveRecords('s-1', records)).toBe(1);

    // The cloud fires 10:00; this computer's clock is ten seconds behind
    // when the schedule comes back.
    const [record] = [...records.values()];
    records.set(record.scheduleId, {
      ...record,
      firedThrough: at(10).toISOString(),
    });
    jest.setSystemTime(at(9, 59, 50));
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(true);
    const [local] = await stored();
    expect(local.lastScheduledFor).toBe(at(10).toISOString());
    expect(local.nextRunAt).toBe(at(11).toISOString());
    expect(await liveRecords('s-1', records)).toBe(1);

    // Restarted at 10:00:05 by its clock: 10:00 doesn't fire here again.
    jest.setSystemTime(at(10, 0, 5));
    expect(await firedAfterRestart(memory, host, at(10))).toBe(0);
  });

  it('never fires a one-time schedule here that the cloud already fired', async () => {
    jest.useFakeTimers({
      now: at(9, 30),
      advanceTimers: true,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    await seed([
      schedule('s-1', {
        schedule: {
          kind: 'one_time',
          runAt: at(10).toISOString(),
          timezone: 'local',
        },
      }),
    ]);
    const memory = memoryRemote();
    const host = memoryHost();
    const { automations, records } = await service(memory, host);
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    const [record] = [...records.values()];
    records.set(record.scheduleId, {
      ...record,
      firedThrough: at(10).toISOString(),
    });
    jest.setSystemTime(at(10, 1));
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(true);
    const [local] = await stored();
    expect(local.enabled).toBe(false);
    // Turned back on, the slot the cloud fired stays spent: it left no run
    // here, only the slot it passed.
    await seed([{ ...local, enabled: true }]);
    expect(await firedAfterRestart(memory, host, at(10))).toBe(0);
    expect((await stored())[0].nextRunAt).toBeUndefined();
  });

  it('keeps one live record while a move is in flight and across a restart', async () => {
    jest.useFakeTimers({
      now: at(9, 59, 30),
      advanceTimers: true,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    await seed([schedule('s-1', { schedule: hourly })]);
    const memory = memoryRemote();
    const host = memoryHost();
    const { automations, records, failures } = await service(memory, host);
    // The server stored it held off, and its answer never came back.
    failures.create = 'lost';
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(false);
    expect(await liveRecords('s-1', records)).toBe(0);

    // This computer restarts past 10:00: the pending stub never fires.
    jest.setSystemTime(at(10, 0, 5));
    expect(await firedAfterRestart(memory, host, at(10))).toBe(0);

    // Moving again takes over the record and turns it on there only.
    const again = await service(memory, host);
    expect((await again.automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    expect(records.size).toBe(1);
    expect(await liveRecords('s-1', records)).toBe(1);
  });

  it('moves back a schedule whose move never heard back, on as it was here', async () => {
    await seed([schedule('s-1')]);
    const { automations, records, failures } = await service();
    failures.create = 'lost';
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(false);
    // The held-off record the move left is deleted, and the schedule runs
    // here again as it did before the move.
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(true);
    expect(records.size).toBe(0);
    expect((await stored())[0]).toMatchObject({ enabled: true });
    expect(await liveRecords('s-1', records)).toBe(1);
  });

  it('undoes a refused move without firing again a slot the cloud fired meanwhile', async () => {
    jest.useFakeTimers({
      now: at(9, 30),
      advanceTimers: true,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    await seed([schedule('s-1', { schedule: hourly })]);
    const memory = memoryRemote();
    const host = memoryHost();
    const { automations, records, cloud, failures } = await service(
      memory,
      host,
    );
    cloud.modelItems = [
      {
        itemKey: 'review#0',
        reason: 'local_harness',
        parityId: 'R2',
        message: 'Cursor models only run on this computer.',
        jobId: 'review',
        stepIndex: 0,
        uses: 'builtin/agent-prompt',
        model: 'cursor/auto',
        alternatives: [],
      },
    ];
    expect(await automations.moveScheduleToCloud('s-1')).toMatchObject({
      needs: 'models',
    });
    // Say the record fired 10:00 before a definite refusal undid the move.
    const [record] = [...records.values()];
    records.set(record.scheduleId, {
      ...record,
      firedThrough: at(10).toISOString(),
    });
    failures.preflight = 'refused';
    jest.setSystemTime(at(9, 59, 50));
    // The undo's delete lands but its answer is lost: the stub stays, and
    // the retry replays the deleted record under the same key.
    failures.delete = 'lost';
    expect(await automations.moveScheduleToCloud('s-1')).toMatchObject({
      ok: false,
    });
    expect(records.size).toBe(0);
    expect((await stored())[0].executionLocation).toBe('cloud');
    expect(await automations.moveScheduleToCloud('s-1')).toMatchObject({
      ok: false,
    });
    const [local] = await stored();
    expect(local.executionLocation).toBeUndefined();
    expect(local.lastScheduledFor).toBe(at(10).toISOString());
    jest.setSystemTime(at(10, 0, 5));
    expect(await firedAfterRestart(memory, host, at(10))).toBe(0);
  });

  it("refuses a Cowork task's schedule even with a cloud task picked", async () => {
    await seed([
      schedule('s-1', {
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'task', taskId: 'cowork-task' },
          workspaceId: 'cowork-project',
          pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
          pipelineSource: 'shared',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
        },
      }),
    ]);
    const { automations, records, cloud, places } = await service();
    places.local.set('cowork-project', {
      kind: 'cowork',
      repository: null,
      branch: null,
    });
    cloud.places = [
      {
        workspaceId: CLOUD_PROJECT,
        name: 'App',
        kind: 'git',
        ownerOrganizationId: null,
        repository: 'acme/app',
        tasks: [{ worktreeId: CLOUD_TASK, name: 'Main', branch: 'main' }],
      },
    ];
    const moved = await automations.moveScheduleToCloud('s-1', {
      destination: {
        kind: 'task',
        workspaceId: CLOUD_PROJECT,
        taskId: CLOUD_TASK,
      },
    });
    expect(moved).toMatchObject({ ok: false });
    expect('needs' in moved).toBe(false);
    expect(records.size).toBe(0);
  });

  it("refuses a project workflow, whose models the cloud can't check yet", async () => {
    await seed([
      schedule('s-1', {
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'project' },
          workspaceId: 'local-project',
          pipelineId: 'project--review.yaml',
          pipelineSource: 'project',
        },
      }),
    ]);
    const { automations, records } = await service();
    expect(await automations.moveScheduleToCloud('s-1')).toMatchObject({
      ok: false,
    });
    expect(records.size).toBe(0);
  });

  it('refuses a move to a web core without the single-fire guard', async () => {
    await seed([schedule('s-1')]);
    const { automations, records, cloud } = await service();
    cloud.guard = false;
    const moved = await automations.moveScheduleToCloud('s-1');
    expect(moved).toMatchObject({ ok: false });
    expect(records.size).toBe(0);
    expect((await stored())[0].executionLocation).toBeUndefined();
  });

  it("re-points a project or task schedule at the owner's matching cloud place, and moves it back to its own", async () => {
    await seed([
      schedule('project', {
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'project' },
          workspaceId: 'local-project',
          pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
          pipelineSource: 'shared',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
        },
      }),
      schedule('task', {
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'task', taskId: 'local-task' },
          workspaceId: 'local-project',
          pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
          pipelineSource: 'shared',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
        },
      }),
    ]);
    const { automations, records, cloud, places } = await service();
    places.local.set('local-project', {
      kind: 'git',
      repository: 'acme/app',
      branch: 'feature/digest',
    });
    cloud.places = [
      {
        workspaceId: CLOUD_PROJECT,
        name: 'App',
        kind: 'git',
        ownerOrganizationId: null,
        repository: 'Acme/App',
        tasks: [
          { worktreeId: CLOUD_TASK, name: 'Digest', branch: 'feature/digest' },
        ],
      },
      // Another owner's project of the same repository never matches.
      {
        workspaceId: OTHER_PROJECT,
        name: 'App (team)',
        kind: 'git',
        ownerOrganizationId: '00000000-0000-4000-8000-00000000000a',
        repository: 'acme/app',
        tasks: [],
      },
    ];
    expect((await automations.moveScheduleToCloud('project')).ok).toBe(true);
    expect((await automations.moveScheduleToCloud('task')).ok).toBe(true);
    const destinations = [...records.values()].map((record) => [
      record.sourceRecordId,
      record.destination,
    ]);
    expect(destinations).toEqual([
      ['project', { kind: 'project', workspaceId: CLOUD_PROJECT }],
      [
        'task',
        { kind: 'task', workspaceId: CLOUD_PROJECT, taskId: CLOUD_TASK },
      ],
    ]);

    // Back here, it runs where it ran before, not in a cloud project.
    expect((await automations.moveScheduleToLocal('task')).ok).toBe(true);
    const back = (await stored()).find((activity) => activity.id === 'task');
    expect(back?.action).toMatchObject({
      target: { kind: 'task', taskId: 'local-task' },
      workspaceId: 'local-project',
    });
  });

  it('asks for a cloud place when none or several match, and checks the pick', async () => {
    await seed([
      schedule('s-1', {
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'new_worktree' },
          workspaceId: 'local-project',
          pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
          pipelineSource: 'shared',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
        },
      }),
    ]);
    const { automations, records, cloud, places } = await service();
    places.local.set('local-project', {
      kind: 'git',
      repository: 'acme/app',
      branch: null,
    });
    // No cloud place at all: refused, with nothing to pick.
    const none = await automations.moveScheduleToCloud('s-1');
    expect(none).toMatchObject({ ok: false });
    expect('needs' in none).toBe(false);

    const project = (
      workspaceId: string,
      name: string,
    ): CloudSchedulePlace => ({
      workspaceId,
      name,
      kind: 'git',
      ownerOrganizationId: null,
      repository: 'acme/app',
      tasks: [],
    });
    cloud.places = [
      project(CLOUD_PROJECT, 'App'),
      project(OTHER_PROJECT, 'App copy'),
    ];
    const asked = await automations.moveScheduleToCloud('s-1');
    expect(asked).toMatchObject({
      ok: false,
      needs: 'destination',
      candidates: [
        {
          destination: { kind: 'new_worktree', workspaceId: CLOUD_PROJECT },
          label: 'App',
        },
        {
          destination: { kind: 'new_worktree', workspaceId: OTHER_PROJECT },
          label: 'App copy',
        },
      ],
    });
    // Asking changed nothing.
    expect(records.size).toBe(0);
    expect((await stored())[0]).toMatchObject({ enabled: true });

    // A pick outside the owner's places, or of another kind, is refused.
    expect(
      await automations.moveScheduleToCloud('s-1', {
        destination: {
          kind: 'new_worktree',
          workspaceId: '00000000-0000-4000-8000-0000000000ff',
        },
      }),
    ).toMatchObject({ ok: false, needs: 'destination' });
    expect(
      await automations.moveScheduleToCloud('s-1', {
        destination: { kind: 'global' },
      }),
    ).toMatchObject({ ok: false, needs: 'destination' });
    expect(
      (
        await automations.moveScheduleToCloud('s-1', {
          destination: { kind: 'new_worktree', workspaceId: OTHER_PROJECT },
        })
      ).ok,
    ).toBe(true);
    expect([...records.values()][0]?.destination).toEqual({
      kind: 'new_worktree',
      workspaceId: OTHER_PROJECT,
    });
  });

  it('holds a move until steps the cloud cannot run have cloud models, and moves back as it was', async () => {
    await seed([schedule('s-1')]);
    const { automations, records, cloud, failures } = await service();
    cloud.modelItems = [
      {
        itemKey: 'review#0',
        reason: 'local_harness',
        parityId: 'R2',
        message: 'Cursor models only run on this computer.',
        jobId: 'review',
        stepIndex: 0,
        uses: 'builtin/agent-prompt',
        model: 'cursor/auto',
        alternatives: [
          {
            modelId: 'anthropic/claude-sonnet-5.5',
            label: 'Sonnet 5.5',
            harness: 'claude',
          },
        ],
      },
    ];
    const asked = await automations.moveScheduleToCloud('s-1');
    expect(asked).toMatchObject({
      ok: false,
      needs: 'models',
      preflight: { items: [{ itemKey: 'review#0' }] },
    });
    // Paused here and held off there: nothing fires meanwhile.
    expect(await liveRecords('s-1', records)).toBe(0);
    expect((await stored())[0].cloudSchedule?.enabling).toBe(true);

    // Moving back undoes it: on here, nothing in the cloud.
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(true);
    expect((await stored())[0]).toMatchObject({ enabled: true });
    expect(records.size).toBe(0);

    // With the replacements chosen, the move finishes.
    expect(await automations.moveScheduleToCloud('s-1')).toMatchObject({
      needs: 'models',
    });
    const choices = [
      { itemKey: 'review#0', modelId: 'anthropic/claude-sonnet-5.5' },
    ];
    // Choices made for another version of the workflow ask again.
    expect(
      await automations.moveScheduleToCloud('s-1', {
        models: {
          definitionHash: 'f'.repeat(64),
          policyFingerprint: 'b'.repeat(64),
          choices,
        },
      }),
    ).toMatchObject({ ok: false, needs: 'models' });
    expect(await liveRecords('s-1', records)).toBe(0);
    // The workflow changed as the choices were saved: asked again, held.
    failures.save = 'stale';
    expect(
      await automations.moveScheduleToCloud('s-1', {
        models: {
          definitionHash: 'a'.repeat(64),
          policyFingerprint: 'b'.repeat(64),
          choices,
        },
      }),
    ).toMatchObject({ ok: false, needs: 'models' });
    expect((await stored())[0].cloudSchedule?.enabling).toBe(true);
    const finished = await automations.moveScheduleToCloud('s-1', {
      models: {
        definitionHash: 'a'.repeat(64),
        policyFingerprint: 'b'.repeat(64),
        choices,
      },
    });
    expect(finished.ok).toBe(true);
    expect((await stored())[0].cloudSchedule?.enabling).toBeUndefined();
    expect(await liveRecords('s-1', records)).toBe(1);
  });

  it('keeps the base task of a new worktree schedule it asks about', async () => {
    await seed([
      schedule('s-1', {
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'new_worktree' },
          workspaceId: 'local-project',
          baseWorktreeId: 'local-base',
          pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
          pipelineSource: 'shared',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
        },
      }),
    ]);
    const { automations, records, cloud, places } = await service();
    // The base task's branch isn't in the cloud.
    places.local.set('local-project', {
      kind: 'git',
      repository: 'acme/app',
      branch: 'local-only',
    });
    cloud.places = [
      {
        workspaceId: CLOUD_PROJECT,
        name: 'App',
        kind: 'git',
        ownerOrganizationId: null,
        repository: 'acme/app',
        tasks: [{ worktreeId: CLOUD_TASK, name: 'Main', branch: 'main' }],
      },
    ];
    expect(await automations.moveScheduleToCloud('s-1')).toMatchObject({
      needs: 'destination',
      candidates: [
        {
          destination: {
            kind: 'new_worktree',
            workspaceId: CLOUD_PROJECT,
            baseWorktreeId: CLOUD_TASK,
          },
          label: 'App · Main',
        },
      ],
    });
    // Dropping the base would base each run on the default branch.
    expect(
      await automations.moveScheduleToCloud('s-1', {
        destination: { kind: 'new_worktree', workspaceId: CLOUD_PROJECT },
      }),
    ).toMatchObject({ ok: false, needs: 'destination' });
    expect(
      (
        await automations.moveScheduleToCloud('s-1', {
          destination: {
            kind: 'new_worktree',
            workspaceId: CLOUD_PROJECT,
            baseWorktreeId: CLOUD_TASK,
          },
        })
      ).ok,
    ).toBe(true);
    expect([...records.values()][0]?.destination).toMatchObject({
      baseWorktreeId: CLOUD_TASK,
    });
  });

  it('moves a reviewed shared workflow as that version, and refuses one changed since', async () => {
    const pinned = schedule('s-1', {
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: REMOTE_ID,
          installPin: {
            pipelineContentHash: 'c'.repeat(64),
            distributionMode: 'definition_only',
          },
        },
      },
    });
    await seed([pinned, { ...pinned, id: 's-2' }]);
    const { automations, records, places } = await service();
    places.shared.changed = true;
    expect(await automations.moveScheduleToCloud('s-1')).toMatchObject({
      ok: false,
    });
    expect(records.size).toBe(0);
    places.shared.changed = false;
    expect((await automations.moveScheduleToCloud('s-2')).ok).toBe(true);
    // The cloud runs the reviewed version, not whatever is shared later.
    expect([...records.values()][0]?.workflow).toMatchObject({
      kind: 'snapshot',
    });
  });
});
