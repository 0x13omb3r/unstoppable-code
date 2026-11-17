import type { Job, Step } from './document';

/*
 * A job's isolation (CAN-6892, plan CP-65). A job that only reads its
 * workspace (review tracks, analysis, test shards) may say so with
 * `isolation: read_only`. A cloud runner then runs each of its variants in a
 * sandbox of its own, cut from the run's commit, and takes back only its
 * outputs, reports and files; the parent's scheduling (`max_parallel`,
 * `fail_fast`, output merging) is unchanged. Desktop and every other host run
 * the job where they run any job: the field changes nothing there.
 *
 * Every host refuses the field's invalid uses when it normalizes the
 * definition, so a workflow means the same thing wherever it runs.
 */

/** The values `isolation` takes; `shared`, the default, is every job's today. */
export const PIPELINE_JOB_ISOLATIONS = ['shared', 'read_only'] as const;
export type PipelineJobIsolation = (typeof PIPELINE_JOB_ISOLATIONS)[number];

/**
 * Bundled actions a read-only job may not use, and why. Each writes its
 * workspace or the run's shared state, publishes the workspace, needs the
 * run's own host (host steps relay to the run's owner, which answers only
 * for the run's own sandbox), or pauses for a person, which a variant in
 * another sandbox can't do.
 */
const REFUSED_BUILTIN_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['run-pipeline', 'starts a child workflow'],
  ['request-input', 'pauses for input'],
  ['git-commit-push', 'commits and pushes the workspace'],
  ['github-create-pr', 'pushes the workspace and opens a pull request'],
  // The run's memory lives in the run's own sandbox: a variant elsewhere
  // would read or write another.
  ['memory', "reads and writes the run's memory"],
  ['memory-read', "reads the run's memory"],
  ['memory-write', "writes the run's memory"],
  ['coder', 'edits the workspace'],
  ['qa-fixer', 'edits the workspace'],
  ['create-worktree', 'is a host step'],
  ['create-project-entry', 'is a host step'],
  ['create-bot-entry', 'is a host step'],
  ['move-to-group', 'is a host step'],
  ['send-agent-message', 'is a host step'],
  ['wait-for-agent-reply', 'is a host step'],
]);

/** Agent permission presets that can't write the workspace. */
const READ_ONLY_PERMISSION_PRESETS: ReadonlySet<string> = new Set([
  'none',
  'read_only',
  'plan',
]);

/** Why a read-only job's step can't run isolated, or null when it can. */
function readOnlyStepProblem(step: Step): string | null {
  const uses = step.uses?.trim();
  if (uses?.startsWith('builtin/')) {
    const refused = REFUSED_BUILTIN_ACTIONS.get(uses.slice('builtin/'.length));
    if (refused !== undefined) return `uses ${uses}, which ${refused}`;
  }
  const preset = step.with?.permission_preset;
  if (preset === undefined) return null;
  if (typeof preset !== 'string' || !READ_ONLY_PERMISSION_PRESETS.has(preset))
    return `sets permission_preset "${String(preset)}"; a read-only job's agents use none, read_only or plan`;
  return null;
}

/**
 * The job's isolation, defaulting to `shared`. Throws when the value is not
 * one of PIPELINE_JOB_ISOLATIONS, or when a read-only job has a step that
 * would write its workspace or needs the run's own host.
 */
export function normalizePipelineJobIsolation(
  jobKey: string,
  job: Job,
  stepIds: readonly string[],
): PipelineJobIsolation {
  const value: unknown = job.isolation;
  if (value === undefined || value === null || value === 'shared')
    return 'shared';
  if (value !== 'read_only') {
    throw new Error(
      `Job "${jobKey}" has invalid isolation ${JSON.stringify(value)}: use shared or read_only`,
    );
  }
  const problems = job.steps.flatMap((step, index) => {
    const problem = readOnlyStepProblem(step);
    return problem === null
      ? []
      : [`step "${stepIds[index] ?? String(index)}" ${problem}`];
  });
  if (problems.length > 0) {
    throw new Error(
      `Job "${jobKey}" is isolation: read_only, but ${problems.join('; ')}`,
    );
  }
  return 'read_only';
}
