/**
 * Where a moved workflow schedule runs in the cloud (CAN-6917, cloud
 * pipelines CP-47).
 *
 * A `global` schedule moves as it is. A `project`, `task` or `new_worktree`
 * schedule names a project and task on this computer, which mean nothing to
 * the cloud, so the move re-points it at the matching cloud project or task
 * of the schedule's owner:
 *
 * - a project matches a cloud project of the same owner whose repository is
 *   the GitHub repository the schedule runs in (its `repoId`'s, or the
 *   project root's);
 * - a task, and a new worktree's base task, match a cloud worktree of that
 *   project on the same branch.
 *
 * One match moves without asking. None, or several, asks the person to pick
 * from the owner's cloud places (or, with none at all, refuses). A pick is
 * checked against the same listing, so a move never names a project of
 * another owner. Pure: main supplies both listings.
 */
import type { PipelineScheduleDestination } from '@canopy/protocol/canopy-core';
import type {
  AutomationAction,
  AutomationCloudDestinationCandidate,
  AutomationCloudScheduleLocalDestination,
} from '@canopy/desktop-shared/types';

type PipelineAction = Extract<AutomationAction, { type: 'worktree_pipeline' }>;

/** A cloud worktree, as `core.worktree.list` answers it. */
export interface CloudScheduleTask {
  readonly worktreeId: string;
  readonly name: string;
  readonly branch: string;
}

/** A cloud project of the signed-in person, as `core.workspace.list` answers it. */
export interface CloudSchedulePlace {
  readonly workspaceId: string;
  readonly name: string;
  readonly kind: 'git' | 'cowork';
  /** Null for a personal project. */
  readonly ownerOrganizationId: string | null;
  /** The root repository's `owner/name` on GitHub; null for none. */
  readonly repository: string | null;
  /** Its ready worktrees; a Cowork project lists none. */
  readonly tasks: readonly CloudScheduleTask[];
}

/** What main reads of this computer's project and task a schedule names. */
export interface LocalSchedulePlace {
  readonly kind: 'git' | 'cowork';
  /** The GitHub `owner/name` the schedule runs in; null when not on GitHub. */
  readonly repository: string | null;
  /** The named task's branch, or the new worktree's base task's; null for none. */
  readonly branch: string | null;
}

export const CLOUD_DESTINATION_MESSAGES = {
  choose: 'Choose where this schedule runs in the cloud.',
  chooseProject:
    "This project isn't in the cloud as one project of this owner. Choose the cloud project it runs in.",
  chooseTask:
    "This task isn't in the cloud as one task of that project. Choose the cloud task it runs in.",
  noPlaces:
    'This owner has no cloud project to run this schedule in. Create one on the web, then move it again. Or move it with No project.',
  coworkTask:
    "A Cowork task's schedule can't move to the cloud yet. Schedule the project instead, or keep it on this computer.",
  invalidPick:
    "That cloud project or task isn't this owner's. Choose another one.",
} as const;

/** The organization id a run owner names; null for Personal. */
function organizationOf(owner: string): string | null {
  return owner.startsWith('org:') ? owner.slice('org:'.length) : null;
}

/** The owner's cloud places, oldest listing order kept. */
function placesOf(
  owner: string,
  places: readonly CloudSchedulePlace[],
): CloudSchedulePlace[] {
  const organization = organizationOf(owner);
  return places.filter((place) => place.ownerOrganizationId === organization);
}

