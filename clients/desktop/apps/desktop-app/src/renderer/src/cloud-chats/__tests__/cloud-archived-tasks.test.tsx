/** @jest-environment jsdom */
import './jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CoreCoworkArchivedTask } from '@canopy/app-state/core-cowork';
import { useOverlayEscape } from '@canopy/ui-shared/components';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { cloudCoworkStore } from '../cloud-cowork-store';
import { useCloudArchivedTasksStore } from '../cloud-archived-tasks';
import {
  isCloudTaskDeleted,
  markCloudTaskDeleted,
} from '@/stores/chat/web-core/task-deletions';
import {
  CLOUD_TASK_RESTORE_FAILED,
  CloudArchivedNavLink,
  CloudArchivedTasksPage,
} from '../CloudArchivedTasksPage';
import { openCoworkWorkEntryOnClick } from '@/lib/openCoworkWorkEntryFromSidebar';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A cloud project's archived tasks on desktop (CAN-6511): its More row counts
// them, and its More page lists them and restores one in place through the
// web core. Nothing reads this computer's archive with the cloud ids.

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PROJECT = `web-core:${WORKSPACE}`;

const task = (
  id: string,
  overrides: Partial<CoreCoworkArchivedTask> = {},
): CoreCoworkArchivedTask => ({
  archiveId: `work-entry:${id}`,
  revision: 3,
  worktreeId: id,
  title: `Task ${id}`,
  archivedAt: '2026-11-10T10:00:00.000Z',
  state: 'archived',
  expiresAt: null,
  ...overrides,
});

