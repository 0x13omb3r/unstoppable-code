// CAN-4492: bounded legacy-store qualification and current-owner admission.
import { fork } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as StorageAuthority from '@canopy/core-runtime/storage';
import type * as CanopyPaths from '@canopy/execution-engine/canopy-paths';
import {
  writeFileAtomically,
  writeFileAtomicallySync,
} from '@canopy/execution-engine/node/lib/atomic-file';
import {
  admittedStorageRowForPath,
  admittedStorageRowForWrite,
  isAdmittedStorageCandidate,
} from '@canopy/execution-engine/node/lib/admitted-storage-paths';
import type * as FileSystem from 'node:fs/promises';
import type * as SyncFileSystem from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  configure,
  deliver,
  destination,
  fire,
  mockDirectory,
  mockDirectorySync,
  mockEnqueued,
  mockRename,
  register,
  resetRename,
  service,
  setDirectory,
} from './watcher-store.fixture';
import {
  readCanonicalWatcherStore,
  writeCanonicalWatcherStore,
} from '../app-advisor/chat-watcher-storage';
import { DelegationNoticeAckStore } from '../agents/delegation/notice-acks';
import { migrateDelegateWatchersToNotices } from '../agents/delegation/notice-migration';

const legacy = 'app-advisor-watchers.json';
const canonical = 'app-advisor-watchers-canonical.json';
const watcherModule = 'main/app-advisor/watchers';
const installerModule = 'main/app-advisor/chat-watcher-storage';
const stores = [
  { name: legacy, namespace: 'app_advisor_watchers' },
  { name: canonical, namespace: 'app_advisor_watchers_canonical' },
] as const;
const forbiddenWriters = [
  { writer: 'daemon', module: watcherModule, reason: 'unlisted_writer' },
  { writer: 'desktop_cli', module: watcherModule, reason: 'unlisted_writer' },
  { writer: 'renderer', module: watcherModule, reason: 'unlisted_writer' },
  {
    writer: 'electron_main',
    module: `${watcherModule}-other`,
    reason: 'unadmitted_writer',
  },
] as const;
const assertAdmission = StorageAuthority.assertAdmittedWriter;

