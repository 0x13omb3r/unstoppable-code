import { create } from 'zustand';
import type { CoreCoworkArchivedTask } from '@canopy/app-state/core-cowork';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { webCoreLocalId, webCoreScopeId } from '@/lib/chat-authority';
import { cloudCoworkStore } from './cloud-cowork-store';
import { restoredCloudTask, restoringCloudTask } from './cloud-task-deletion';

/*
 * A cloud project's archived and deleted tasks on desktop (CAN-6511): read
 * with `core.archive.container.list` and restored in place with
 * `core.archive.container.restore`, through the shared cloud cowork store.
 * The project's More row counts them and its More page lists them.
 */

export interface CloudArchivedTasks {
  readonly status: 'loading' | 'loaded' | 'failed';
  readonly tasks: readonly CoreCoworkArchivedTask[];
  /** Archive ids with a restore in flight. */
  readonly restoring: readonly string[];
  /** The archive id whose last restore the web core refused. */
  readonly restoreFailed: string | null;
}

interface CloudArchivedTasksState {
  /** By the project's `web-core:` id. */
  readonly byProject: Readonly<Record<string, CloudArchivedTasks>>;
  readonly load: (projectId: string) => Promise<void>;
  /** Answers whether the web core restored the task. */
  readonly restore: (projectId: string, archiveId: string) => Promise<boolean>;
  /** Forgets every project's list and drops the reads still in flight. */
  readonly reset: () => void;
}

const EMPTY: CloudArchivedTasks = {
  status: 'loading',
  tasks: [],
  restoring: [],
  restoreFailed: null,
};

export const useCloudArchivedTasksStore = create<CloudArchivedTasksState>(
  (set, get) => {
    // Each project's newest list read: a reply from an older one, or one a
    // restore overtook, would bring a restored task back.
    const reads = new Map<string, number>();
    // Bumped by `reset`: a restore that outlives its connection changes
    // nothing on the next one's lists.
    let connection = 0;
    const nextRead = (projectId: string): number => {
      const read = (reads.get(projectId) ?? 0) + 1;
      reads.set(projectId, read);
      return read;
    };
    const update = (
      projectId: string,
      change: (entry: CloudArchivedTasks) => CloudArchivedTasks,
    ): void =>
      set((state) => ({
        byProject: {
          ...state.byProject,
          [projectId]: change(state.byProject[projectId] ?? EMPTY),
        },
      }));

    return {
      byProject: {},

      load: async (projectId): Promise<void> => {
        const workspaceId = webCoreLocalId(projectId);
        if (workspaceId === null) return;
        const read = nextRead(projectId);
        update(projectId, (entry) => ({ ...entry, status: 'loading' }));
        try {
          const tasks = await cloudCoworkStore
            .getState()
            .listArchivedTasks(workspaceId);
          if (reads.get(projectId) !== read) return;
          update(projectId, (entry) => ({ ...entry, status: 'loaded', tasks }));
        } catch (error) {
          reportClientAppError(error);
          if (reads.get(projectId) !== read) return;
          // A failed read shows no rows, not ones an earlier read listed.
          update(projectId, (entry) => ({
            ...entry,
            status: 'failed',
            tasks: [],
          }));
        }
      },

      restore: async (projectId, archiveId): Promise<boolean> => {
        const workspaceId = webCoreLocalId(projectId);
        const task = get().byProject[projectId]?.tasks.find(
          (each) => each.archiveId === archiveId,
        );
        if (workspaceId === null || task === undefined) return false;
        update(projectId, (entry) => ({
          ...entry,
          restoring: [...entry.restoring, archiveId],
          restoreFailed: null,
        }));
        const scope = {
          projectId,
          worktreeId: webCoreScopeId(task.worktreeId),
        };
        const release = restoringCloudTask(scope);
        const started = connection;
        try {
          await cloudCoworkStore.getState().restoreTask(workspaceId, task);
          restoredCloudTask(scope);
          release();
          if (connection !== started) return true;
          // A list read before the restore landed still names the task.
          nextRead(projectId);
          update(projectId, (entry) => ({
            ...entry,
            // The read it overtook won't land: the list it shows stands.
            status: entry.status === 'loading' ? 'loaded' : entry.status,
            tasks: entry.tasks.filter((each) => each.archiveId !== archiveId),
            restoring: entry.restoring.filter((id) => id !== archiveId),
          }));
          return true;
        } catch (error) {
          release();
          reportClientAppError(error);
          if (connection !== started) return false;
          update(projectId, (entry) => ({
            ...entry,
            restoring: entry.restoring.filter((id) => id !== archiveId),
            restoreFailed: archiveId,
          }));
          // A refused restore may mean the list moved on: read it again.
          void get().load(projectId);
          return false;
        }
      },

      reset: (): void => {
        connection += 1;
        for (const projectId of reads.keys()) nextRead(projectId);
        set({ byProject: {} });
      },
    };
  },
);

// Another connection, or another account, reads its own archive: a list read
// under the last one is never shown under the next.
cloudCoworkStore.subscribe((state, previous) => {
  if (
    state.generation !== previous.generation ||
    (state.status !== 'online' && previous.status === 'online')
  )
    useCloudArchivedTasksStore.getState().reset();
});

/** The project's archived and deleted tasks, once they have loaded. */
export function cloudArchivedTaskCount(
  state: CloudArchivedTasksState,
  projectId: string,
): number {
  return state.byProject[projectId]?.tasks.length ?? 0;
}
