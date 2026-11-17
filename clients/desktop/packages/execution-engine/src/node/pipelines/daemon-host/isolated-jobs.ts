import { createHash, randomUUID } from 'node:crypto';
import type { PipelineOwnerSettlement } from '@canopy/core-runtime/node/pipeline';
import type {
  WorkerPipelineHostRequest,
  WorkerPipelineOwnerRequest,
  WorkerPipelineOwnerResult,
} from '@canopy/protocol/canopy-core';
import {
  WORKER_PIPELINE_ISOLATED_JOB_CHUNK_MAX_BYTES,
  WORKER_PIPELINE_ISOLATED_JOB_PAYLOAD_MAX_BYTES,
  WorkerPipelineHostActionRequestSchema,
} from '@canopy/protocol/canopy-core';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import type {
  PipelineIsolatedJobOutcome,
  PipelineIsolatedJobPort,
  PipelineIsolatedJobRequest,
  PipelineIsolatedJobVariantSource,
} from '../executor/isolated-jobs';
import {
  PIPELINE_OWNER_DEADLINE_MS,
  type PipelineOwnerClient,
  type PipelineOwnerStep,
} from './owner-client';

/*
 * Read-only job variants in sandboxes of their own (CAN-6892 part 2), over
 * the run's owner: a cloud runner's web core.
 *
 * - The parent (`isolatedJobs: 'owner'`) writes a variant's request in
 *   chunks (`owner.isolatedJob.write`), asks its owner to run it
 *   (`owner.isolatedJob.run`), which starts a `job` child run as the parent
 *   started (its recorded workflow, inputs and event) in a sandbox cut from
 *   the request's commit and settles once the child ended, and reads the
 *   variant's outcome back (`owner.isolatedJob.read`).
 * - The variant's own host (`isolatedJobs: 'variant'`) is checked as its
 *   parent's was, runs only `isolatedVariantJob`, reads the request its
 *   owner holds for it, runs it, and writes its outcome.
 *
 * Both are JSON documents checked against their SHA-256 when read. The
 * files they carry go through the owner's run storage, never a step's
 * outputs. An owner that can't place a variant answers `unavailable`, and
 * the parent runs it in its own sandbox; so does an owner that doesn't
 * answer these requests yet.
 */

type Kind = WorkerPipelineOwnerResult['kind'];
type ResultOf<K extends Kind> = Extract<WorkerPipelineOwnerResult, { kind: K }>;

/** An owner that answers none of these yet: the variant runs in place. */
class OwnerCannotPlace extends Error {}

function expectKind<K extends Kind>(
  settlement: PipelineOwnerSettlement,
  kind: K,
): ResultOf<K> {
  const { result } = settlement;
  if (result.status === 'failure') {
    if (result.failureReason === 'unsupported_action')
      throw new OwnerCannotPlace(result.message);
    throw new Error(result.message);
  }
  if (result.status !== 'owner') throw new Error(UNANSWERED);
  const value: WorkerPipelineOwnerResult = result.value;
  if (!isKind(value, kind)) throw new Error(UNANSWERED);
  return value;
}

function isKind<K extends Kind>(
  value: WorkerPipelineOwnerResult,
  kind: K,
): value is ResultOf<K> {
  return value.kind === kind;
}

const UNANSWERED = "The run's owner gave an answer this host can't read.";

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Endpoint {
  readonly client: PipelineOwnerClient;
  readonly step: PipelineOwnerStep;
}

type Side = 'request' | 'outcome';