jest.mock('@canopy/execution-engine/canopy-paths', () => ({
  ...jest.requireActual<typeof CanopyPaths>(
    '@canopy/execution-engine/canopy-paths',
  ),
  // cli-runtime reads this while the fixture's imports are still initializing.
  getCanopyDataDir: (): string =>
    process.env.CAN4492_ROOT ??
    process.env.CANOPY_DATA_DIR ??
    process.env.TMPDIR ??
    '.',
}));
const storeSchema = z
  .object({ watchers: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();
const rowSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    pendingLocalDelivery: z
      .object({ deliveryId: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();
type Store = z.infer<typeof storeSchema>;
type Row = z.infer<typeof rowSchema>;
interface ChildResult {
  pid: number;
  calls: string[];
  rows: Row[];
  activeIds: string[];
}

async function disk(name: string): Promise<Store> {
  return storeSchema.parse(
    JSON.parse(await readFile(join(mockDirectory, name), 'utf8')),
  );
}
async function seed(
  name: string,
  watchers: unknown[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(mockDirectory, name),
    JSON.stringify({ version: 1, watchers, ...extra }),
  );
}
function gate(): PromiseWithResolvers<void> {
  return Promise.withResolvers<void>();
}

// Each stage is a separate Jest OS process, with the real service and private files.
async function child(
  stage: string,
  root: string,
  committed = false,
  isCanonical = false,
): Promise<ChildResult> {
  const processChild = fork(
    require.resolve('jest/bin/jest'),
    [
      '--runInBand',
      '--runTestsByPath',
      __filename,
      '--testNamePattern=child stage',
    ],
    {
      env: {
        ...process.env,
        CAN4492_STAGE: stage,
        CAN4492_CANONICAL: isCanonical ? '1' : '0',
        CAN4492_ROOT: root,
        CAN4492_COMMITTED: committed ? '1' : '0',
        CANOPY_DATA_DIR: root,
        CANOPY_SECURE_DATA_DIR: join(root, 'secure'),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  let stdout = '';
  processChild.stdout?.on('data', (bytes) => {
    stdout += String(bytes);
    output += String(bytes);
  });
  processChild.stderr?.on('data', (bytes) => {
    output += String(bytes);
  });
  const persisted = gate();
  processChild.stdout?.on('data', () => {
    if (stdout.includes('CAN4492_PENDING_PERSISTED\n')) persisted.resolve();
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => processChild.kill('SIGKILL'), 45_000);
  try {
    if (stage === 'hold') {
      await Promise.race([
        persisted.promise,
        exited.then(() => {
          throw new Error(`Child exited before persisted barrier: ${output}`);
        }),
      ]);
      processChild.kill('SIGKILL');
      const { signal } = await exited;
      expect(signal).toBe('SIGKILL');
    } else {
      const { code } = await exited;
      if (code !== 0)
        throw new Error(`Child ${stage} failed (${String(code)}): ${output}`);
    }
  } finally {
    clearTimeout(timeout);
    if (processChild.exitCode === null && processChild.signalCode === null) {
      processChild.kill('SIGKILL');
      await exited;
    }
  }
  return z
    .object({
      pid: z.number(),
      calls: z.array(z.string()),
      rows: z.array(rowSchema),
      activeIds: z.array(z.string()),
    })
    .parse(
      JSON.parse(await readFile(join(root, `result-${stage}.json`), 'utf8')),
    );
}

if (process.env.CAN4492_STAGE) {
  it('child stage', async () => {
    const stage = process.env.CAN4492_STAGE;
    const isCanonical = process.env.CAN4492_CANONICAL === '1';
    configure();
    const result = async (): Promise<void> => {
      const rows = rowSchema
        .array()
        .parse(
          (await disk(isCanonical ? canonical : legacy)).watchers.filter(
            (row) => typeof row.id === 'string',
          ),
        );
      await writeFile(
        join(mockDirectory, `result-${stage}.json`),
        JSON.stringify({
          pid: process.pid,
          calls: deliver.mock.calls.map(([value]) => value.deliveryId),
          rows,
          activeIds: (await service.list()).map((row) => row.id),
        }),
      );
    };
    if (stage === 'hold') {
      const setup = await register(isCanonical);
      expect(setup.ok).toBe(true);
      deliver.mockImplementation(async () => {
        const rows = rowSchema
          .array()
          .parse(
            (await disk(isCanonical ? canonical : legacy)).watchers.filter(
              (row) => typeof row.id === 'string',
            ),
          );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.pendingLocalDelivery?.deliveryId).toEqual(
          expect.any(String),
        );
        await result();
        process.stdout.write('CAN4492_PENDING_PERSISTED\n');
        await new Promise<void>(() => undefined);
        return 'submitted';
      });
      await fire(isCanonical);
      throw new Error(
        `Event path returned before crash barrier: ${JSON.stringify(await disk(isCanonical ? canonical : legacy))}`,
      );
    } else if (stage === 'inspect') {
      // Read without recovery, including states installed by a rejected caller.
      await service.list();
      await result();
    } else {
      await service.reconcileAtStartup();
      await result();
    }
    service.shutdown();
    await service.drain();
  }, 60_000);
} else {
  beforeEach(async () => {
    setDirectory(await mkdtemp(join(tmpdir(), 'watcher-store-')));
    // The async writer can cache the bootstrap getter before per-test setup.
    jest.replaceProperty(process.env, 'CANOPY_DATA_DIR', mockDirectory);
    resetRename();
    configure();
  });
  afterEach(async () => {
    service.shutdown();
    await service.drain();
    jest.restoreAllMocks();
    jest.useRealTimers();
    await rm(mockDirectory, { recursive: true, force: true });
  });

  it.each(stores)(
    'admits only the curated Electron modules for $namespace',
    ({ namespace }) => {
      const row = StorageAuthority.STORAGE_OWNERSHIP.find(
        (row) => row.id === namespace,
      );
      expect(row).toMatchObject({
        transitionOwner: 'legacy',
        currentWriters: ['electron_main'],
        admittedWriters:
          namespace === 'app_advisor_watchers'
            ? [watcherModule]
            : [watcherModule, installerModule],
      });
      expect(() =>
        assertAdmission(
          namespace,
          'electron_main',
          watcherModule,
          StorageAuthority.STORAGE_OWNERSHIP,
        ),
      ).not.toThrow();
      for (const identity of forbiddenWriters) {
        expect(() =>
          assertAdmission(
            namespace,
            identity.writer,
            identity.module,
            StorageAuthority.STORAGE_OWNERSHIP,
          ),
        ).toThrow(
          new StorageAuthority.StorageWriteRefusedError(
            namespace,
            `${identity.writer} (${identity.module})`,
            identity.reason,
          ),
        );
      }
      const install = (): void =>
        assertAdmission(
          namespace,
          'electron_main',
          installerModule,
          StorageAuthority.STORAGE_OWNERSHIP,
        );
      if (namespace === 'app_advisor_watchers')
        expect(install).toThrow(/unadmitted_writer/);
      else expect(install).not.toThrow();
    },
  );

  it.each(
    stores.flatMap((store) =>
      forbiddenWriters.map((identity) => ({ ...store, ...identity })),
    ),
  )(
    'preflights $namespace against $writer/$module before paired filesystem effects',
    async ({
      namespace,
      writer: forbiddenWriter,
      module: forbiddenModule,
      reason,
    }) => {
      await rm(mockDirectory, { recursive: true });
      const fs = jest.requireMock<typeof FileSystem>('node:fs/promises');
      const mkdirSpy = jest.spyOn(fs, 'mkdir');
      const openSpy = jest.spyOn(fs, 'open');
      const guard = jest
        .spyOn(StorageAuthority, 'assertAdmittedWriter')
        .mockImplementation((id, writer, module, rows) => {
          // Inject a forbidden identity while retaining the real policy.
          assertAdmission(
            id,
            id === namespace ? forbiddenWriter : writer,
            id === namespace ? forbiddenModule : module,
            rows,
          );
        });
      await expect(register()).rejects.toMatchObject({
        namespaceId: namespace,
        reason,
      });
      expect(guard).toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      await expect(readdir(mockDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await mkdir(mockDirectory);
      await seed(legacy, []);
      await seed(canonical, []);
      const before = await Promise.all(
        stores.map(({ name }) => readFile(join(mockDirectory, name), 'utf8')),
      );
      mkdirSpy.mockClear();
      openSpy.mockClear();
      await expect(
        register(false, 'existing-target-refusal'),
      ).rejects.toMatchObject({
        namespaceId: namespace,
        reason,
      });
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(
        await Promise.all(
          stores.map(({ name }) => readFile(join(mockDirectory, name), 'utf8')),
        ),
      ).toEqual(before);
      expect((await readdir(mockDirectory)).sort()).toEqual(
        [legacy, canonical].sort(),
      );
      guard.mockRestore();
      await register(false, 'admitted-paired-control');
      expect(mkdirSpy).toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalled();
    },
  );

  it.each(forbiddenWriters)(
    'canonical-only installer refuses $writer/$module before any filesystem effects',
    async (identity) => {
      await rm(mockDirectory, { recursive: true });
      const fs = jest.requireMock<typeof FileSystem>('node:fs/promises');
      const readSpy = jest.spyOn(fs, 'readFile');
      const mkdirSpy = jest.spyOn(fs, 'mkdir');
      const openSpy = jest.spyOn(fs, 'open');
      const guard = jest
        .spyOn(StorageAuthority, 'assertAdmittedWriter')
        .mockImplementation((id, _writer, _module, rows) => {
          assertAdmission(id, identity.writer, identity.module, rows);
        });
      const target = join(mockDirectory, canonical);
      await expect(
        writeCanonicalWatcherStore(target, []),
      ).rejects.toMatchObject({
        namespaceId: 'app_advisor_watchers_canonical',
        reason: identity.reason,
      });
      expect(readSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      await expect(readdir(mockDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await mkdir(mockDirectory);
      await writeFile(target, 'original');
      mkdirSpy.mockClear();
      await expect(
        writeCanonicalWatcherStore(target, []),
      ).rejects.toMatchObject({
        reason: identity.reason,
      });
      expect(readSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(await readFile(target, 'utf8')).toBe('original');
      expect(await readdir(mockDirectory)).toEqual([canonical]);
      await seed(canonical, []);
      readSpy.mockClear();
      guard.mockRestore();
      await writeCanonicalWatcherStore(target, []);
      expect(readSpy).toHaveBeenCalled();
      expect(mkdirSpy).toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalled();
    },
  );

  it.each(stores)(
    'classifies $name at the correct root, not unrelated roots or temporary siblings',
    ({ name, namespace }) => {
      const target = join(mockDirectory, name);
      expect(isAdmittedStorageCandidate(target)).toBe(true);
      expect(admittedStorageRowForPath(target, mockDirectory)).toBe(namespace);
      expect(
        admittedStorageRowForPath(target.toUpperCase(), mockDirectory),
      ).toBe(namespace);
      expect(admittedStorageRowForPath(target, null)).toBe(namespace);
      expect(
        admittedStorageRowForPath(target, join(mockDirectory, 'other')),
      ).toBeUndefined();
      expect(
        admittedStorageRowForPath(
          join(mockDirectory, 'nested', name),
          mockDirectory,
        ),
      ).toBeUndefined();
      expect(isAdmittedStorageCandidate(`${target}.tmp`)).toBe(false);
      expect(
        admittedStorageRowForPath(`${target}.tmp`, mockDirectory),
      ).toBeUndefined();
    },
  );

  it.each(stores)(
    'real async and sync shared writers refuse $name without admission and leave no target/temp effects',
    async ({ name, namespace }) => {
      const target = join(mockDirectory, name);
      const refusal = { namespaceId: namespace, reason: 'unadmitted_writer' };
      await expect(admittedStorageRowForWrite(target)).resolves.toBe(namespace);
      // atomic-file loads before the fixture installs its rename-only fs mock.
      const openSpy = jest.spyOn(
        jest.requireActual<typeof FileSystem>('node:fs/promises'),
        'open',
      );
      const openSyncSpy = jest.spyOn(
        jest.requireActual<typeof SyncFileSystem>('node:fs'),
        'openSync',
      );
      for (const exists of [false, true]) {
        if (exists) await writeFile(target, 'original');
        const before = await readdir(mockDirectory);
        await expect(
          writeFileAtomically(target, 'replacement'),
        ).rejects.toMatchObject(refusal);
        expect(() => writeFileAtomicallySync(target, 'replacement')).toThrow(
          new StorageAuthority.StorageWriteRefusedError(
            namespace,
            'undeclared',
            'unadmitted_writer',
          ),
        );
        for (const identity of forbiddenWriters) {
          const options = {
            admittedWriter: {
              namespace,
              writer: identity.writer,
              module: identity.module,
            },
          };
          await expect(
            writeFileAtomically(target, 'replacement', options),
          ).rejects.toMatchObject({ reason: identity.reason });
          expect(() =>
            writeFileAtomicallySync(target, 'replacement', options),
          ).toThrow(
            new StorageAuthority.StorageWriteRefusedError(
              namespace,
              `${identity.writer} (${identity.module})`,
              identity.reason,
            ),
          );
        }
        expect(await readdir(mockDirectory)).toEqual(before);
        if (exists) expect(await readFile(target, 'utf8')).toBe('original');
      }
      expect(openSpy).not.toHaveBeenCalled();
      expect(openSyncSpy).not.toHaveBeenCalled();
      const options = {
        admittedWriter: {
          namespace,
          writer: 'electron_main',
          module: watcherModule,
        },
      } as const;
      await writeFileAtomically(target, 'admitted async', options);
      expect(await readFile(target, 'utf8')).toBe('admitted async');
      expect(openSpy).toHaveBeenCalled();
      writeFileAtomicallySync(target, 'admitted sync', options);
      expect(await readFile(target, 'utf8')).toBe('admitted sync');
      expect(openSyncSpy).toHaveBeenCalled();
    },
  );

  it.each(stores)(
    'async unrelated-root writes remain ordinary; sync shape guard still refuses $name',
    async ({ name }) => {
      const other = join(mockDirectory, 'other');
      await mkdir(other);
      const target = join(other, name);
      await writeFileAtomically(target, 'unrelated');
      expect(() => writeFileAtomicallySync(target, 'replacement')).toThrow(
        /unadmitted_writer/,
      );
      expect(await readFile(target, 'utf8')).toBe('unrelated');
      expect(await readdir(other)).toEqual([name]);
    },
  );

  it.each([false, true])(
    'recovers a production-created outbox in process B; C suppresses terminal replay (canonical=%s)',
    async (isCanonical) => {
      const root = mockDirectory;
      const a = await child('hold', root, false, isCanonical);
      const b = await child('recover', root, false, isCanonical);
      const c = await child('recover', root, false, isCanonical);
      expect(new Set([a.pid, b.pid, c.pid]).size).toBe(3);
      expect(b.calls).toEqual([a.rows[0]?.pendingLocalDelivery?.deliveryId]);
      expect(b.rows[0]).toMatchObject({ id: a.rows[0]?.id, status: 'fired' });
      expect(c.calls).toEqual([]);
      expect(c.rows[0]?.status).toBe('fired');
      if (isCanonical) {
        expect((await disk(canonical)).watchers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'chat_delivery_authority' }),
          ]),
        );
        expect((await disk(legacy)).watchers).toEqual([]);
      }
    },
    180_000,
  );

  it('suppresses committed canonical input before terminal persistence, and obsolete pending bytes on terminal rows', async () => {
    const root = mockDirectory;
    const a = await child('hold', root, false, true);
    const b = await child('recover', root, true, true);
    expect(b.calls).toEqual([]);
    expect(b.rows[0]).toMatchObject({ id: a.rows[0]?.id, status: 'fired' });
    const saved = await disk(canonical);
    await seed(
      canonical,
      saved.watchers.map((row) =>
        row.id === a.rows[0]?.id
          ? { ...row, pendingLocalDelivery: a.rows[0]?.pendingLocalDelivery }
          : row,
      ),
    );
    expect((await child('recover', root, false, true)).calls).toEqual([]);
  }, 180_000);

  it.each([false, true])(
    'serializes overlapping registration and replay-key deduplication (canonical=%s)',
    async (isCanonical) => {
      const entered = gate(),
        release = gate();
      mockRename.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return jest
          .requireActual<typeof FileSystem>('node:fs/promises')
          .rename(...args);
      });
      const first = register(isCanonical);
      await entered.promise;
      const queued = gate();
      mockEnqueued.mockImplementation((depth) => {
        if (depth > 0) queued.resolve();
      });
      const second = register(isCanonical);
      try {
        await queued.promise;
      } finally {
        release.resolve();
      }
      const created = await first;
      const deduped = await second;
      expect(created.ok).toBe(true);
      expect(deduped.ok).toBe(true);
      if (!created.ok || !deduped.ok) throw new Error('Registration failed');
      expect(created.results[0]?.status).toBe('created');
      expect(deduped.results[0]?.status).toBe('deduped');
      expect(deduped.results[0]?.watcher.id).toBe(
        created.results[0]?.watcher.id,
      );
      expect(await service.list()).toHaveLength(1);
      expect(
        (await disk(isCanonical ? canonical : legacy)).watchers.filter(
          (row) => row.id,
        ),
      ).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'app-advisor:watchers-list backing service retains old bytes and warm/fresh rows after rename rejection; next mutation succeeds (canonical=%s)',
    async (isCanonical) => {
      const name = isCanonical ? canonical : legacy;
      await register(isCanonical);
      const old = await readFile(join(mockDirectory, name), 'utf8');
      const actualRename =
        jest.requireActual<typeof FileSystem>('node:fs/promises').rename;
      mockRename.mockImplementation(async (...args) => {
        if (args[1] === join(mockDirectory, name)) {
          mockRename.mockImplementation(actualRename);
          throw new Error('injected rename');
        }
        return actualRename(...args);
      });
      await expect(
        service.deleteWatcher(
          rowSchema.parse((await disk(name)).watchers[0]).id,
        ),
      ).rejects.toThrow('injected rename');
      expect(await readFile(join(mockDirectory, name), 'utf8')).toBe(old);
      expect(await service.list()).toHaveLength(1);
      const fresh = await child('inspect', mockDirectory, false, isCanonical);
      expect(fresh.rows).toHaveLength(1);
      expect(fresh.activeIds).toEqual([
        rowSchema.parse((await disk(name)).watchers[0]).id,
      ]);
      await service.deleteWatcher(
        rowSchema.parse((await disk(name)).watchers[0]).id,
      );
      expect(await service.list()).toEqual([]);
    },
    60_000,
  );

  it.each([false, true])(
    'post-rename directory-sync rejection still installs deletion for warm and fresh readers (canonical=%s)',
    async (isCanonical) => {
      await register(isCanonical);
      const name = isCanonical ? canonical : legacy;
      const id = rowSchema.parse((await disk(name)).watchers[0]).id;
      const actualRename =
        jest.requireActual<typeof FileSystem>('node:fs/promises').rename;
      let injected = false;
      mockRename.mockImplementation(async (...args) => {
        await actualRename(...args);
        if (args[1] === join(mockDirectory, name) && !injected) {
          injected = true;
          mockDirectorySync.mockRejectedValueOnce(
            new Error('post-rename sync'),
          );
        }
      });
      await expect(service.deleteWatcher(id)).rejects.toThrow(
        'post-rename sync',
      );
      expect(injected).toBe(true);
      expect(
        (await disk(name)).watchers.filter((row) => row.id === id),
      ).toEqual([]);
      expect(await service.list()).toEqual([]);
      const fresh = await child('inspect', mockDirectory, false, isCanonical);
      expect(fresh.rows).toEqual([]);
      expect(fresh.activeIds).toEqual([]);
      expect((await register(isCanonical, 'after-sync-failure')).ok).toBe(true);
      expect(await service.list()).toHaveLength(1);
    },
    60_000,
  );

  it('app-advisor:watchers-completed-list backing service retains a separate 50-row history, 200 completed rows and 24h tool receipts', async () => {
    await register();
    const template = (await disk(legacy)).watchers[0];
    const now = Date.UTC(2026, 10, 14);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const rows = Array.from({ length: 201 }, (_, index) => ({
      ...template,
      id: `done-${index}`,
      status: 'fired',
      createdByToolUseId: undefined,
      firedAt: new Date(now - index * 1000).toISOString(),
    }));
    const receipts = [-1, 0, 1].map((offset) => ({
      ...template,
      id: `receipt-${offset}`,
      status: 'fired',
      createdByToolUseId: `tool-${offset}`,
      firedAt: new Date(now - 86_400_000 + offset).toISOString(),
    }));
    await seed(legacy, [...rows, ...receipts]);
    expect(await service.listCompleted()).toHaveLength(50);
    await register(true, 'persist-retention');
    const retained = (await disk(legacy)).watchers.map((row) => row.id);
    expect(retained).toHaveLength(202);
    expect(retained).not.toContain('done-200');
    expect(retained).not.toContain('receipt--1');
    expect(retained).toEqual(
      expect.arrayContaining(['receipt-0', 'receipt-1']),
    );
  });

  it('retains opaque sidecar data, unreleased and malformed releases, seven-day/500 receipts, and reservation array tails', async () => {
    const now = Date.UTC(2026, 10, 14);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const receipts = Array.from({ length: 501 }, (_, index) => ({
      kind: 'chat_delivery_authority',
      tag: index,
      released: true,
      releasedAt: new Date(now - index).toISOString(),
    }));
    const exceptional = [
      { kind: 'chat_delivery_authority', tag: 'unreleased' },
      {
        kind: 'chat_delivery_authority',
        released: true,
        releasedAt: 'invalid',
      },
      { kind: 'future', data: [1, 2] },
    ];
    const reservations = Array.from({ length: 501 }, (_, index) => ({
      kind: 'inline_chat_reservation',
      reservationId: `r-${index}`,
      commandId: `c-${index}`,
      acceptedInputId: 'input',
      target: {
        projectId: 'project-1',
        taskId: 'worktree-1',
        chatId: 'target',
      },
      destination,
      state: 'confirmed',
      receipts: [],
    }));
    const cutoff = now - 7 * 86_400_000;
    await seed(
      canonical,
      [
        ...receipts,
        ...exceptional,
        ...reservations,
        { ...reservations[0], reservationId: 'pending', state: 'pending' },
        ...[-1, 0, 1].map((offset) => ({
          kind: 'chat_delivery_authority',
          tag: `boundary-${offset}`,
          released: true,
          releasedAt: new Date(cutoff + offset).toISOString(),
        })),
      ],
      { futureEnvelope: { keep: true } },
    );
    await register();
    const saved = await disk(canonical);
    expect(saved.futureEnvelope).toEqual({ keep: true });
    expect(saved.watchers).toEqual(expect.arrayContaining(exceptional));
    expect(
      saved.watchers.filter((row) => typeof row.tag === 'number'),
    ).toHaveLength(500);
    expect(saved.watchers.some((row) => row.tag === 500)).toBe(false);
    expect(saved.watchers.some((row) => row.reservationId === 'r-0')).toBe(
      false,
    );
    expect(saved.watchers.some((row) => row.reservationId === 'r-1')).toBe(
      true,
    );
    expect(saved.watchers.some((row) => row.reservationId === 'pending')).toBe(
      true,
    );
    // Isolate the time boundary from the independent 500-entry cap.
    await seed(
      canonical,
      [-1, 0, 1].map((offset) => ({
        kind: 'chat_delivery_authority',
        tag: offset,
        released: true,
        releasedAt: new Date(cutoff + offset).toISOString(),
      })),
    );
    await register(true);
    expect(
      (await disk(canonical)).watchers
        .filter((row) => typeof row.tag === 'number')
        .map((row) => row.tag),
    ).toEqual([0, 1]);
  });

  it.each([legacy, canonical])(
    'pins missing, malformed, and unsupported-envelope behavior for %s',
    async (name) => {
      expect(await service.list()).toEqual([]);
      await writeFile(join(mockDirectory, name), '{');
      await expect(service.list()).rejects.toThrow();
      await seed(name, [], { version: 2 });
      if (name === canonical) {
        await expect(service.list()).rejects.toThrow('unsupported format');
        await expect(register()).rejects.toThrow('unsupported format');
        expect(
          JSON.parse(await readFile(join(mockDirectory, name), 'utf8')),
        ).toMatchObject({ version: 2 });
      } else {
        expect(await service.list()).toEqual([]);
        expect((await register()).ok).toBe(true);
        expect(
          JSON.parse(await readFile(join(mockDirectory, name), 'utf8')),
        ).toMatchObject({ version: 1 });
      }
    },
  );

  it('receipt release failure retains authority through another mutation; a later explicit release succeeds', async () => {
    expect((await register(true)).ok).toBe(true);
    await fire(true);
    const [call] = deliver.mock.calls;
    if (!call) throw new Error('No canonical submission');
    const deliveryId = call[0].deliveryId;
    const receipt = (await disk(canonical)).watchers.find(
      (row) => row.kind === 'chat_delivery_authority',
    );
    expect(receipt).toBeDefined();
    mockRename.mockImplementationOnce(() =>
      Promise.reject(new Error('release rename')),
    );
    await expect(
      service.releaseChatDeliveryAuthority(deliveryId),
    ).rejects.toThrow('release rename');
    expect((await disk(canonical)).watchers).toContainEqual(receipt);
    await register(false, 'after-release-failure');
    expect((await disk(canonical)).watchers).toContainEqual(receipt);
    await Promise.all([
      service.releaseChatDeliveryAuthority(deliveryId),
      register(false, 'concurrent-release'),
    ]);
    const released = (await disk(canonical)).watchers.find(
      (row) => row.kind === 'chat_delivery_authority',
    );
    expect(released?.released).toBe(true);
    expect(released?.releasedAt).toEqual(expect.any(String));
  });

  it('shutdown drain does not join a pending chat submission; its outbox remains durable', async () => {
    await register(true);
    const entered = gate(),
      release = gate();
    deliver.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return 'submitted';
    });
    const delivery = fire(true);
    await entered.promise;
    try {
      service.shutdown();
      await service.drain();
      const pending = rowSchema.parse(
        (await disk(canonical)).watchers.find((row) => row.status === 'firing'),
      );
      expect(pending.status).toBe('firing');
      expect(pending.pendingLocalDelivery?.deliveryId).toEqual(
        expect.any(String),
      );
    } finally {
      release.resolve();
      await delivery;
    }
  });

  it('canonical installer preserves supplied opaque rows but does not rescue omitted rows', async () => {
    const path = join(mockDirectory, canonical);
    await writeCanonicalWatcherStore(path, [{ future: true }]);
    expect(await readCanonicalWatcherStore(path)).toEqual([{ future: true }]);
    await writeCanonicalWatcherStore(path, []);
    expect(await readCanonicalWatcherStore(path)).toEqual([]);
  });

  it('flushes retired-delegate notice evidence before removal, and retries after a removal failure', async () => {
    const retired = {
      id: 'retired',
      trigger: 'managed_delegation_completion',
      status: 'firing',
      target: {
        kind: 'managed_delegation',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
      runtimeState: {
        kind: 'managed_delegation',
        targets: [
          { delegationId: 'delegate', runGeneration: 1, resultIndex: 1 },
        ],
      },
    };
    await seed(legacy, [retired, { invalid: true }]);
    const store = new DelegationNoticeAckStore(mockDirectory);
    await store.load();
    const options = {
      store,
      records: [],
      watchers: {
        list: (): ReturnType<typeof service.listLegacyDelegateWatchers> =>
          service.listLegacyDelegateWatchers(destination),
        remove: (): Promise<void> =>
          Promise.reject(new Error('crash cut after notice flush')),
      },
    };
    await expect(migrateDelegateWatchersToNotices(options)).rejects.toThrow(
      'crash cut',
    );
    expect((await disk(legacy)).watchers).toContainEqual(retired);
    const reopened = new DelegationNoticeAckStore(mockDirectory);
    await reopened.load();
    expect(reopened.owed()).toHaveLength(1);
    expect(
      await migrateDelegateWatchersToNotices({
        ...options,
        store: reopened,
        watchers: {
          ...options.watchers,
          remove: (ids) => service.removeLegacyDelegateWatchers(ids),
        },
      }),
    ).toEqual({ owed: 0, removed: 1 });
    expect(reopened.owed()).toHaveLength(1);
    expect((await disk(legacy)).watchers).toEqual([]);
  });
}
