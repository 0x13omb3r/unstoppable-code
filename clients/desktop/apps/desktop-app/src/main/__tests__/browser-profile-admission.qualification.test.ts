import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { migratePanelLayout } from '@canopy/protocol/panels';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import * as profiles from '../browser/browser-profile-service';
import { registerBrowserHandlers } from '../ipc/browser';
import * as paths from '../lib/paths';
import { BrowserTaskFiles } from '../browser/files/task-files';
import {
  captureWorktreeBrowserStateRollback,
  loadWorktreeBrowserState,
  saveWorktreeBrowserState,
} from '../browser/browser-persistence';
import {
  applyInitialSharedContainerViewerLayout,
  createSharedContainerStartPageLayout,
} from '../shared-containers/layout-projection';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import type * as archivedContainers from '../lib/archived-containers';

// Keep workspace policy outside the persistence contract under test.
jest.mock('../lib/archived-containers', () => ({
  withArchivedWorkspaceOperationLock: jest.requireActual<
    typeof archivedContainers
  >('../lib/archived-containers').withArchivedWorkspaceOperationLock,
}));
jest.mock('../lib/workspace-target-exclusion', () => ({
  withWorkspaceTargetRuntimeStartReservation: (
    _p: string,
    _w: string,
    run: () => Promise<void>,
  ): Promise<void> => run(),
}));
jest.mock('../lib/workspace-activity', () => ({
  touchWorkspaceTargetWithoutOperationLock: (): Promise<void> =>
    Promise.resolve(),
}));