/** Writes one document in order, in chunks the relay carries. */
async function writeDocument(
  endpoint: Endpoint,
  side: Side,
  variantId: string | undefined,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<{ readonly sha256: string; readonly byteSize: number }> {
  const payload = { sha256: sha256Hex(bytes), byteSize: bytes.byteLength };
  let offset = 0;
  // A document is never empty, so at least one chunk is written.
  do {
    const end = Math.min(
      offset + WORKER_PIPELINE_ISOLATED_JOB_CHUNK_MAX_BYTES,
      bytes.byteLength,
    );
    const body: WorkerPipelineOwnerRequest = {
      action: 'owner.isolatedJob.write',
      side,
      ...(variantId === undefined ? {} : { variantId }),
      payload,
      offset,
      chunk: Buffer.from(bytes.subarray(offset, end)).toString('base64'),
    };
    const written = expectKind(
      await endpoint.client.request(body, endpoint.step, signal),
      'isolatedJob.write',
    );
    if (written.received !== end)
      throw new Error(
        "The run's owner kept another part of the read-only job's files.",
      );
    offset = end;
    if (written.complete !== (end === bytes.byteLength))
      throw new Error(
        "The run's owner didn't keep all of the read-only job's files.",
      );
  } while (offset < bytes.byteLength);
  return payload;
}

/** Reads one document whole, and checks it against its digest. */
async function readDocument(
  endpoint: Endpoint,
  side: Side,
  variantId: string | undefined,
  expected: { readonly sha256: string; readonly byteSize: number } | null,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  let payload = expected;
  for (;;) {
    const body: WorkerPipelineOwnerRequest = {
      action: 'owner.isolatedJob.read',
      side,
      ...(variantId === undefined ? {} : { variantId }),
      offset: received,
    };
    const page = expectKind(
      await endpoint.client.request(body, endpoint.step, signal),
      'isolatedJob.read',
    );
    payload ??= page.payload;
    if (
      page.payload.sha256 !== payload.sha256 ||
      page.payload.byteSize !== payload.byteSize ||
      page.offset !== received
    )
      throw new Error(
        "The run's owner answered another part of the read-only job's files.",
      );
    const chunk = Buffer.from(page.chunk, 'base64');
    chunks.push(chunk);
    received += chunk.byteLength;
    if (received > payload.byteSize)
      throw new Error("The read-only job's files are over their size.");
    if (page.complete) break;
    if (chunk.byteLength === 0)
      throw new Error("The run's owner sent an empty part of the job's files.");
  }
  const bytes = Buffer.concat(chunks, received);
  if (
    bytes.byteLength !== payload.byteSize ||
    sha256Hex(bytes) !== payload.sha256
  )
    throw new Error("The read-only job's files don't match their digest.");
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === 'string' &&
        typeof file.contentBase64 === 'string' &&
        (file.executable === undefined || file.executable === true),
    )
  );
}

type CompletedOutcome = Extract<
  PipelineIsolatedJobOutcome,
  { kind: 'completed' }
>;

/**
 * A variant's outcome, as far as the parent reads it; its paths are checked
 * again as each file is written (`runIsolatedJob`).
 */
function isCompletedOutcome(value: unknown): value is CompletedOutcome {
  return (
    isRecord(value) &&
    value.kind === 'completed' &&
    isRecord(value.job) &&
    typeof value.job.status === 'string' &&
    isRecord(value.job.steps) &&
    isRecord(value.job.outputs) &&
    isFileList(value.files)
  );
}

/** A variant's request, as far as its host reads it. */
function isVariantRequest(value: unknown): value is PipelineIsolatedJobRequest {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.executionId === 'string' &&
    typeof value.jobId === 'string' &&
    typeof value.logicalJobId === 'string' &&
    typeof value.commit === 'string' &&
    isRecord(value.job) &&
    Array.isArray(value.job.steps) &&
    typeof value.cwd === 'string' &&
    isRecord(value.needs) &&
    isRecord(value.inputs) &&
    isRecord(value.env) &&
    isFileList(value.files)
  );
}

function parseOutcome(bytes: Buffer): CompletedOutcome {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (isCompletedOutcome(value)) return value;
  throw new Error(
    "The read-only job's sandbox sent an outcome this run can't read.",
  );
}

function parseRequest(bytes: Buffer): PipelineIsolatedJobRequest {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (isVariantRequest(value)) return value;
  throw new Error("The read-only job's request can't be read.");
}

/**
 * What a variant's own run leaves out of its job: what schedules it, and
 * the job controls and values its parent resolves from its needs and
 * matrix, which the variant's run doesn't have. The variant runs from the
 * request, which keeps them.
 */
const SCHEDULING_KEYS: ReadonlySet<string> = new Set([
  'needs',
  'strategy',
  'if',
  'isolation',
  'continue_on_error',
  'max_iterations',
  'max_retries',
  'env',
  'outputs',
]);

/**
 * What a variant's own run executes (`isolatedJobs: 'variant'`): its
 * parent's workflow, which its start was checked as, with every job and
 * step still there, so what the workflow names of them (a dependency's
 * steps) still resolves. The variant's job runs, less what schedules it;
 * every other job keeps only its steps and never runs (`if: false`). Its
 * triggers and inputs stay the parent's. Null when the workflow has no such
 * job.
 */
export function isolatedJobVariantPipeline(
  pipeline: Pipeline,
  logicalJobId: string,
): Pipeline | null {
  const entries: [string, unknown][] = Object.entries(pipeline.jobs);
  const variant = entries.find(([key]) => key === logicalJobId)?.[1];
  if (!isRecord(variant)) return null;
  const jobs = Object.fromEntries(
    entries.map(([key, job]): [string, unknown] => {
      if (key === logicalJobId)
        return [
          key,
          Object.fromEntries(
            Object.entries(variant).filter(
              ([field]) => !SCHEDULING_KEYS.has(field),
            ),
          ),
        ];
      const steps = isRecord(job) ? job.steps : undefined;
      return [key, { if: 'false', steps: Array.isArray(steps) ? steps : [] }];
    }),
  );
  try {
    return parsePipelineText(JSON.stringify({ ...pipeline, jobs }));
  } catch {
    return null;
  }
}