let root: Root;
let host: HTMLElement;
const localArchiveList = jest.fn();

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  localArchiveList.mockReset();
  Object.assign(window, {
    api: { archivedContainers: { list: localArchiveList } },
  });
  useCloudArchivedTasksStore.setState({ byProject: {} });
  cloudCoworkStore.setState({
    status: 'online',
    projects: [
      {
        key: PROJECT,
        workspaceId: WORKSPACE,
        name: 'Launch plan',
        kind: 'cowork',
        ownerOrganizationId: null,
      },
    ],
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const byTestId = (id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${id}"]`);

describe("a cloud project's archived tasks (CAN-6511)", () => {
  it("counts them in the More row, which opens the project's More page and never reads the local archive", async () => {
    const listArchivedTasks = jest.fn(() =>
      Promise.resolve([task('a'), task('b')]),
    );
    cloudCoworkStore.setState({ listArchivedTasks });

    await render(<CloudArchivedNavLink projectId={PROJECT} />);

    expect(listArchivedTasks).toHaveBeenCalledWith(WORKSPACE);
    const row = byTestId(`sidebar-project-${PROJECT}-archived-link`);
    expect(row?.textContent).toContain('2');
    await act(async () => {
      row?.click();
      await Promise.resolve();
    });
    expect(useArchivedContainersStore.getState().overview).toEqual({
      workspaceId: PROJECT,
    });
    expect(localArchiveList).not.toHaveBeenCalled();
  });

  it('lists them on the More page and restores one in place, which leaves the list', async () => {
    const restoreTask = jest.fn(() => Promise.resolve());
    cloudCoworkStore.setState({
      listArchivedTasks: () =>
        Promise.resolve([
          task('a'),
          task('b', {
            state: 'deleted',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
        ]),
      restoreTask,
    });

    await render(<CloudArchivedTasksPage projectId={PROJECT} />);

    expect(host.textContent).toContain('Task a');
    expect(host.textContent).toContain('Task b');
    expect(host.textContent).toContain('Launch plan');
    await act(async () => {
      byTestId('cloud-more-tasks-restore-work-entry:a')?.click();
      await Promise.resolve();
    });
    expect(restoreTask).toHaveBeenCalledWith(
      WORKSPACE,
      expect.objectContaining({ archiveId: 'work-entry:a', revision: 3 }),
    );
    expect(host.textContent).not.toContain('Task a');
    expect(host.textContent).toContain('Task b');
  });

  // CAN-6792: the web core names no placeholder for a task with no title.
  it('labels an untitled task the way the sidebar does, and keeps a real title', async () => {
    cloudCoworkStore.setState({
      listArchivedTasks: () =>
        Promise.resolve([
          task('a', { title: '' }),
          task('b', { title: 'Untitled chat' }),
        ]),
    });

    await render(<CloudArchivedTasksPage projectId={PROJECT} />);

    expect(
      byTestId('cloud-more-tasks-item-work-entry:a')?.textContent,
    ).toContain('Session');
    expect(
      byTestId('cloud-more-tasks-item-work-entry:b')?.textContent,
    ).toContain('Untitled chat');
  });

  it('says a refused restore failed and keeps the task, and a failed list offers Try again', async () => {
    let listed = 0;
    cloudCoworkStore.setState({
      listArchivedTasks: () => {
        listed += 1;
        return listed === 1
          ? Promise.reject(new Error('The web core is down.'))
          : Promise.resolve([task('a')]);
      },
      restoreTask: () =>
        Promise.reject(new Error('Restore the project first.')),
    });

    await render(<CloudArchivedTasksPage projectId={PROJECT} />);
    expect(byTestId('cloud-more-tasks-load-failed')).not.toBeNull();
    await act(async () => {
      byTestId('cloud-more-tasks-load-failed')
        ?.querySelector('button')
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Task a');

    await act(async () => {
      byTestId('cloud-more-tasks-restore-work-entry:a')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(byTestId('cloud-more-tasks-restore-failed')?.textContent).toBe(
      CLOUD_TASK_RESTORE_FAILED,
    );
    expect(host.textContent).toContain('Task a');
  });

  it('reads the archive again when the More row mounts after a failed read, so the row and its page come back', async () => {
    let listed = 0;
    const listArchivedTasks = jest.fn(() => {
      listed += 1;
      return listed === 1
        ? Promise.reject(new Error('The web core is restarting.'))
        : Promise.resolve([task('a')]);
    });
    cloudCoworkStore.setState({ listArchivedTasks });
    // The project's More page is closed, so an empty row hides.
    useArchivedContainersStore.setState({ overview: null });

    await render(<CloudArchivedNavLink projectId={PROJECT} />);
    // The failed read lists nothing, so the row is hidden.
    expect(byTestId(`sidebar-project-${PROJECT}-archived-link`)).toBeNull();
    expect(listArchivedTasks).toHaveBeenCalledTimes(1);

    // The sidebar shows the project again (a reconnect, a remount).
    await act(async () => {
      root.render(<></>);
      await Promise.resolve();
    });
    await render(<CloudArchivedNavLink projectId={PROJECT} />);
    expect(listArchivedTasks).toHaveBeenCalledTimes(2);
    expect(
      byTestId(`sidebar-project-${PROJECT}-archived-link`)?.textContent,
    ).toContain('1');
  });

  it('never brings a restored task back from a list read the restore overtook', async () => {
    let release = (): void => undefined;
    let listed = 0;
    cloudCoworkStore.setState({
      listArchivedTasks: () => {
        listed += 1;
        // The second read is still out when the restore lands, and still
        // names the task.
        if (listed === 2)
          return new Promise((resolve) => {
            release = (): void => resolve([task('a'), task('b')]);
          });
        return Promise.resolve([task('a'), task('b')]);
      },
      restoreTask: () => Promise.resolve(),
    });

    await render(<CloudArchivedTasksPage projectId={PROJECT} />);
    expect(host.textContent).toContain('Task a');
    await act(async () => {
      void useCloudArchivedTasksStore.getState().load(PROJECT);
      await Promise.resolve();
    });
    await act(async () => {
      byTestId('cloud-more-tasks-restore-work-entry:a')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).not.toContain('Task a');

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).not.toContain('Task a');
    expect(host.textContent).toContain('Task b');
  });

  it('reads the archive again each time the More row mounts, so a task archived elsewhere since an empty read shows', async () => {
    let listed = 0;
    const listArchivedTasks = jest.fn(() => {
      listed += 1;
      return Promise.resolve(listed === 1 ? [] : [task('a')]);
    });
    cloudCoworkStore.setState({ listArchivedTasks });
    useArchivedContainersStore.setState({ overview: null });

    await render(<CloudArchivedNavLink projectId={PROJECT} />);
    expect(byTestId(`sidebar-project-${PROJECT}-archived-link`)).toBeNull();

    // Another client archives a task; the sidebar shows the project again.
    await act(async () => {
      root.render(<></>);
      await Promise.resolve();
    });
    await render(<CloudArchivedNavLink projectId={PROJECT} />);
    expect(listArchivedTasks).toHaveBeenCalledTimes(2);
    expect(
      byTestId(`sidebar-project-${PROJECT}-archived-link`)?.textContent,
    ).toContain('1');
  });

  it('a restored task is no longer deleted on this computer (CAN-6511, CAN-6614)', async () => {
    const scope = { projectId: PROJECT, worktreeId: 'web-core:a' };
    markCloudTaskDeleted(scope);
    cloudCoworkStore.setState({
      listArchivedTasks: () => Promise.resolve([task('a')]),
      restoreTask: () => Promise.resolve(),
    });

    await render(<CloudArchivedTasksPage projectId={PROJECT} />);
    expect(isCloudTaskDeleted(scope)).toBe(true);
    await act(async () => {
      byTestId('cloud-more-tasks-restore-work-entry:a')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(isCloudTaskDeleted(scope)).toBe(false);
  });

  it('forgets every list when the cloud connection or account changes, and a failed read shows no earlier rows', async () => {
    let listed = 0;
    cloudCoworkStore.setState({
      listArchivedTasks: () => {
        listed += 1;
        return listed === 2
          ? Promise.reject(new Error('Not signed in.'))
          : Promise.resolve([task('a')]);
      },
    });

    await render(<CloudArchivedTasksPage projectId={PROJECT} />);
    expect(host.textContent).toContain('Task a');
    // A read that fails shows its notice, not the rows an earlier one read.
    await act(async () => {
      await useCloudArchivedTasksStore.getState().load(PROJECT);
    });
    expect(byTestId('cloud-more-tasks-load-failed')).not.toBeNull();
    expect(host.textContent).not.toContain('Task a');

    await act(async () => {
      await useCloudArchivedTasksStore.getState().load(PROJECT);
    });
    expect(host.textContent).toContain('Task a');
    // Another connection, or account: nothing read under the last one stays,
    // and nothing is read again until it is online.
    act(() => {
      cloudCoworkStore.setState({
        generation: cloudCoworkStore.getState().generation + 1,
        status: 'offline',
      });
    });
    expect(useCloudArchivedTasksStore.getState().byProject).toEqual({});
  });

  it.each([
    ['list read', 'list'],
    ['restore', 'restore'],
  ] as const)(
    "never shows the earlier account's rows when its slow %s lands after an account switch",
    async (_label, slow) => {
      let account: 'first' | 'second' = 'first';
      let releaseFirstList = (): void => undefined;
      let releaseRestore = (): void => undefined;
      let releaseSecondList = (): void => undefined;
      cloudCoworkStore.setState({
        listArchivedTasks: () => {
          if (account === 'second')
            return new Promise((resolve) => {
              releaseSecondList = (): void => resolve([task('second-b')]);
            });
          if (slow === 'list')
            return new Promise((resolve) => {
              releaseFirstList = (): void => resolve([task('first-a')]);
            });
          return Promise.resolve([task('first-a')]);
        },
        restoreTask: () =>
          new Promise<void>((resolve) => {
            releaseRestore = resolve;
          }),
      });

      await render(<CloudArchivedTasksPage projectId={PROJECT} />);
      if (slow === 'restore') {
        expect(host.textContent).toContain('Task first-a');
        await act(async () => {
          byTestId('cloud-more-tasks-restore-work-entry:first-a')?.click();
          await Promise.resolve();
        });
      }

      // Signed in as someone else: the page reads the second account's list.
      account = 'second';
      act(() => {
        cloudCoworkStore.setState({
          generation: cloudCoworkStore.getState().generation + 1,
        });
      });
      await act(async () => {
        void useCloudArchivedTasksStore.getState().load(PROJECT);
        await Promise.resolve();
      });

      // The first account's slow reply lands now.
      await act(async () => {
        if (slow === 'list') releaseFirstList();
        else releaseRestore();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(host.textContent).not.toContain('Task first-a');

      await act(async () => {
        releaseSecondList();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(useCloudArchivedTasksStore.getState().byProject[PROJECT]).toEqual(
        expect.objectContaining({
          status: 'loaded',
          tasks: [task('second-b')],
          restoring: [],
          restoreFailed: null,
        }),
      );
      expect(host.textContent).toContain('Task second-b');
      expect(host.textContent).not.toContain('Task first-a');
    },
  );

  it('reads the archive again when the connection comes back, with nothing else to reload it', async () => {
    let listed = 0;
    cloudCoworkStore.setState({
      listArchivedTasks: () => {
        listed += 1;
        return Promise.resolve([task('a')]);
      },
    });
    // The page alone: no More row is mounted to read the archive for it.
    await render(<CloudArchivedTasksPage projectId={PROJECT} />);
    expect(listed).toBe(1);
    expect(host.textContent).toContain('Task a');

    // The connection drops, which forgets the list, then comes back.
    act(() => {
      cloudCoworkStore.setState({
        generation: cloudCoworkStore.getState().generation + 1,
        status: 'offline',
      });
    });
    await render(<CloudArchivedTasksPage projectId={PROJECT} />);
    expect(listed).toBe(1);
    expect(host.textContent).not.toContain('Task a');
    act(() => {
      cloudCoworkStore.setState({ status: 'online' });
    });
    await render(<CloudArchivedTasksPage projectId={PROJECT} />);
    expect(listed).toBe(2);
    expect(host.textContent).toContain('Task a');
  });

  it('reads nothing while offline and shows no earlier rows', async () => {
    let listed = 0;
    cloudCoworkStore.setState({
      status: 'offline',
      listArchivedTasks: () => {
        listed += 1;
        return Promise.resolve([task('a')]);
      },
    });
    await render(<CloudArchivedTasksPage projectId={PROJECT} />);
    expect(listed).toBe(0);
    expect(host.textContent).not.toContain('Task a');
  });

  describe('leaving the More page (CAN-6791)', () => {
    it('Back closes it, and so does Escape', async () => {
      cloudCoworkStore.setState({
        listArchivedTasks: () => Promise.resolve([task('a')]),
      });
      const onClose = jest.fn();
      await render(
        <CloudArchivedTasksPage projectId={PROJECT} onClose={onClose} />,
      );

      await act(async () => {
        byTestId('cloud-more-tasks-back')?.click();
        await Promise.resolve();
      });
      expect(onClose).toHaveBeenCalledTimes(1);

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('Escape on a dialog open over it closes only the dialog', async () => {
      cloudCoworkStore.setState({
        listArchivedTasks: () => Promise.resolve([task('a')]),
      });
      const onClose = jest.fn();
      const closeDialog = jest.fn();
      function DialogOver(): null {
        useOverlayEscape(true, closeDialog);
        return null;
      }
      await render(
        <>
          <CloudArchivedTasksPage projectId={PROJECT} onClose={onClose} />
          <DialogOver />
        </>,
      );

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
      });
      expect(closeDialog).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('a restore that lands closes it; a refused one keeps it open with its notice', async () => {
      const restoreTask = jest
        .fn<Promise<void>, unknown[]>()
        .mockRejectedValueOnce(new Error('refused'))
        .mockResolvedValueOnce(undefined);
      cloudCoworkStore.setState({
        listArchivedTasks: () => Promise.resolve([task('a')]),
        restoreTask,
      });
      const onClose = jest.fn();
      await render(
        <CloudArchivedTasksPage projectId={PROJECT} onClose={onClose} />,
      );

      await act(async () => {
        byTestId('cloud-more-tasks-restore-work-entry:a')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(byTestId('cloud-more-tasks-restore-failed')).not.toBeNull();

      await act(async () => {
        byTestId('cloud-more-tasks-restore-work-entry:a')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a restore that lands after the page left, or moved to another project, closes nothing', async () => {
      const landings: (() => void)[] = [];
      cloudCoworkStore.setState({
        listArchivedTasks: () => Promise.resolve([task('a')]),
        restoreTask: () =>
          new Promise<void>((resolve) => {
            landings.push(resolve);
          }),
      });
      const onClose = jest.fn();
      await render(
        <CloudArchivedTasksPage projectId={PROJECT} onClose={onClose} />,
      );
      await act(async () => {
        byTestId('cloud-more-tasks-restore-work-entry:a')?.click();
        await Promise.resolve();
      });
      // The user leaves for another project's More page before it lands.
      await render(
        <CloudArchivedTasksPage
          projectId="web-core:other-workspace"
          onClose={onClose}
        />,
      );
      await act(async () => {
        landings.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(onClose).not.toHaveBeenCalled();

      // Back on the first project, a restore lands after the page has gone.
      await render(
        <CloudArchivedTasksPage projectId={PROJECT} onClose={onClose} />,
      );
      await act(async () => {
        byTestId('cloud-more-tasks-restore-work-entry:a')?.click();
        await Promise.resolve();
      });
      await render(<></>);
      await act(async () => {
        landings.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(landings).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('clicking a task in the sidebar closes it, as a restored task, another task or the More row did not before', async () => {
      cloudCoworkStore.setState({
        listArchivedTasks: () => Promise.resolve([task('a')]),
      });
      await render(<CloudArchivedNavLink projectId={PROJECT} />);
      await act(async () => {
        byTestId(`sidebar-project-${PROJECT}-archived-link`)?.click();
        await Promise.resolve();
      });
      expect(useArchivedContainersStore.getState().overview).toEqual({
        workspaceId: PROJECT,
      });

      act(() => {
        openCoworkWorkEntryOnClick(PROJECT, 'web-core:a');
      });
      expect(useArchivedContainersStore.getState().overview).toBeNull();
    });
  });
});