function sameRepository(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/** The action's destination fields, kept on the stub for a move back. */
export function localDestinationOf(
  action: PipelineAction,
): AutomationCloudScheduleLocalDestination {
  return {
    ...(action.target === undefined ? {} : { target: action.target }),
    ...(action.workspaceId === undefined
      ? {}
      : { workspaceId: action.workspaceId }),
    ...(action.baseWorktreeId === undefined
      ? {}
      : { baseWorktreeId: action.baseWorktreeId }),
    ...(action.repoId === undefined ? {} : { repoId: action.repoId }),
  };
}

/** The action with the destination fields it had before it moved. */
export function withLocalDestination(
  action: PipelineAction,
  local: AutomationCloudScheduleLocalDestination,
): PipelineAction {
  const rest: PipelineAction = { ...action };
  delete rest.target;
  delete rest.workspaceId;
  delete rest.baseWorktreeId;
  delete rest.repoId;
  return { ...rest, ...local };
}

/**
 * Every destination a person may pick for `local` among the owner's places.
 * A new worktree based on a task keeps a base: each cloud task is offered as
 * one, since dropping it would base each run on the default branch.
 */
function candidatesFor(
  local: PipelineScheduleDestination,
  places: readonly CloudSchedulePlace[],
): AutomationCloudDestinationCandidate[] {
  const { kind } = local;
  if (local.kind === 'new_worktree' && local.baseWorktreeId !== undefined)
    return places
      .filter((place) => place.kind === 'git')
      .flatMap((place) =>
        place.tasks.map((task) => ({
          destination: {
            kind: 'new_worktree' as const,
            workspaceId: place.workspaceId,
            baseWorktreeId: task.worktreeId,
          },
          label: `${place.name} · ${task.name}`,
        })),
      );
  switch (kind) {
    case 'global':
      return [];
    case 'project':
      return places.map((place) => ({
        destination: { kind: 'project', workspaceId: place.workspaceId },
        label: place.name,
      }));
    case 'new_worktree':
      return places
        .filter((place) => place.kind === 'git')
        .map((place) => ({
          destination: { kind: 'new_worktree', workspaceId: place.workspaceId },
          label: place.name,
        }));
    case 'task':
      return places.flatMap((place) =>
        place.tasks.map((task) => ({
          destination: {
            kind: 'task' as const,
            workspaceId: place.workspaceId,
            taskId: task.worktreeId,
          },
          label: `${place.name} · ${task.name}`,
        })),
      );
  }
}

/** What a move does with the schedule's destination. */
export type CloudDestinationOutcome =
  | {
      readonly kind: 'ready';
      readonly destination: PipelineScheduleDestination;
    }
  | {
      readonly kind: 'choose';
      readonly message: string;
      readonly candidates: AutomationCloudDestinationCandidate[];
    }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * The cloud destination of a schedule whose destination on this computer is
 * `local`, for `owner`, or what to ask or refuse.
 */
export function cloudDestinationFor(input: {
  readonly local: PipelineScheduleDestination;
  readonly owner: string;
  readonly here: LocalSchedulePlace | null;
  readonly places: readonly CloudSchedulePlace[];
}): CloudDestinationOutcome {
  const { local } = input;
  if (local.kind === 'global') return { kind: 'ready', destination: local };
  if (input.here?.kind === 'cowork' && local.kind === 'task')
    return { kind: 'refused', message: CLOUD_DESTINATION_MESSAGES.coworkTask };
  const places = placesOf(input.owner, input.places);
  const choose = (message: string): CloudDestinationOutcome => {
    const candidates = candidatesFor(local, places);
    return candidates.length === 0
      ? { kind: 'refused', message: CLOUD_DESTINATION_MESSAGES.noPlaces }
      : { kind: 'choose', message, candidates };
  };
  const repository = input.here?.repository ?? null;
  const projects = places.filter(
    (place) =>
      place.kind === (input.here?.kind ?? 'git') &&
      sameRepository(place.repository, repository),
  );
  const [project] = projects;
  if (project === undefined || projects.length > 1)
    return choose(CLOUD_DESTINATION_MESSAGES.chooseProject);
  const branch = input.here?.branch ?? null;
  const tasks =
    branch === null
      ? []
      : project.tasks.filter((task) => task.branch === branch);
  switch (local.kind) {
    case 'project':
      return {
        kind: 'ready',
        destination: { kind: 'project', workspaceId: project.workspaceId },
      };
    case 'task': {
      const [task] = tasks;
      return task === undefined || tasks.length > 1
        ? choose(CLOUD_DESTINATION_MESSAGES.chooseTask)
        : {
            kind: 'ready',
            destination: {
              kind: 'task',
              workspaceId: project.workspaceId,
              taskId: task.worktreeId,
            },
          };
    }
    case 'new_worktree': {
      if (local.baseWorktreeId === undefined)
        return {
          kind: 'ready',
          destination: {
            kind: 'new_worktree',
            workspaceId: project.workspaceId,
          },
        };
      const [base] = tasks;
      // Dropping the base would base each run on the default branch.
      return base === undefined || tasks.length > 1
        ? choose(CLOUD_DESTINATION_MESSAGES.chooseTask)
        : {
            kind: 'ready',
            destination: {
              kind: 'new_worktree',
              workspaceId: project.workspaceId,
              baseWorktreeId: base.worktreeId,
            },
          };
    }
  }
}

/**
 * Whether a destination the person picked names one of the owner's cloud
 * places, of the kind the schedule runs in.
 */
export function isPickableCloudDestination(input: {
  readonly picked: PipelineScheduleDestination;
  readonly local: PipelineScheduleDestination;
  readonly owner: string;
  readonly places: readonly CloudSchedulePlace[];
}): boolean {
  const { picked, local } = input;
  if (picked.kind !== local.kind) return false;
  if (picked.kind === 'global') return true;
  const places = placesOf(input.owner, input.places);
  const place = places.find(
    (candidate) => candidate.workspaceId === picked.workspaceId,
  );
  if (place === undefined) return false;
  switch (picked.kind) {
    case 'project':
      return picked.repoId === undefined;
    case 'task':
      return place.tasks.some((task) => task.worktreeId === picked.taskId);
    case 'new_worktree':
      return (
        place.kind === 'git' &&
        picked.repoId === undefined &&
        // A schedule based on a task keeps a base.
        (picked.baseWorktreeId === undefined
          ? local.kind !== 'new_worktree' || local.baseWorktreeId === undefined
          : place.tasks.some(
              (task) => task.worktreeId === picked.baseWorktreeId,
            ))
      );
  }
}
