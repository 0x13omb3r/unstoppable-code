import {
  classifyDaemonPipeline,
  resolveDaemonPipelineInputs,
  type DaemonPipelineClassifierContext,
  type DaemonPipelineClassifierOptions,
} from '../daemon-eligibility';
import type { ChildPipelineAdmissionRequest } from '../executor/types';
import {
  declaresOwnCapabilities,
  type ChildCapabilities,
  type ChildCapabilityStore,
} from './child-capabilities';
import { codexServablePluginCollections } from './codex-plugin-mcp';

/*
 * Same-target child workflows on a cloud runner's pipeline host (CAN-6868).
 *
 * The host classified its launch without the child: a `run-pipeline` step
 * names it, and its definition is read only when the step runs (from the
 * run's checkout, its own folder, the step's YAML or the bundled workflows).
 * So the child is checked here, as it starts and each time it resumes, by
 * the rules its parent was checked by, with two differences:
 *
 * - A model written as an expression is admitted (`expressionModels:
 *   'owner'`): no preflight lists a child's models, so the web core's
 *   admission of each model when its step asks for a route is the gate for
 *   all of them, and an expression model passes it the same way. The web
 *   core answers a child's model routes and Ledger attempts under the
 *   child's own id once it recorded the child (part 2b), and the supervisor
 *   relays a child's host requests as its run's.
 * - A child that declares its own `model_aliases` or `plugin_collections`
 *   has them resolved by the run's core first (follow-up 3,
 *   `child-capabilities.ts`) and is classified with those, kept for it
 *   alone: the launch's are its parent's, keyed by id. Without a core to
 *   ask, such a child is refused.
 *
 * A refusal fails the `run-pipeline` step before the child runs, with a
 * message that names the child and the step it refused, never its contents.
 */

/** The message a step gets when its child can't run in this host. */
export function CHILD_REFUSED_MESSAGE(pipelineId: string): string {
  return `Child workflow "${pipelineId}" can't run in this cloud run.`;
}

export interface ChildAdmissionSetup {
  readonly runtime: DaemonPipelineClassifierContext['runtime'];
  /** The launch's repository, where a child without its own resolves actions. */
  readonly repoPath: string;
  readonly env: Readonly<Record<string, string>>;
  /** The options the launch was classified with. */
  readonly options: DaemonPipelineClassifierOptions;
  /** The launch took its model CLIs, catalog and resources. */
  readonly modelsReady: boolean;
  /** The launch has a Codex environment and an MCP launcher. */
  readonly codexReady: boolean;
  /** Where a child's own collections and aliases are resolved; none refuses them. */
  readonly capabilities?: ChildCapabilityStore;
}

/** The check a launch that admitted children runs on each of them. */
export function childAdmissionFor(
  setup: ChildAdmissionSetup,
): (request: ChildPipelineAdmissionRequest) => Promise<void> {
  return async (request) => {
    const refuse = (detail: string): never => {
      throw new Error(`${CHILD_REFUSED_MESSAGE(request.pipelineId)} ${detail}`);
    };
    const { pipeline } = request;
    let own: ChildCapabilities | undefined;
    if (declaresOwnCapabilities(pipeline)) {
      if (setup.capabilities === undefined)
        refuse(
          'Cloud runs only use plugin collections and model aliases the parent workflow declares.',
        );
      else
        try {
          own = await setup.capabilities.resolve(request);
        } catch (error) {
          // A withdrawn step's abort is its own, not the child's refusal.
          if (request.signal?.aborted === true) throw error;
          refuse(error instanceof Error ? error.message : String(error));
        }
    }
    const classification = classifyDaemonPipeline(
      pipeline,
      {
        runtime: setup.runtime,
        repoPath: request.repoPath ?? setup.repoPath,
        inputs:
          request.kind === 'start'
            ? resolveDaemonPipelineInputs(request.pipeline, request.inputs)
            : request.inputs,
        env: setup.env,
        // The child's own, as its core resolved them, never its parent's.
        ...(own !== undefined && {
          modelAliases: own.modelAliases,
          pluginCollections: new Set(Object.keys(own.pluginCollections)),
          codexPluginCollections: codexServablePluginCollections(
            own.pluginCollections,
          ),
        }),
      },
      { ...setup.options, expressionModels: 'owner' },
    );
    if (!classification.eligible)
      return refuse(
        `Step ${String(classification.stepIndex + 1)} of job "${classification.jobId}" is refused (${classification.reason}).`,
      );
    if (classification.modelSteps > 0 && !setup.modelsReady)
      refuse("This run's host has no models to run the child's agent steps.");
    if (classification.modelHarnesses.includes('codex') && !setup.codexReady)
      refuse("This run's host can't run the child's Codex steps.");
  };
}
