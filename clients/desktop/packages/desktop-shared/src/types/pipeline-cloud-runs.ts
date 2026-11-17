import type {
  CloudModelChoice,
  CloudModelPreflightResult,
} from '@canopy/protocol/canopy-core';

/**
 * Where a manual run executes (CAN-6187, decision P6), on `pipelines:execute`
 * and `portal.pipeline.run`. It is its own field, apart from the run's
 * destination (no project, a task or a project) and from a run chat.
 */
export interface PipelineRunLocationRequest {
  /**
   * The execution target. Absent runs on this computer;
   * `CLOUD_PIPELINE_RUN_TARGET_ID` starts the run in the cloud through the
   * web core. Main refuses any other value rather than run it here.
   */
  targetId?: string;
  /**
   * The cloud models the user confirmed for the model preflight they were
   * shown, with its definition hash and policy fingerprint.
   */
  cloudModelChoices?: {
    definitionHash: string;
    policyFingerprint: string;
    choices: CloudModelChoice[];
  };
  /**
   * The cloud start's idempotency key, kept by the Run dialog for one launch
   * and sent again after an uncertain outcome, so a retry never records a
   * second run. Main makes one when it is absent.
   */
  cloudIdempotencyKey?: string;
  /**
   * A local worktree's run in the cloud (CAN-6869): the repository, branch
   * and head the person saw the Run dialog's warning for, about its unpushed
   * commits or uncommitted changes, and confirmed. Main pushes only with it,
   * and only while the worktree still has all three.
   */
  cloudCheckoutConfirmed?: CloudPipelineRunCheckoutConfirmation;
  /**
   * A multi-repository task's repository its cloud run goes with (CAN-6869),
   * as the Run dialog's repository choice names it.
   */
  cloudRepoId?: string;
}

/**
 * What a local worktree's cloud run warns about first (CAN-6869): the cloud
 * runs only what the branch has on GitHub.
 */
export interface CloudPipelineRunCheckoutState {
  /** The GitHub repository a push goes to, `owner/name`. */
  repository: string;
  branch: string;
  /** The head the warning is for; a confirmation names it back. */
  headSha: string;
  /** False while the branch has never been pushed. */
  published: boolean;
  /** Commits GitHub doesn't have yet, as this computer last fetched it. */
  unpushedCommits: number;
  uncommittedChanges: boolean;
}

/**
 * What the person confirmed a local worktree's push for (CAN-6869): the
 * warning's repository, branch and head, sent back as they were shown.
 */
export interface CloudPipelineRunCheckoutConfirmation {
  repository: string;
  branch: string;
  headSha: string;
}

/** Why main didn't start a cloud run, besides unconfirmed models. */
export type CloudPipelineRunRefusalCode =
  /** Not signed in, the web core is unreachable, or cloud runs are off. */
  | 'cloud_unavailable'
  /** A `targetId` this computer can't place runs on. */
  | 'cloud_target_unavailable'
  /** A destination a cloud run can't use: a task that isn't a Git worktree on GitHub, say. */
  | 'cloud_destination_unavailable'
  /**
   * The task's cloud worktree is still being set up (CAN-6869): nothing was
   * recorded; the same start goes on once it is ready.
   */
  | 'cloud_worktree_preparing'
  /** Only shared and curated workflows run in the cloud, for now. */
  | 'cloud_source_unavailable'
  /** The run needs an owner: Personal or an organization. */
  | 'cloud_owner_required'
  /** The cloud refused steps of the workflow, or the start itself. */
  | 'cloud_run_refused'
  /**
   * The start may have been recorded (a lost answer, a deadline, an internal
   * error); retrying with the same idempotency key never starts it twice.
   */
  | 'cloud_start_uncertain';

/** The cloud run a start recorded in the web core. */
export interface CloudPipelineRunStarted {
  /** The web core's `core.pipeline.run` operation. */
  operationId: string;
  /** `waiting` while the owner's admitted runs are at their cap. */
  admission: 'waiting' | 'admitted' | 'released';
  statusReason: string | null;
  replayed: boolean;
}

/** What `pipelines:execute` answers for a run with a cloud `targetId`. */
export type CloudPipelineRunStartResult =
  | { success: true; cloudRun: CloudPipelineRunStarted }
  | {
      success: false;
      error: string;
      /** Model steps need a cloud model the user confirms first. */
      errorCode: 'cloud_models_unconfirmed';
      cloudModels: CloudModelPreflightResult;
    }
  | {
      success: false;
      error: string;
      /**
       * The task has unpushed commits or uncommitted changes (CAN-6869): the
       * Run dialog warns, and a confirmed start pushes, then runs.
       */
      errorCode: 'cloud_checkout_unconfirmed';
      checkout: CloudPipelineRunCheckoutState;
    }
  | { success: false; error: string; errorCode: CloudPipelineRunRefusalCode };

/**
 * `pipelines:cloud-runs-availability`: this computer's web core manifest
 * through `pipelineCloudRunsFromManifest`, the CAN-6085 capability axis.
 */
export interface PipelineCloudRunsAvailability {
  pipelineCloudRuns: boolean;
}