// Isolate Chromium and the invoke wrapper, not profile commands or persistence.
jest.mock('../browser/browser-service', () => ({
  BrowserService: class {
    profileData = { ensureReady: (): Promise<void> => Promise.resolve() };
  },
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

type ProfileHandler = (
  event: Partial<IpcMainInvokeEvent>,
  input: unknown,
) => Promise<unknown>;
const { registerIpcHandler } = jest.requireMock<{
  registerIpcHandler: jest.Mock<void, [string, ProfileHandler]>;
}>('../ipc/register');

test('browser:profiles commands use the desktop repository lease and retry without replacing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-ipc-r7-'));
  const service = new profiles.BrowserProfileService(directory, directory);
  try {
    await service.ensureReady();
    await service.purgeRetired();
    jest.spyOn(profiles, 'getBrowserProfileService').mockReturnValue(service);
    registerBrowserHandlers(() => null);
    const handler = registerIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.browserProfiles,
    )?.[1];
    if (!handler) throw new Error('Missing profile handler');
    const request = {
      schemaVersion: 1,
      method: 'create',
      request: { operationId: 'ipc-create', input: { displayName: 'one' } },
    };
    await service.repository.createNamed('seed', { displayName: 'seed' });
    const root = join(directory, 'browser-profiles');
    const catalog = await readFile(join(root, 'catalog.json'));
    const lease = JSON.stringify({ pid: process.pid, token: 'ipc-holder' });
    await writeFile(join(root, 'writer.lock'), lease);
    expect(await handler({}, request)).toMatchObject({
      ok: false,
      error: { code: 'storage_unavailable' },
    });
    expect(await readFile(join(root, 'catalog.json'))).toEqual(catalog);
    expect(await readFile(join(root, 'writer.lock'), 'utf8')).toBe(lease);
    // Release this test-owned live lease; not an operator recovery procedure.
    await rm(join(root, 'writer.lock'));
    const result = await handler({}, request);
    expect(result).toMatchObject({ ok: true, value: { displayName: 'one' } });
    expect(await handler({}, request)).toEqual(result);
    expect(
      (await service.repository.list()).map((p) => p.displayName).sort(),
    ).toEqual(['one', 'seed']);
  } finally {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

// The browser metadata golden also pins the persisted state used by viewer projection.
describe('browser metadata preservation', () => {
  let directory: string;
  const scope = { projectId: 'r8-project', worktreeId: 'r8-task' };
  const containerId = 'r8-container';
  const damagedCatalogs = [
    ['empty', ''],
    ['malformed', '{broken'],
    ['future', '{"version":999,"records":[{"future":"retain"}]}'],
    ['invalid-shape', '{"version":1,"records":"retain"}'],
  ];
  const damagedBrowserStates = [
    ['empty', ''],
    ['malformed', '{broken'],
    ['future', '{"version":999,"browsers":[{"future":"retain"}]}'],
    [
      'invalid-shape',
      '{"version":2,"browsers":"retain","browserOrder":[],"activeBrowserId":null}',
    ],
  ];
  const previousState = {
    version: 2,
    browsers: [
      {
        id: 'previous-browser',
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: containerId,
        createdAt: 1,
        updatedAt: 2,
        url: 'https://previous.invalid/',
        title: 'Previous browser',
        status: 'ready',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        themeMode: 'light',
        pickMode: false,
        recording: false,
      },
    ],
    browserOrder: ['previous-browser'],
    activeBrowserId: 'previous-browser',
  };
  function projection(
    mode: 'seed' | 'reset',
    stopViewerBrowsers?: (containerId: string) => Promise<void>,
  ): ReturnType<typeof applyInitialSharedContainerViewerLayout> {
    return applyInitialSharedContainerViewerLayout({
      containerId,
      mode,
      stopViewerBrowsers,
      layout: createSharedContainerStartPageLayout({
        kind: 'url',
        url: 'https://example.invalid/',
      }),
      roots: [],
      publishedPathsByRepo: new Map(),
      chatIds: new Set(),
    });
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'can4497-r8-'));
    jest
      .spyOn(paths, 'getWorktreeBrowserStateFilePath')
      .mockImplementation(() => join(directory, 'browser-state.json'));
    jest
      .spyOn(paths, 'getWorktreePanelLayoutFilePath')
      .mockImplementation(() => join(directory, 'panel-layout.json'));
  });
  afterEach(async () => {
    panelLayoutPersistenceStore.cancelPendingWrite(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      containerId,
    );
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  describe('browser:create, browser:load-worktree-state and browser:list-transfers catalog preservation', () => {
    test('missing catalog initializes version 1', async () => {
      const files = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      await files.bind(scope);
      expect(
        JSON.parse(
          await readFile(join(directory, 'browser-files/files.json'), 'utf8'),
        ),
      ).toEqual({ version: 1, records: [] });
    });
    test('valid empty catalog survives bind', async () => {
      await mkdir(join(directory, 'browser-files'), { recursive: true });
      const path = join(directory, 'browser-files/files.json');
      const bytes = '{"version":1,"records":[]}';
      await writeFile(path, bytes);
      await new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      }).bind(scope);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    });
    test.each(damagedCatalogs)(
      '%s input must survive bind byte-for-byte',
      async (_name, bytes): Promise<void> => {
        await mkdir(join(directory, 'browser-files'), { recursive: true });
        const path = join(directory, 'browser-files/files.json');
        await writeFile(path, bytes);
        const files = new BrowserTaskFiles({
          emit(): void {},
          taskDir: (): string => directory,
        });
        await expect(files.bind(scope)).rejects.toThrow();
        await expect(files.bind(scope)).rejects.toThrow();
        expect(
          files.admitDownload({
            scope,
            runtime: {
              browserId: 'browser',
              runtimeGeneration: 1,
              taskIncarnationId: 'task',
            },
            downloadId: 'new-download',
            suggestedName: 'new.txt',
            url: 'https://example.invalid/',
            totalBytes: null,
            source: 'user',
          }),
        ).toEqual({ ok: false, reason: 'unavailable' });
        expect(await readFile(path, 'utf8')).toBe(bytes);
      },
    );
    test('invalid record must not be silently omitted on bind', async () => {
      await mkdir(join(directory, 'browser-files'), { recursive: true });
      const path = join(directory, 'browser-files/files.json');
      const bytes = '{"version":1,"records":[{"kind":"upload","id":"retain"}]}';
      await writeFile(path, bytes);
      await new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      })
        .bind(scope)
        .catch(() => undefined);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    });
    test('non-absence read error refuses bind without replacing directory', async () => {
      const path = join(directory, 'browser-files/files.json');
      await mkdir(path, { recursive: true });
      await expect(
        new BrowserTaskFiles({
          emit(): void {},
          taskDir: (): string => directory,
        }).bind(scope),
      ).rejects.toThrow();
      expect(await readdir(path)).toEqual([]);
    });
  });

  describe('explicit target removal', () => {
    test('directory access failure is not retried as a catalog failure', async () => {
      const folder = join(directory, 'browser-files');
      await mkdir(folder);
      await writeFile(join(folder, 'retain.txt'), 'retain');
      const files = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      const denied = Object.assign(new Error('Task directory denied'), {
        code: 'EACCES',
      });
      const opening = jest.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
        throw denied;
      });
      const removal = files.removeTask(scope);
      await removal.catch(() => undefined);
      expect(opening).toHaveBeenCalledWith(directory, {
        recursive: true,
        mode: 0o700,
      });
      await expect(removal).rejects.toBe(denied);
      expect(await readFile(join(folder, 'retain.txt'), 'utf8')).toBe('retain');
    });
    test('catalog failure does not adopt a replacement directory', async () => {
      const folder = join(directory, 'browser-files');
      await mkdir(folder);
      await writeFile(join(folder, 'files.json'), '{broken');
      const files = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      const read = fs.readFileSync;
      const reading = jest
        .spyOn(fs, 'readFileSync')
        .mockImplementationOnce((...args) => {
          const bytes = read(...args);
          fs.renameSync(folder, join(directory, 'original'));
          fs.mkdirSync(join(folder, 'downloads'), { recursive: true });
          fs.writeFileSync(join(folder, 'retain.txt'), 'replacement');
          return bytes;
        });
      const removal = files.removeTask(scope);
      await removal.catch(() => undefined);
      expect(reading).toHaveBeenCalledWith(expect.any(Number), 'utf8');
      await expect(removal).rejects.toThrow('Download directory changed');
      expect(await readFile(join(folder, 'retain.txt'), 'utf8')).toBe(
        'replacement',
      );
      expect(
        await readFile(join(directory, 'original/files.json'), 'utf8'),
      ).toBe('{broken');
    });
    test('cached removal still refuses a replacement directory', async () => {
      const folder = join(directory, 'browser-files');
      const files = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      await files.bind(scope);
      await fsPromises.rename(folder, join(directory, 'original'));
      await mkdir(join(folder, 'downloads'), { recursive: true });
      await writeFile(join(folder, 'retain.txt'), 'replacement');
      await expect(files.removeTask(scope)).rejects.toThrow(
        'Download directory changed',
      );
      expect(await readFile(join(folder, 'retain.txt'), 'utf8')).toBe(
        'replacement',
      );
      expect(await readdir(join(directory, 'original'))).toContain(
        'files.json',
      );
    });
    test('cached removal rechecks identity after asynchronous staged-upload cleanup', async () => {
      const folder = join(directory, 'browser-files');
      const staged = join(folder, 'uploads/staged');
      const files = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      await files.bind(scope);
      await mkdir(staged, { recursive: true });
      await writeFile(join(staged, 'file.txt'), 'staged');
      const remove = fsPromises.rm;
      jest.spyOn(fsPromises, 'rm').mockImplementation(async (...args) => {
        await remove(...args);
        if (args[0] === staged) {
          fs.renameSync(folder, join(directory, 'original'));
          fs.mkdirSync(join(folder, 'downloads'), { recursive: true });
          fs.writeFileSync(join(folder, 'retain.txt'), 'replacement');
        }
      });
      await expect(files.removeTask(scope)).rejects.toThrow(
        'Download directory changed',
      );
      expect(await readFile(join(folder, 'retain.txt'), 'utf8')).toBe(
        'replacement',
      );
    });
    describe.each(['uncached', 'failed bind'])('%s task', (mode) => {
      test.each([
        ...damagedCatalogs,
        [
          'invalid-record',
          '{"version":1,"records":[{"kind":"upload","id":"retain"}]}',
        ],
      ])('%s catalog does not block removal', async (_name, bytes) => {
        const folder = join(directory, 'browser-files');
        const staged = join(folder, 'uploads/staged');
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'file.txt'), 'staged');
        await writeFile(join(folder, 'files.json'), bytes);
        const files = new BrowserTaskFiles({
          emit(): void {},
          taskDir: (): string => directory,
        });
        if (mode === 'failed bind') {
          await expect(files.bind(scope)).rejects.toThrow();
          expect(await readFile(join(folder, 'files.json'), 'utf8')).toBe(
            bytes,
          );
        }
        await expect(files.removeTask(scope)).resolves.toBeUndefined();
        await expect(readdir(folder)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(files.removeTask(scope)).resolves.toBeUndefined();
      });
    });
    test.each(['missing', 'unreadable directory'])(
      '%s catalog does not block removal',
      async (mode) => {
        const folder = join(directory, 'browser-files');
        await mkdir(folder, { recursive: true });
        if (mode === 'unreadable directory')
          await mkdir(join(folder, 'files.json'));
        const files = new BrowserTaskFiles({
          emit(): void {},
          taskDir: (): string => directory,
        });
        await expect(files.removeTask(scope)).resolves.toBeUndefined();
        await expect(readdir(folder)).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
    test('readable catalog still cleans interrupted copies outside the task folder', async () => {
      const folder = join(directory, 'browser-files');
      const tempPath = join(
        directory,
        '.canopy-copy-b5b278eb-ecf3-4562-9586-928b47d67408.part',
      );
      await mkdir(folder, { recursive: true });
      await writeFile(tempPath, 'partial copy');
      await writeFile(join(directory, 'unrelated.txt'), 'retain');
      await writeFile(
        join(folder, 'files.json'),
        JSON.stringify({
          version: 1,
          records: [
            {
              kind: 'copy',
              id: 'copy',
              browserId: 'browser',
              sourceId: 'download',
              source: 'user',
              destinationName: 'copied.txt',
              copiedBytes: 0,
              totalBytes: 0,
              status: 'in_progress',
              startedAt: 1,
              tempPath,
            },
          ],
        }),
      );
      const files = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      await files.removeTask(scope);
      await expect(readFile(tempPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readdir(folder)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(directory, 'unrelated.txt'), 'utf8')).toBe(
        'retain',
      );
    });
    test('partially loaded invalid catalog cannot select external files for cleanup', async () => {
      const folder = join(directory, 'browser-files');
      const tempPath = join(
        directory,
        '.canopy-copy-b5b278eb-ecf3-4562-9586-928b47d67408.part',
      );
      const copy = {
        kind: 'copy',
        id: 'copy',
        browserId: 'browser',
        sourceId: 'download',
        source: 'user',
        destinationName: 'copied.txt',
        copiedBytes: 0,
        totalBytes: 0,
        status: 'in_progress',
        startedAt: 1,
        tempPath,
      };
      await mkdir(folder);
      await writeFile(tempPath, 'retain');
      await writeFile(
        join(folder, 'files.json'),
        JSON.stringify({ version: 1, records: [copy, copy] }),
      );
      const files = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      await files.removeTask(scope);
      await expect(readdir(folder)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(tempPath, 'utf8')).toBe('retain');
    });
    test.each(['browser-files', 'browser-files/downloads'])(
      'catalog bypass does not bypass %s directory safety',
      async (unsafePath) => {
        const outside = join(directory, 'outside');
        await mkdir(outside);
        await writeFile(join(outside, 'retain.txt'), 'retain');
        if (unsafePath.endsWith('/downloads'))
          await mkdir(join(directory, 'browser-files'));
        await symlink(outside, join(directory, unsafePath), 'dir');
        const files = new BrowserTaskFiles({
          emit(): void {},
          taskDir: (): string => directory,
        });
        await expect(files.removeTask(scope)).rejects.toThrow();
        expect(await readFile(join(outside, 'retain.txt'), 'utf8')).toBe(
          'retain',
        );
      },
    );
  });

  describe('task catalog record integrity', () => {
    const download = {
      kind: 'download',
      id: 'download',
      browserId: 'browser',
      source: 'user',
      origin: 'https://example.invalid/',
      fileName: 'file.txt',
      receivedBytes: 0,
      totalBytes: null,
      status: 'in_progress',
      startedAt: 1,
    };
    test.each([
      ['invalid download', [{ kind: 'download', id: 'retain' }]],
      ['invalid copy', [{ kind: 'copy', id: 'retain' }]],
      ['unknown kind', [{ kind: 'future', id: 'retain' }]],
      ['missing kind', [{ ...download, kind: undefined }]],
      ['unknown source', [{ ...download, source: 'future-source' }]],
      ['unknown status', [{ ...download, status: 'future-status' }]],
      [
        'unknown error',
        [{ ...download, error: { code: 'future-error', message: 'Retain' } }],
      ],
      ['unsafe filename', [{ ...download, fileName: '../file.txt' }]],
      ['duplicate id', [download, download]],
      [
        'cross-kind duplicate',
        [
          download,
          {
            kind: 'copy',
            id: download.id,
            browserId: 'browser',
            sourceId: 'source',
            source: 'user',
            destinationName: 'copied.txt',
            copiedBytes: 0,
            totalBytes: 0,
            status: 'complete',
            startedAt: 1,
          },
        ],
      ],
      ['mixed valid and invalid', [download, { kind: 'upload', id: 'retain' }]],
    ])(
      '%s refuses before recovery cleanup',
      async (_name, records): Promise<void> => {
        const folder = join(directory, 'browser-files');
        await mkdir(join(folder, 'downloads'), { recursive: true });
        const path = join(folder, 'files.json');
        const bytes = JSON.stringify({ version: 1, records });
        await writeFile(path, bytes);
        const partial = join(folder, 'downloads/file.txt.download');
        await writeFile(partial, 'partial');
        const staged = join(folder, 'uploads/retain');
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'evidence'), 'staged');
        const files = new BrowserTaskFiles({
          emit(): void {},
          taskDir: (): string => directory,
        });
        await expect(files.bind(scope)).rejects.toThrow();
        expect(await readFile(path, 'utf8')).toBe(bytes);
        expect(await readFile(partial, 'utf8')).toBe('partial');
        expect(await readFile(join(staged, 'evidence'), 'utf8')).toBe('staged');
      },
    );
    test('version-1 download, copy and upload records from their introduction still bind', async () => {
      const folder = join(directory, 'browser-files');
      await mkdir(folder, { recursive: true });
      const records = [
        // The first files.json writer already included kind. Runtime identity fields default.
        { ...download, status: 'complete', totalBytes: 0 },
        {
          kind: 'copy',
          id: 'copy',
          browserId: 'browser',
          sourceId: download.id,
          source: 'agent',
          destinationName: 'copied.txt',
          copiedBytes: 0,
          totalBytes: 0,
          status: 'failed',
          startedAt: 2,
          error: { code: 'destination_exists', message: 'Old copy message' },
        },
        {
          kind: 'upload',
          id: 'b5b278eb-ecf3-4562-9586-928b47d67408',
          browserId: 'browser',
          frameOrigin: 'https://example.invalid',
          topOrigin: 'https://example.invalid',
          files: [
            { name: 'upload.txt', displayPath: 'upload.txt', sizeBytes: 0 },
          ],
          stagedBytes: 0,
          totalBytes: 0,
          status: 'failed',
          startedAt: 3,
          error: { code: 'origin_changed', message: 'Old upload message' },
        },
      ];
      await writeFile(
        join(folder, 'files.json'),
        JSON.stringify({ version: 1, records }),
      );
      const files = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      await files.bind(scope);
      const transfers = files.list(scope, 'browser', { browserId: 'browser' });
      expect(transfers.total).toBe(3);
      expect(transfers.transfers).toMatchObject([
        {
          id: 'b5b278eb-ecf3-4562-9586-928b47d67408',
          kind: 'upload',
          status: 'failed',
        },
        { id: 'copy', kind: 'copy', status: 'failed' },
        { id: download.id, kind: 'download', status: 'complete' },
      ]);
      // Reopen the actual rewritten image too, rather than only trusting memory.
      const reopened = new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      });
      await reopened.bind(scope);
      expect(reopened.list(scope, 'browser', { browserId: 'browser' })).toEqual(
        transfers,
      );
    });
    test('a valid interrupted download still recovers and keeps its record', async () => {
      const folder = join(directory, 'browser-files');
      await mkdir(join(folder, 'downloads'), { recursive: true });
      await writeFile(
        join(folder, 'files.json'),
        JSON.stringify({ version: 1, records: [download] }),
      );
      const partial = join(folder, 'downloads/file.txt.download');
      await writeFile(partial, 'partial');
      await new BrowserTaskFiles({
        emit(): void {},
        taskDir: (): string => directory,
      }).bind(scope);
      const saved: unknown = JSON.parse(
        await readFile(join(folder, 'files.json'), 'utf8'),
      );
      expect(saved).toMatchObject({
        version: 1,
        records: [{ id: download.id, status: 'interrupted' }],
      });
      if (!saved || typeof saved !== 'object' || !('records' in saved))
        throw new Error('Missing saved records');
      const records: unknown = saved.records;
      if (!Array.isArray(records)) throw new Error('Invalid saved records');
      expect(records).toHaveLength(1);
      await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('shared-containers:open and shared-containers:refresh-run-copy browser-state preservation', () => {
    test('missing state can seed a real browser snapshot', async () => {
      expect(
        loadWorktreeBrowserState(
          SHARED_CONTAINER_VIEWER_PROJECT_ID,
          containerId,
        ).status,
      ).toBe('missing');
      expect((await projection('seed')).applied).toBe(true);
      const loaded = loadWorktreeBrowserState(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        containerId,
      );
      expect(loaded.status).toBe('loaded');
      expect(loaded.state?.browsers).toHaveLength(1);
    });
    test.each(damagedBrowserStates)(
      'ordinary seed must preserve %s state',
      async (_name, bytes): Promise<void> => {
        const path = join(directory, 'browser-state.json');
        await writeFile(path, bytes);
        expect(
          loadWorktreeBrowserState(
            SHARED_CONTAINER_VIEWER_PROJECT_ID,
            containerId,
          ).status,
        ).toBe('fallback');
        expect((await projection('seed')).applied).toBe(false);
        expect(
          panelLayoutPersistenceStore.loadWorktreeLayout(
            SHARED_CONTAINER_VIEWER_PROJECT_ID,
            containerId,
          ),
        ).toBeNull();
        expect(await readFile(path, 'utf8')).toBe(bytes);
      },
    );
    test('explicit reset rollback restores a valid previous state (success control)', async () => {
      const path = join(directory, 'browser-state.json');
      await writeFile(path, JSON.stringify(previousState));
      expect(
        loadWorktreeBrowserState(
          SHARED_CONTAINER_VIEWER_PROJECT_ID,
          containerId,
        ).status,
      ).toBe('loaded');
      const applied = await projection('reset');
      expect(applied.applied).toBe(true);
      expect(
        loadWorktreeBrowserState(
          SHARED_CONTAINER_VIEWER_PROJECT_ID,
          containerId,
        ).state?.browsers,
      ).toHaveLength(1);
      expect(
        loadWorktreeBrowserState(
          SHARED_CONTAINER_VIEWER_PROJECT_ID,
          containerId,
        ).state?.browsers[0]?.url,
      ).toBe('https://example.invalid/');
      await applied.rollback();
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify(previousState));
    });
    test.each(damagedBrowserStates)(
      'explicit reset replaces %s, but its rollback must restore original bytes',
      async (_name, bytes): Promise<void> => {
        const path = join(directory, 'browser-state.json');
        await writeFile(path, bytes);
        expect(
          loadWorktreeBrowserState(
            SHARED_CONTAINER_VIEWER_PROJECT_ID,
            containerId,
          ).status,
        ).toBe('fallback');
        const applied = await projection('reset');
        expect(applied.applied).toBe(true);
        expect(
          loadWorktreeBrowserState(
            SHARED_CONTAINER_VIEWER_PROJECT_ID,
            containerId,
          ).state?.browsers,
        ).toHaveLength(1);
        await applied.rollback();
        expect(await readFile(path, 'utf8')).toBe(bytes);
      },
    );
    test.each(damagedBrowserStates)(
      'failed reset must preserve %s state',
      async (_name, bytes): Promise<void> => {
        const path = join(directory, 'browser-state.json');
        await writeFile(path, bytes);
        expect(
          loadWorktreeBrowserState(
            SHARED_CONTAINER_VIEWER_PROJECT_ID,
            containerId,
          ).status,
        ).toBe('fallback');
        const error = new Error('R8 injected pre-install rename failure');
        const rename = jest
          .spyOn(fsPromises, 'rename')
          .mockRejectedValueOnce(error);
        await expect(projection('reset')).rejects.toBe(error);
        // The failed install and automatic rollback must both reach the real writer.
        expect(rename).toHaveBeenCalledTimes(2);
        for (const [, destination] of rename.mock.calls)
          expect(destination).toBe(path);
        expect(await readFile(path, 'utf8')).toBe(bytes);
      },
    );
    test('failed reset restores a valid previous state (fault control)', async () => {
      const path = join(directory, 'browser-state.json');
      await writeFile(path, JSON.stringify(previousState));
      const error = new Error('R8 injected pre-install rename failure');
      expect(
        loadWorktreeBrowserState(
          SHARED_CONTAINER_VIEWER_PROJECT_ID,
          containerId,
        ).status,
      ).toBe('loaded');
      const rename = jest
        .spyOn(fsPromises, 'rename')
        .mockRejectedValueOnce(error);
      await expect(projection('reset')).rejects.toBe(error);
      expect(rename).toHaveBeenCalledTimes(2);
      for (const [, destination] of rename.mock.calls)
        expect(destination).toBe(path);
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify(previousState));
      expect(
        (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
    });
  });

  test('fallback browser seed still projects independent file and chat panels', async () => {
    const path = join(directory, 'browser-state.json');
    await writeFile(path, '{broken');
    const applied = await applyInitialSharedContainerViewerLayout({
      containerId,
      layout: {
        orientation: 0,
        root: {
          type: 'leaf',
          size: 1,
          activeTabIndex: 0,
          tabs: [
            { kind: 'browser', url: 'https://example.invalid/' },
            { kind: 'chat', chatId: 'chat' },
            {
              kind: 'file',
              repoId: 'repo',
              relativePath: 'readme.md',
              viewMode: 'rich',
            },
          ],
        },
      },
      roots: [
        {
          repoId: 'repo',
          repoName: 'Repo',
          absolutePath: directory,
          revisionRoot: directory,
          revisionId: 'rev',
        },
      ],
      publishedPathsByRepo: new Map([['repo', new Set(['readme.md'])]]),
      chatIds: new Set(['chat']),
    });
    expect(applied.applied).toBe(true);
    expect(applied.fileTabs).toHaveLength(1);
    expect(applied.activeTabId).toBe('chat');
    const layout = migratePanelLayout(
      panelLayoutPersistenceStore.loadWorktreeLayout(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        containerId,
      ),
    );
    expect(layout?.grid.root).toMatchObject({
      type: 'leaf',
      panels: [{ kind: 'chat' }, { kind: 'file-diff' }],
    });
    expect(await readFile(path, 'utf8')).toBe('{broken');
    await applied.rollback();
    expect(
      panelLayoutPersistenceStore.loadWorktreeLayout(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        containerId,
      ),
    ).toBeNull();
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });

  test('reset preimage capture waits for a browser save already holding workspace ownership', async () => {
    const path = join(directory, 'browser-state.json');
    await writeFile(path, '{old');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const saving = saveWorktreeBrowserState(
      {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: containerId,
        state: {
          version: 2,
          browsers: [],
          browserOrder: [],
          activeBrowserId: null,
        },
      },
      async (write): Promise<void> => {
        entered.resolve();
        await release.promise;
        await write();
      },
    );
    await entered.promise;
    const reads = jest.spyOn(fsPromises, 'readFile');
    const capturing = captureWorktreeBrowserStateRollback(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      containerId,
    );
    try {
      expect(reads).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await saving;
      const previous = await readFile(path);
      const rollback = await capturing;
      await writeFile(path, '{reset');
      await rollback();
      expect(await readFile(path)).toEqual(previous);
    }
  });

  test('reset rollback preserves non-UTF8 bytes rather than decoding them', async () => {
    const path = join(directory, 'browser-state.json');
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    await writeFile(path, bytes);
    const applied = await projection('reset');
    await applied.rollback();
    expect(await readFile(path)).toEqual(bytes);
  });
  test('reset rollback restores an absent state instead of creating an empty state', async () => {
    const path = join(directory, 'browser-state.json');
    const applied = await projection('reset');
    expect((await readFile(path)).length).toBeGreaterThan(0);
    await applied.rollback();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('failed reset restores absence', async () => {
    const path = join(directory, 'browser-state.json');
    jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(new Error('rename failed'));
    await expect(projection('reset')).rejects.toThrow('rename failed');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('failed reset restores bytes captured before browser shutdown changes them', async () => {
    const path = join(directory, 'browser-state.json');
    const bytes = '{broken before shutdown';
    await writeFile(path, bytes);
    jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(new Error('rename failed'));
    await expect(
      projection('reset', async () => {
        await writeFile(path, 'shutdown changed this state');
      }),
    ).rejects.toThrow('rename failed');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
  test('an unreadable reset preimage refuses before stopping browsers or publishing layout', async () => {
    const path = join(directory, 'browser-state.json');
    await mkdir(path);
    const stop = jest.fn();
    await expect(projection('reset', stop)).rejects.toThrow();
    expect(stop).not.toHaveBeenCalled();
    expect(
      panelLayoutPersistenceStore.loadWorktreeLayout(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        containerId,
      ),
    ).toBeNull();
    expect(await readdir(path)).toEqual([]);
  });
  test('an unreadable seed preimage skips browser and layout publication', async () => {
    const path = join(directory, 'browser-state.json');
    await mkdir(path);
    expect((await projection('seed')).applied).toBe(false);
    expect(await readdir(path)).toEqual([]);
  });
  test('reset rollback restores an unmigrated v1 preimage byte-for-byte', async () => {
    const path = join(directory, 'browser-state.json');
    const bytes =
      '{ "version":1,"browsers":[],"groups":[],"activeGroupId":null }';
    await writeFile(path, bytes);
    const applied = await projection('reset');
    await applied.rollback();
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  test('browser bytes restore even if panel layout rollback fails', async () => {
    const path = join(directory, 'browser-state.json');
    const bytes = '{broken before reset';
    await writeFile(path, bytes);
    const applied = await projection('reset');
    jest
      .spyOn(panelLayoutPersistenceStore, 'deleteWorktreeLayout')
      .mockImplementationOnce(() => {
        throw new Error('layout rollback failed');
      });
    await expect(applied.rollback()).rejects.toThrow('layout rollback failed');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
});
