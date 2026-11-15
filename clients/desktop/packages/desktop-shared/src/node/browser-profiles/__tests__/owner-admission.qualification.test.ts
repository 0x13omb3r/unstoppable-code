import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import * as atomic from '@canopy/execution-engine/node/lib/atomic-file';
import { BrowserProfileRepository } from '../repository';

jest.setTimeout(15_000);

// Migration evidence for the browser_profiles row; processes use the real lease and files.
describe('browser profile owner/admission qualification', () => {
  let directory: string;
  let root: string;
  let repository: BrowserProfileRepository;
  const children = new Set<ChildProcess>();

  function start(
    action: 'read' | 'write' | 'task',
    id: string = randomUUID(),
    checkpoint = '',
    path = root,
  ): {
    child: ChildProcess;
    exited: Promise<void>;
    message: () => Promise<unknown>;
  } {
    const child = fork(
      join(__dirname, 'fixtures/profile-writer.ts'),
      [path, action, id, checkpoint],
      {
        execArgv: ['--require', 'tsx/cjs'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.add(child);
    const messages: unknown[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('message', (message: unknown) => {
      messages.push(message);
      wake?.();
    });
    const exited = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        children.delete(child);
        failure = error;
        wake?.();
        resolve();
      });
      child.once('exit', (code, signal) => {
        children.delete(child);
        failure = new Error(
          `Writer exited (${String(code)}, ${String(signal)}): ${stderr}`,
        );
        wake?.();
        resolve();
      });
    });
    return {
      child,
      exited,
      async message(): Promise<unknown> {
        while (!messages.length) {
          if (failure) throw failure;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        return messages.shift();
      },
    };
  }

  async function image(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(root, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (
        entry.isFile() &&
        !['writer.lock', 'reclaim.lock'].includes(entry.name)
      ) {
        const path = join(entry.parentPath, entry.name);
        result[path.slice(root.length)] = (await readFile(path)).toString(
          'base64',
        );
      }
    }
    return result;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'browser-r7-'));
    root = join(directory, 'browser-profiles');
    repository = new BrowserProfileRepository(root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(
      [...children].map(async (child) => {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }),
    );
    await rm(directory, { recursive: true, force: true });
  });

  test.each([false, true])(
    'live process refuses readers and writers, then explicit retry succeeds (alias=%s)',
    async (alias) => {
      await repository.createNamed('seed', { displayName: 'seed' });
      const holder = start('write', 'holder', 'journal');
      expect(await holder.message()).toEqual({ checkpoint: 'journal' });
      const before = await image();
      const lease = await readFile(join(root, 'writer.lock'), 'utf8');
      let contenderRoot = root;
      if (alias) {
        contenderRoot = join(directory, 'alias');
        await symlink(
          root,
          contenderRoot,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      for (const action of ['read', 'write'] as const) {
        const contender = start(action, 'contender', '', contenderRoot);
        expect(await contender.message()).toEqual({
          error: 'storage_unavailable',
        });
        await contender.exited;
        expect(await image()).toEqual(before);
        expect(await readFile(join(root, 'writer.lock'), 'utf8')).toBe(lease);
      }
      holder.child.send('continue');
      expect(await holder.message()).toHaveProperty('result');
      await holder.exited;
      const retry = start('write', 'contender', '', contenderRoot);
      expect(await retry.message()).toHaveProperty('result');
      await retry.exited;
      expect(
        (await repository.list()).map((p) => p.displayName).sort(),
      ).toEqual(['contender', 'holder', 'seed']);
    },
  );

  test.each(['journal', 'task', 'catalog', 'outcome'])(
    'writer death at %s recovers one decision and receipt',
    async (checkpoint) => {
      const writer = start('task', 'killed', checkpoint);
      expect(await writer.message()).toEqual({ checkpoint });
      writer.child.kill('SIGKILL');
      await writer.exited;
      const scope = {
        kind: 'worktree' as const,
        projectId: 'project',
        worktreeId: 'topic',
      };
      const recovered = await repository.ensureTask(
        scope,
        '2026-01-01',
        'killed',
      );
      expect(await repository.list()).toEqual([recovered]);
      const beforeReplay = await image();
      expect(
        await repository.ensureTask(scope, '2026-01-01', 'killed'),
      ).toEqual(recovered);
      expect(await image()).toEqual(beforeReplay);
      expect((await repository.getTask(scope))?.taskProfileId).toBe(
        recovered.profileId,
      );
      expect(await readdir(join(root, 'operations'))).toEqual(['killed.json']);
      expect(await readdir(root)).not.toContain('transaction.json');
      await expect(
        repository.createNamed('killed', { displayName: 'different' }),
      ).rejects.toMatchObject({ code: 'operation_conflict' });
    },
  );

  test.each([
    ['empty lease', '', 'recovery_required'],
    ['partial JSON', '{', 'recovery_required'],
    ['invalid shape', '{}', 'storage_unavailable'],
    [
      'invalid PID',
      JSON.stringify({ pid: 0, token: 'unproven' }),
      'storage_unavailable',
    ],
    [
      'live PID',
      JSON.stringify({ pid: process.pid, token: 'live' }),
      'storage_unavailable',
    ],
    [
      'uncertain PID',
      JSON.stringify({ pid: 123, token: 'uncertain' }),
      'storage_unavailable',
    ],
  ])('%s lease refuses and preserves every byte', async (kind, lease, code) => {
    await repository.createNamed('seed', { displayName: 'seed' });
    const before = await image();
    await writeFile(join(root, 'writer.lock'), lease);
    if (kind === 'uncertain PID') {
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      });
    }
    await expect(repository.list()).rejects.toMatchObject({ code });
    await expect(
      repository.createNamed('refused', { displayName: 'refused' }),
    ).rejects.toMatchObject({ code });
    expect(await image()).toEqual(before);
    expect(await readFile(join(root, 'writer.lock'), 'utf8')).toBe(lease);
  });

  test('stranded reclaim guard only blocks dead-writer reclamation, not a fresh claim', async () => {
    await mkdir(root);
    await writeFile(join(root, 'reclaim.lock'), 'preserve guard');
    expect(await repository.list()).toEqual([]);
    const writer = start('write', 'dead', 'journal');
    expect(await writer.message()).toEqual({ checkpoint: 'journal' });
    writer.child.kill('SIGKILL');
    await writer.exited;
    const lease = await readFile(join(root, 'writer.lock'), 'utf8');
    const before = await image();
    await expect(repository.list()).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(await readFile(join(root, 'writer.lock'), 'utf8')).toBe(lease);
    expect(await readFile(join(root, 'reclaim.lock'), 'utf8')).toBe(
      'preserve guard',
    );
    expect(await image()).toEqual(before);
  });

  test('stale generation and incarnation never invoke the binding commit', async () => {
    const scope = {
      kind: 'worktree' as const,
      projectId: 'project',
      worktreeId: 'topic',
    };
    const profile = await repository.ensureTask(scope, '2026-01-01', 'task');
    const slot = await repository.getTask(scope);
    if (!slot) throw new Error('Missing task slot');
    const commit = jest.fn(() => Promise.resolve('bound'));
    const binding = {
      profileId: profile.profileId,
      storageGeneration: profile.storageGeneration,
      scope,
      incarnationId: slot.incarnationId,
    };
    expect(await repository.withActiveBinding(binding, commit)).toBe('bound');
    commit.mockClear();
    const reset = await repository.resetProfile('reset', {
      profileId: profile.profileId,
      storageGeneration: profile.storageGeneration,
      metadataRevision: profile.metadataRevision,
    });
    expect(reset.profile.storageGeneration).toBeGreaterThan(
      profile.storageGeneration,
    );
    await expect(
      repository.withActiveBinding(binding, commit),
    ).rejects.toMatchObject({ code: 'profile_unavailable' });
    const retirement = await repository.prepareRetirement(
      scope,
      '2026-01-01',
      'retire',
    );
    await repository.commitRetirement(retirement.operationId, {
      kind: 'owner_removed',
      ownerOperationId: 'owner-removed',
    });
    const replacement = await repository.ensureTask(
      scope,
      '2026-02-01',
      'replacement',
    );
    await expect(
      repository.withActiveBinding(
        {
          ...binding,
          profileId: replacement.profileId,
          storageGeneration: replacement.storageGeneration,
        },
        commit,
      ),
    ).rejects.toMatchObject({ code: 'scope_retired' });
    expect(commit).not.toHaveBeenCalled();
    const current = await repository.getTask(scope);
    if (!current) throw new Error('Missing replacement slot');
    expect(
      await repository.withActiveBinding(
        {
          ...binding,
          profileId: replacement.profileId,
          storageGeneration: replacement.storageGeneration,
          incarnationId: current.incarnationId,
        },
        commit,
      ),
    ).toBe('bound');
  });

  test.each([
    'catalog',
    'journal',
    'missing-catalog',
    'missing-slot',
    'unindexed-missing-slot',
    'malformed-slot',
    'invalid-slot',
  ])('P/Q damaged %s image refuses without replacement', async (kind) => {
    const scope = {
      kind: 'worktree' as const,
      projectId: 'project',
      worktreeId: 'topic',
    };
    await repository.ensureTask(scope, '2026-01-01', 'seed');
    if (kind === 'catalog')
      await writeFile(join(root, 'catalog.json'), '{"schemaVersion":99}');
    if (kind === 'journal')
      await writeFile(join(root, 'transaction.json'), '{');
    if (kind === 'missing-catalog') await rm(join(root, 'catalog.json'));
    if (kind.endsWith('slot')) {
      const [slot] = await readdir(join(root, 'task-slots'));
      const slotPath = join(root, 'task-slots', slot);
      if (kind === 'malformed-slot') await writeFile(slotPath, '{');
      else if (kind === 'invalid-slot') await writeFile(slotPath, '{}');
      else await rm(slotPath);
    }
    if (kind === 'unindexed-missing-slot') {
      const catalogPath = join(root, 'catalog.json');
      const catalog: unknown = JSON.parse(await readFile(catalogPath, 'utf8'));
      if (
        typeof catalog !== 'object' ||
        catalog === null ||
        !('taskKeys' in catalog)
      )
        throw new Error('Missing catalog task index');
      catalog.taskKeys = [];
      await writeFile(catalogPath, JSON.stringify(catalog));
    }
    const before = await image();
    await expect(
      repository.ensureTask(scope, '2026-01-01', 'seed'),
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(await image()).toEqual(before);
    if (kind === 'unindexed-missing-slot') {
      expect(await repository.getTask(scope)).toBeNull();
      expect(await image()).toEqual(before);
      return;
    }
    await expect(repository.getTask(scope)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(await image()).toEqual(before);
    await expect(
      repository.ensureTask(scope, '2026-01-01', 'fresh'),
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(await image()).toEqual(before);
  });

  test('D post-install uncertainty retains journal and replays the same durable decision', async () => {
    const publish = atomic.writeFileAtomically;
    let injected = false;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (...args) => {
        await publish(...args);
        if (!injected && args[0] === join(root, 'transaction.json')) {
          injected = true;
          throw new StorageOutcomeUnknownError(
            'directory_flush',
            new Error('injected'),
          );
        }
      });
    await expect(
      repository.createNamed('uncertain', { displayName: 'one' }),
    ).rejects.toBeInstanceOf(StorageOutcomeUnknownError);
    expect(await readdir(root)).toContain('transaction.json');
    const replay = await new BrowserProfileRepository(root).createNamed(
      'uncertain',
      { displayName: 'one' },
    );
    expect(await repository.list()).toEqual([replay]);
    expect(await readdir(root)).not.toContain('transaction.json');
  });
});