/** The step every request of a variant is raised for: the run's own. */
function runStep(
  executionId: string,
  owner: WorkerPipelineHostRequest['owner'],
  jobId: string,
  deadlineMs: number,
): PipelineOwnerStep {
  return {
    executionId,
    childExecutionId: null,
    jobId,
    stepId: '_run',
    attempt: 0,
    iteration: 0,
    owner,
    deadlineMs,
  };
}

/**
 * The parent's port (`isolatedJobs: 'owner'`): each variant of the run's own
 * read-only jobs runs as a child run its owner places. A child workflow's
 * variants, and a request over the owner's limits, run in the run's own
 * sandbox.
 */
export function createDaemonIsolatedJobPort(
  client: PipelineOwnerClient,
  run: {
    readonly executionId: string;
    readonly owner: WorkerPipelineHostRequest['owner'];
  },
): PipelineIsolatedJobPort {
  return {
    async run(request, signal) {
      if (request.executionId !== run.executionId)
        return {
          kind: 'unavailable',
          reason: "A child workflow's read-only jobs run in its run's sandbox.",
        };
      const bytes = Buffer.from(JSON.stringify(request), 'utf8');
      if (bytes.byteLength > WORKER_PIPELINE_ISOLATED_JOB_PAYLOAD_MAX_BYTES)
        return {
          kind: 'unavailable',
          reason: "The read-only job's files are over what a sandbox takes.",
        };
      const variantId = randomUUID();
      const payload = {
        sha256: sha256Hex(bytes),
        byteSize: bytes.byteLength,
      };
      const runBody: WorkerPipelineOwnerRequest = {
        action: 'owner.isolatedJob.run',
        variantId,
        commit: request.commit,
        request: payload,
        logicalJobId: request.logicalJobId,
      };
      // A run the owner request can't carry (a commit it can't name) runs
      // here, before anything is written.
      if (!WorkerPipelineHostActionRequestSchema.safeParse(runBody).success)
        return {
          kind: 'unavailable',
          reason: "The read-only job's request is over what its owner takes.",
        };
      const endpoint = (deadlineMs: number): Endpoint => ({
        client,
        step: runStep(run.executionId, run.owner, request.jobId, deadlineMs),
      });
      const short = endpoint(PIPELINE_OWNER_DEADLINE_MS.short);
      try {
        await writeDocument(short, 'request', variantId, bytes, signal);
        // Settles once the child ended; a withdrawal (a cancel, fail_fast,
        // a checkpoint) cancels the child.
        const ran = expectKind(
          await client.request(
            runBody,
            endpoint(PIPELINE_OWNER_DEADLINE_MS.long).step,
            signal,
          ),
          'isolatedJob.run',
        );
        if (ran.outcome.kind === 'unavailable')
          return { kind: 'unavailable', reason: ran.outcome.reason };
        return parseOutcome(
          await readDocument(
            short,
            'outcome',
            variantId,
            ran.outcome.payload,
            signal,
          ),
        );
      } catch (error) {
        if (error instanceof OwnerCannotPlace)
          return { kind: 'unavailable', reason: error.message };
        throw error;
      }
    },
  };
}

/**
 * A variant's own host (`isolatedJobs: 'variant'`): the request its owner
 * holds for this run, and where its outcome goes.
 */
export function createDaemonIsolatedJobVariantSource(
  client: PipelineOwnerClient,
  run: {
    readonly executionId: string;
    readonly owner: WorkerPipelineHostRequest['owner'];
  },
): PipelineIsolatedJobVariantSource {
  const endpoint = (jobId: string): Endpoint => ({
    client,
    step: runStep(
      run.executionId,
      run.owner,
      jobId,
      PIPELINE_OWNER_DEADLINE_MS.short,
    ),
  });
  return {
    async request(jobId, signal) {
      return parseRequest(
        await readDocument(endpoint(jobId), 'request', undefined, null, signal),
      );
    },
    async report(jobId, outcome, signal) {
      const bytes = Buffer.from(JSON.stringify(outcome), 'utf8');
      if (bytes.byteLength > WORKER_PIPELINE_ISOLATED_JOB_PAYLOAD_MAX_BYTES)
        throw new Error(
          "The read-only job's results are over what its run takes back.",
        );
      await writeDocument(endpoint(jobId), 'outcome', undefined, bytes, signal);
    },
  };
}
