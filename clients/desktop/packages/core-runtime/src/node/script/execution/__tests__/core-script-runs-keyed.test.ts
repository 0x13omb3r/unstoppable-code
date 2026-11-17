import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
  WorkerScriptExecuteParamsSchema,
  type WorkerScriptExecuteParams,
  type WorkerScriptExecuteResult,
} from '@canopy/protocol/canopy-core';

import type { LocalWorkerTransport } from '../../../../runtime/local-worker-transport';
import { LocalWorkerExecution, OperationService } from '../../../operations';
import { OperationLedger } from '../../../operations/ledger';
import { CoreScriptRuns, type CoreScriptRunRequest } from '..';
import { SCOPE, scriptParams } from './script-worker-fixtures';

const EXECUTION_ID = 'agent-run-1';

interface Sent {
  readonly params: WorkerScriptExecuteParams;
  release(): void;
}

let root: string;
let operations: OperationService;
let runs: CoreScriptRuns;
let sent: Sent[];
let observing: jest.Mock;
let stopObserving: jest.Mock;

/** A worker that holds each script it is sent until the test releases it. */
function heldWorker(): LocalWorkerTransport {
  return {
    instructions: WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
    instruction: (_name, params) =>
      new Promise((resolve) => {
        const held = WorkerScriptExecuteParamsSchema.parse(params);
        sent.push({
          params: held,
          release: (): void =>
            resolve({
              executionId: held.executionId,
              status: 'success',
              exitCode: 0,
              timedOut: false,
              durationMs: 5,
              outputBytes: 0,
              outputTruncated: false,
              recorded: true,
            } satisfies WorkerScriptExecuteResult),
        });
      }),
    receipt: () => Promise.resolve(null),
    releaseReceipt: (): void => undefined,
  };
}

function keyedRun(scriptKey: string): CoreScriptRunRequest {
  return {
    params: scriptParams('true', {
      executionId: EXECUTION_ID,
      record: {
        script: {
          scriptKey,
          scriptName: scriptKey,
          label: scriptKey,
          command: 'true',
          lifecycle: 'custom',
          target: 'project',
        },
        invocation: 'manual-run',
      },
    }),
    origin: { kind: 'client', sourceId: 'test' },
    owner: { kind: 'system', id: 'test' },
    keyed: true,
  };
}

function target(
  scriptKey: string,
  executionId = EXECUTION_ID,
): {
  workspaceId: string;
  worktreeId: string;
  executionId: string;
  scriptKey: string;
} {
  return {
    workspaceId: SCOPE.workspaceId,
    worktreeId: SCOPE.worktreeId,
    executionId,
    scriptKey,
  };
}

async function dispatched(count: number): Promise<void> {
  while (sent.length < count)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-script-runs-keyed-'));
  sent = [];
  stopObserving = jest.fn();
  observing = jest.fn(() => stopObserving);
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(root, 'operations.sqlite')),
  });
  runs = new CoreScriptRuns({
    operations,
    localWorker: new LocalWorkerExecution({
      operations,
      transport: heldWorker(),
    }),
    observe: observing,
  });
});

afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('keyed core script runs (CAN-5830)', () => {
  it('refuses a repeat of a run in dispatch, for its script or another, keeps that run, and answers a lookup from it', async () => {
    const first = runs.run(keyedRun('build'));
    await dispatched(1);

    await expect(runs.run(keyedRun('build'))).resolves.toMatchObject({
      status: 'failed',
      executionId: EXECUTION_ID,
      operationId: null,
      error: { kind: 'already_exists' },
    });
    await expect(runs.run(keyedRun('lint'))).resolves.toMatchObject({
      status: 'failed',
      executionId: EXECUTION_ID,
      operationId: null,
      error: { kind: 'conflict' },
    });
    expect(sent).toHaveLength(1);

    await expect(runs.find(target('build'))).resolves.toEqual({
      status: 'in_flight',
    });
    await expect(runs.find(target('lint'))).resolves.toEqual({
      status: 'conflict',
    });
    await expect(
      runs.find({ ...target('build'), worktreeId: 'other-worktree' }),
    ).resolves.toEqual({ status: 'conflict' });

    sent[0]?.release();
    const settled = await first;
    expect(settled).toMatchObject({
      status: 'completed',
      executionId: EXECUTION_ID,
      result: { status: 'success', exitCode: 0 },
    });

    await expect(runs.find(target('build'))).resolves.toMatchObject({
      status: 'completed',
      result: { status: 'success', exitCode: 0 },
    });
    await expect(runs.find(target('lint'))).resolves.toEqual({
      status: 'conflict',
    });
    await expect(runs.find(target('build', 'unknown'))).resolves.toBeNull();
  });

  it('refuses a settled key through the ledger, for its script or another, and dispatches nothing', async () => {
    const first = runs.run(keyedRun('build'));
    await dispatched(1);
    sent[0]?.release();
    const settled = await first;
    expect(settled.status).toBe('completed');

    const again = await runs.run(keyedRun('build'), { observer: {} });
    expect(again).toMatchObject({
      status: 'failed',
      executionId: EXECUTION_ID,
      operationId: settled.operationId,
      error: { kind: 'already_exists' },
    });
    const reused = await runs.run(keyedRun('lint'), { observer: {} });
    expect(reused).toMatchObject({
      status: 'failed',
      executionId: EXECUTION_ID,
      operationId: null,
      error: { kind: 'conflict' },
    });

    expect(sent).toHaveLength(1);
    expect(observing).toHaveBeenCalledTimes(2);
    expect(stopObserving).toHaveBeenCalledTimes(2);
  });
});
