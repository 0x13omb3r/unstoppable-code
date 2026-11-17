import type { DomainEventMap } from '@canopy/app-core';
import {
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
  TERMINAL_USER_CLOSE_SIGNAL,
  type LoadWorktreeTerminalStateResponse,
} from '@canopy/protocol/terminal';
import { getTerminalReadOnlyMessage } from '../../terminal/terminal-session-state';
import type * as DurablePty from '../durable-pty-client';
import type {
  DurablePtyClientOptions,
  DurablePtyCloseReason,
  DurablePtyDimensions,
  DurableTerminalConnection,
} from '../durable-pty-client';
import type { CanopyCoreRelayLikeReply, CoreCoworkStream } from '../invoker';

/**
 * What each fake shell recorded. Like the real client it drops input until
 * it opens; the wire is covered by the web reattach golden.
 */
interface FakePty {
  readonly options: DurablePtyClientOptions;
  readonly writes: string[];
  readonly sizes: DurablePtyDimensions[];
  connected: boolean;
  disposed: boolean;
  state: 'idle' | 'connecting' | 'open' | 'closed';
  open(): void;
}
const ptys: FakePty[] = [];
jest.mock('../durable-pty-client', () => ({
  DurablePtyClient: class {
    readonly connect: () => void;
    readonly write: (bytes: Uint8Array) => void;
    readonly resize: (size: DurablePtyDimensions) => void;
    readonly dispose: () => void;
    private readonly pty: FakePty;
    constructor(options: DurablePtyClientOptions) {
      const pty: FakePty = {
        options,
        writes: [],
        sizes: [],
        connected: false,
        disposed: false,
        state: 'idle',
        open: (): void => {
          pty.state = 'open';
          options.onOpen?.();
        },
      };
      this.pty = pty;
      ptys.push(pty);
      this.connect = (): void => {
        pty.connected = true;
        pty.state = 'connecting';
      };
      this.write = (bytes): void => {
        if (pty.state !== 'open') return;
        pty.writes.push(new TextDecoder().decode(bytes));
      };
      this.resize = (size): void => {
        pty.sizes.push(size);
      };
      this.dispose = (): void => {
        pty.disposed = true;
        pty.state = 'closed';
      };
    }
    get state(): FakePty['state'] {
      return this.pty.state;
    }
    /** The shell the web core named: a resumed one's, else one per pty once open. */
    get resume(): { terminalId: string; offset: number } | undefined {
      if (this.pty.options.resume) return this.pty.options.resume;
      return this.pty.state === 'open'
        ? { terminalId: `shell-${ptys.indexOf(this.pty) + 1}`, offset: 0 }
        : undefined;
    }
  },
}));

import {
  createDurableTerminalClient,
  type DurableTerminalRecord,
  type DurableTerminalRecordStore,
} from '../durable-terminal-client';
import { createScopedTerminalClient } from '../scoped-terminal-client';

const CLOUD = 'web-core:chat-1';
const spawnArgs = {
  projectId: 'project-1',
  worktreeId: CLOUD,
  cols: 80,
  rows: 24,
};
const connection = {
  invoker: {
    request: (): Promise<never> => Promise.reject(new Error('unused')),
    openStream: (): Promise<never> => Promise.reject(new Error('unused')),
  },
  signal: new AbortController().signal,
};

function client(
  maxTerminals = 2,
): ReturnType<typeof createDurableTerminalClient> {
  let id = 0;
  return createDurableTerminalClient({
    connection: () => connection,
    chatIdOf: (worktreeId) =>
      worktreeId.startsWith('web-core:') ? worktreeId.slice(9) : null,
    maxTerminals,
    randomUUID: () => `terminal-${(id += 1)}`,
    now: () => 1_000,
  });
}

beforeEach(() => {
  ptys.length = 0;
});

describe('cloud chat durable terminal client (CAN-6175 R10)', () => {
  it("spawns a durable shell in the scope's chat and refuses what it cannot run", async () => {
    const terminals = client(1);
    await expect(
      terminals.command('terminal.spawn', spawnArgs),
    ).resolves.toEqual({
      id: 'terminal-1',
      projectId: 'project-1',
      worktreeId: CLOUD,
      shell: '/bin/bash',
      shellBasename: 'bash',
      cwd: '',
      createdAt: 1_000,
    });
    expect(ptys).toHaveLength(1);
    expect(ptys[0]).toMatchObject({
      connected: true,
      options: { chatId: 'chat-1', dimensions: { cols: 80, rows: 24 } },
    });

    // The cap keeps relay streams for chats.
    await expect(
      terminals.command('terminal.spawn', spawnArgs),
    ).rejects.toThrow('at most 1 open terminals');
    await expect(
      terminals.command('terminal.spawn', {
        ...spawnArgs,
        worktreeId: 'local-wt',
      }),
    ).rejects.toThrow('Not a cloud chat terminal scope.');
    await expect(
      client().command('terminal.spawn', {
        ...spawnArgs,
        initialCommand: 'ls',
      }),
    ).rejects.toThrow('startup command');
    expect(ptys).toHaveLength(1);
  });

  it('delivers output, replays it on attach and forwards input and size', async () => {
    const terminals = client();
    const outputs: DomainEventMap['terminal.output'][] = [];
    terminals.subscribe('terminal.output', (event) => outputs.push(event), {
      worktreeId: CLOUD,
    });
    terminals.subscribe(
      'terminal.output',
      () => {
        throw new Error('another scope saw it');
      },
      { worktreeId: 'other' },
    );
    const session = await terminals.command('terminal.spawn', spawnArgs);
    const pty = ptys[0];
    if (!pty) throw new Error('no shell');
    pty.open();

    pty.options.onData(new TextEncoder().encode('hello '));
    pty.options.onData(new TextEncoder().encode('world'));
    expect(outputs.map((event) => [event.terminalId, event.seq])).toEqual([
      ['terminal-1', 6],
      ['terminal-1', 11],
    ]);
    const attached = await terminals.command('terminal.attach', {
      terminalId: session.id,
    });
    expect(new TextDecoder().decode(attached.replay)).toBe('hello world');
    expect(attached.seq).toBe(11);

    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'ls\\r',
        idempotencyKey: 'k1',
      }),
    ).resolves.toBe('written');
    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'ls\\r',
        idempotencyKey: 'k1',
      }),
    ).resolves.toBe('already_written');
    await terminals.command('terminal.resize', {
      terminalId: session.id,
      cols: 100,
      rows: 30,
    });
    expect(pty.writes).toEqual(['ls\\r']);
    expect(pty.sizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it('holds input typed before the shell opens and sends it on open', async () => {
    const terminals = client();
    const session = await terminals.command('terminal.spawn', spawnArgs);
    const pty = ptys[0];
    if (!pty) throw new Error('no shell');

    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'echo hi',
        idempotencyKey: 'k1',
      }),
    ).resolves.toBe('written');
    await terminals.command('terminal.write', {
      terminalId: session.id,
      data: '!',
    });
    // Past the hold, a write is refused and its key stays free to retry.
    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'x'.repeat(64 * 1024),
        idempotencyKey: 'k2',
      }),
    ).rejects.toThrow('Terminal is still connecting. Try again.');
    expect(pty.writes).toEqual([]);

    pty.open();
    expect(pty.writes).toEqual(['echo hi!']);
    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'y',
        idempotencyKey: 'k2',
      }),
    ).resolves.toBe('written');
    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'echo hi',
        idempotencyKey: 'k1',
      }),
    ).resolves.toBe('already_written');
    expect(pty.writes).toEqual(['echo hi!', 'y']);
  });

  it('keeps write receipts per terminal', async () => {
    const terminals = client();
    const first = await terminals.command('terminal.spawn', spawnArgs);
    const second = await terminals.command('terminal.spawn', spawnArgs);
    ptys.forEach((pty) => pty.open());
    for (const terminalId of [first.id, second.id])
      await expect(
        terminals.command('terminal.write', {
          terminalId,
          data: 'ls',
          idempotencyKey: 'same',
        }),
      ).resolves.toBe('written');
    expect(ptys.map((pty) => pty.writes)).toEqual([['ls'], ['ls']]);
  });

  it('reports an exit once: the shell ending, a lost connection, or a kill', async () => {
    const terminals = client(3);
    const exits: [string, number | null, string | null][] = [];
    terminals.subscribe('terminal.exit', (event) =>
      exits.push([event.terminalId, event.exitCode, event.signal]),
    );
    await terminals.command('terminal.spawn', spawnArgs);
    await terminals.command('terminal.spawn', spawnArgs);
    await terminals.command('terminal.spawn', spawnArgs);
    const [first, second, third] = ptys;
    if (!first || !second || !third) throw new Error('no shells');

    first.options.onClose({ kind: 'exit', code: 0 });
    second.options.onClose({ kind: 'connection-lost', phase: 'open' });
    await terminals.command('terminal.kill', { terminalId: 'terminal-3' });
    third.options.onClose({ kind: 'exit', code: null });

    expect(third.disposed).toBe(true);
    expect(exits).toEqual([
      ['terminal-1', 0, null],
      ['terminal-2', null, TERMINAL_CONNECTION_LOST_SIGNAL],
      ['terminal-3', null, TERMINAL_USER_CLOSE_SIGNAL],
    ]);
    await expect(
      terminals.query('terminal.list', { worktreeId: CLOUD }),
    ).resolves.toEqual([]);
    await expect(
      terminals.command('terminal.write', {
        terminalId: 'terminal-1',
        data: 'x',
      }),
    ).rejects.toThrow('no longer available');
  });

  it('says a sleeping sandbox stopped the shell, and that a message wakes it, never a lost connection (CAN-6690)', async () => {
    const terminals = client(4);
    const exits: { signal: string | null; message: string | null }[] = [];
    terminals.subscribe('terminal.exit', (event) =>
      exits.push({
        signal: event.signal,
        message: getTerminalReadOnlyMessage(
          { live: false, exitCode: event.exitCode, signal: event.signal },
          'Canopy',
        ),
      }),
    );
    await terminals.command('terminal.spawn', spawnArgs);
    const [asleep] = ptys;
    if (!asleep) throw new Error('no shell');

    // The web core refused the shell because the sandbox sleeps.
    asleep.options.onClose({ kind: 'sandbox-asleep', wakeAllowed: true });
    expect(exits).toEqual([
      {
        signal: TERMINAL_SANDBOX_ASLEEP_SIGNAL,
        message:
          'Project is sleeping, so this shell stopped. Send a message to wake it, then restart the terminal.',
      },
    ]);
    // The relay carries no wake, so a restart asks for nothing more.
    await terminals.command('terminal.spawn', spawnArgs);
    expect(ptys[1]?.options).not.toHaveProperty('wake');
  });
  it('restarts a shell refused while the sandbox slept as a fresh shell in the same terminal (CAN-6732)', async () => {
    const terminals = client(4);
    const exits: (string | null)[] = [];
    terminals.subscribe('terminal.exit', (event) => exits.push(event.signal));
    await terminals.command('terminal.spawn', spawnArgs);
    ptys[0]?.options.onClose({ kind: 'sandbox-asleep', wakeAllowed: true });
    expect(exits).toEqual([TERMINAL_SANDBOX_ASLEEP_SIGNAL]);
    // The terminal ended, but it is still this client's to restart.
    expect(terminals.owns('terminal-1')).toBe(true);

    // Still asleep: the restart is refused the same way, with no error.
    await expect(
      terminals.command('terminal.restore', {
        terminalId: 'terminal-1',
        cols: 100,
        rows: 30,
      }),
    ).resolves.toMatchObject({ id: 'terminal-1', worktreeId: CLOUD });
    expect(ptys).toHaveLength(2);
    expect(ptys[1]).toMatchObject({ connected: true });
    expect(ptys[1]?.options).toMatchObject({
      chatId: 'chat-1',
      dimensions: { cols: 100, rows: 30 },
    });
    ptys[1]?.options.onClose({ kind: 'sandbox-asleep', wakeAllowed: true });
    expect(exits).toEqual([
      TERMINAL_SANDBOX_ASLEEP_SIGNAL,
      TERMINAL_SANDBOX_ASLEEP_SIGNAL,
    ]);

    // Awake: the next restart gets a working shell in the same terminal.
    await terminals.command('terminal.restore', {
      terminalId: 'terminal-1',
      cols: 100,
      rows: 30,
    });
    ptys[2]?.open();
    await terminals.command('terminal.write', {
      terminalId: 'terminal-1',
      data: 'ls',
    });
    expect(ptys[2]?.writes).toEqual(['ls']);
    await expect(
      terminals.command('terminal.attach', { terminalId: 'terminal-1' }),
    ).resolves.toMatchObject({ session: { id: 'terminal-1' } });
  });

  it('does not bring back a terminal the user closed', async () => {
    const terminals = client(4);
    await terminals.command('terminal.spawn', spawnArgs);
    await terminals.command('terminal.kill', { terminalId: 'terminal-1' });
    expect(terminals.owns('terminal-1')).toBe(false);
    await expect(
      terminals.command('terminal.restore', {
        terminalId: 'terminal-1',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow();
    expect(ptys).toHaveLength(1);
  });

  it('does not bring back an ended terminal the user then closed, or any after dispose', async () => {
    const terminals = client(4);
    await terminals.command('terminal.spawn', spawnArgs);
    await terminals.command('terminal.spawn', spawnArgs);
    ptys[0]?.options.onClose({ kind: 'sandbox-asleep', wakeAllowed: true });
    ptys[1]?.options.onClose({ kind: 'sandbox-asleep', wakeAllowed: true });
    expect(terminals.owns('terminal-1')).toBe(true);

    // Closed after its shell ended: gone for good.
    await terminals.command('terminal.kill', { terminalId: 'terminal-1' });
    expect(terminals.owns('terminal-1')).toBe(false);
    await expect(
      terminals.command('terminal.restore', {
        terminalId: 'terminal-1',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow();

    // Disposed: no ended terminal comes back either.
    terminals.dispose();
    expect(terminals.owns('terminal-2')).toBe(false);
    await expect(
      terminals.command('terminal.restore', {
        terminalId: 'terminal-2',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow();
    expect(ptys).toHaveLength(2);
  });

  it('keeps the panel layout in memory and kills every shell on dispose', async () => {
    const terminals = client();
    await terminals.command('terminal.spawn', spawnArgs);
    await terminals.command('terminal.worktreeState.save', {
      projectId: 'project-1',
      worktreeId: CLOUD,
      drawerCollapsed: true,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 2,
      groupOrdinals: {},
      terminalCustomNames: { 'terminal-1': 'build' },
      groupCustomNames: {},
    });
    await expect(
      terminals.query('terminal.worktreeState.get', {
        projectId: 'project-1',
        worktreeId: CLOUD,
      }),
    ).resolves.toMatchObject({
      drawerCollapsed: true,
      terminalCustomNames: { 'terminal-1': 'build' },
      terminals: [],
      liveTerminalIds: ['terminal-1'],
    });
    await expect(
      terminals.command('terminal.restore', {
        terminalId: 'terminal-1',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('cannot be restored');

    terminals.dispose();
    expect(ptys.every((pty) => pty.disposed)).toBe(true);
    expect(terminals.owns('terminal-1')).toBe(false);
  });
});

describe('cloud terminals after a reload (CAN-6939)', () => {
  /** The window's records, which outlive each client as storage outlives a reload. */
  function recordStore(): DurableTerminalRecordStore & {
    readonly saved: Map<string, DurableTerminalRecord>;
  } {
    const saved = new Map<string, DurableTerminalRecord>();
    return {
      saved,
      list: (projectId, worktreeId) =>
        [...saved.values()].filter(
          (record) =>
            record.projectId === projectId && record.worktreeId === worktreeId,
        ),
      put: (record) => {
        saved.set(record.sessionId, record);
      },
      remove: (sessionId) => {
        saved.delete(sessionId);
      },
    };
  }

  /** A page's client: a reload is a new one over the same records. */
  function page(
    records: DurableTerminalRecordStore,
    request: jest.Mock = jest.fn(),
    bound: readonly string[] = [],
  ): ReturnType<typeof createDurableTerminalClient> {
    let id = 0;
    return createDurableTerminalClient({
      connection: () => ({
        invoker: {
          request,
          openStream: (): Promise<never> => Promise.reject(new Error('unused')),
        },
        signal: new AbortController().signal,
      }),
      chatIdOf: (worktreeId) =>
        worktreeId.startsWith('web-core:') ? worktreeId.slice(9) : null,
      maxTerminals: 4,
      records,
      boundTerminalIds: (projectId, worktreeId) =>
        projectId === 'project-1' && worktreeId === CLOUD ? bound : [],
      randomUUID: () => `terminal-${(id += 1)}`,
      now: () => 1_000,
    });
  }

  const hydrate = (
    terminals: ReturnType<typeof createDurableTerminalClient>,
    worktreeId = CLOUD,
  ): Promise<LoadWorktreeTerminalStateResponse> =>
    terminals.query('terminal.worktreeState.get', {
      projectId: 'project-1',
      worktreeId,
    });

  /** What hydration reports of each terminal it brought back. */
  const reported = (
    state: LoadWorktreeTerminalStateResponse,
  ): { id: string; exitCode: number | null; signal: string | null }[] =>
    state.terminals.map((terminal) => ({
      id: terminal.session.id,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
    }));

  it("reattaches the panel's shell, with its history, and takes input", async () => {
    const records = recordStore();
    const before = page(records);
    await before.command('terminal.spawn', spawnArgs);
    ptys[0]?.open();
    expect(records.saved.get('terminal-1')).toMatchObject({
      chatId: 'chat-1',
      shellTerminalId: 'shell-1',
    });

    const after = page(records, jest.fn(), ['terminal-1']);
    const state = await hydrate(after);
    expect(state.liveTerminalIds).toEqual(['terminal-1']);
    expect(state.terminals.map((terminal) => terminal.session.id)).toEqual([
      'terminal-1',
    ]);
    expect(ptys).toHaveLength(2);
    expect(ptys[1]?.options).toMatchObject({
      chatId: 'chat-1',
      resume: { terminalId: 'shell-1', offset: 0 },
    });
    expect(ptys[1]?.options.dimensions).toBeUndefined();

    // The web core replays the shell's history from the start.
    ptys[1]?.options.onData(new TextEncoder().encode('before-reload-9\r\n'));
    const attached = await after.command('terminal.attach', {
      terminalId: 'terminal-1',
    });
    expect(new TextDecoder().decode(attached.replay)).toBe(
      'before-reload-9\r\n',
    );
    ptys[1]?.open();
    await after.command('terminal.write', {
      terminalId: 'terminal-1',
      data: 'echo after\r',
    });
    expect(ptys[1]?.writes).toEqual(['echo after\r']);
    // Reattached once per page.
    await hydrate(after);
    expect(ptys).toHaveLength(2);
  });

  it('keeps the history of a shell that ends before its pane attaches', async () => {
    const records = recordStore();
    const before = page(records);
    await before.command('terminal.spawn', spawnArgs);
    ptys[0]?.open();
    const after = page(records, jest.fn(), ['terminal-1']);
    await hydrate(after);
    // The web core replays the history, then the shell exits, before any
    // pane has attached.
    ptys[1]?.options.onData(new TextEncoder().encode('before-reload-9\r\n'));
    ptys[1]?.options.onClose({ kind: 'exit', code: 0 });
    const [terminal] = (await hydrate(after)).terminals;
    expect(terminal).toMatchObject({ exitCode: 0, signal: null });
    expect(terminal?.scrollbackLines).toEqual(['before-reload-9\r', '']);
    // Its pane, mounting now, still gets the output to show read-only.
    const attached = await after.command('terminal.attach', {
      terminalId: 'terminal-1',
    });
    expect(new TextDecoder().decode(attached.replay)).toBe(
      'before-reload-9\r\n',
    );
  });

  it('still kills a shell left past the cap when its tab closes or the binding ends', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const saved = (): ReturnType<typeof recordStore> => {
      const records = recordStore();
      for (const id of ids)
        records.put({
          sessionId: `terminal-${id}`,
          projectId: 'project-1',
          worktreeId: CLOUD,
          chatId: 'chat-1',
          shellTerminalId: `shell-${id}`,
          createdAt: 1,
        });
      return records;
    };
    const bound = ids.map((id) => `terminal-${id}`);
    const killed = (request: jest.Mock): unknown[] =>
      request.mock.calls.filter(
        ([method]) => method === 'worker.terminal.kill',
      );

    // Its tab closes.
    const records = saved();
    const closing = jest.fn(() => Promise.resolve({ ok: true, value: null }));
    const after = page(records, closing, bound);
    const waiting = reported(await hydrate(after)).find(
      (terminal) => terminal.signal !== null,
    );
    if (!waiting) throw new Error('Missing the terminal past the cap');
    await after.command('terminal.kill', { terminalId: waiting.id });
    expect(killed(closing)).toEqual([
      [
        'worker.terminal.kill',
        {
          scope: { chatId: 'chat-1' },
          terminalId: `shell-${waiting.id.slice('terminal-'.length)}`,
        },
      ],
    ]);
    expect(records.saved.has(waiting.id)).toBe(false);

    // The binding ends.
    const disposing = jest.fn(() => Promise.resolve({ ok: true, value: null }));
    const next = page(saved(), disposing, bound);
    await hydrate(next);
    next.dispose();
    expect(killed(disposing)).toHaveLength(1);
  });

  it('resumes, rather than replaces, a shell left past the terminal cap at a reload', async () => {
    const records = recordStore();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids)
      records.put({
        sessionId: `terminal-${id}`,
        projectId: 'project-1',
        worktreeId: CLOUD,
        chatId: 'chat-1',
        shellTerminalId: `shell-${id}`,
        createdAt: 1,
      });
    const after = page(
      records,
      jest.fn(),
      ids.map((id) => `terminal-${id}`),
    );
    const state = await hydrate(after);
    // Four reattach; the fifth waits, ended, with its record kept.
    expect(state.liveTerminalIds).toHaveLength(4);
    const waiting = reported(state).find(
      (terminal) => terminal.signal !== null,
    );
    if (!waiting) throw new Error('Missing the terminal past the cap');
    expect(records.saved.get(waiting.id)?.shellTerminalId).toBe(
      `shell-${waiting.id.slice('terminal-'.length)}`,
    );
    await after.command('terminal.kill', { terminalId: 'terminal-a' });
    await after.command('terminal.restore', {
      terminalId: waiting.id,
      cols: 80,
      rows: 24,
    });
    expect(ptys.at(-1)?.options.resume).toEqual({
      terminalId: `shell-${waiting.id.slice('terminal-'.length)}`,
      offset: 0,
    });
    expect(records.saved.get(waiting.id)?.shellTerminalId).toBe(
      `shell-${waiting.id.slice('terminal-'.length)}`,
    );
  });

  it('shows a shell that is gone as ended, and restarts it as a new shell', async () => {
    const records = recordStore();
    const before = page(records);
    await before.command('terminal.spawn', spawnArgs);
    ptys[0]?.open();
    // Never opened: no shell to come back to.
    await before.command('terminal.spawn', spawnArgs);

    const after = page(records, jest.fn(), ['terminal-1', 'terminal-2']);
    const exits: DomainEventMap['terminal.exit'][] = [];
    after.subscribe('terminal.exit', (event) => exits.push(event));
    const state = await hydrate(after);
    expect(reported(state)).toEqual([
      { id: 'terminal-1', exitCode: null, signal: null },
      {
        id: 'terminal-2',
        exitCode: null,
        signal: TERMINAL_CONNECTION_LOST_SIGNAL,
      },
    ]);
    // The second never had a shell: its record goes at once.
    expect(records.saved.has('terminal-2')).toBe(false);
    // A dropped connection keeps the record; a shell the web core says is
    // gone does not.
    const lost = page(records, jest.fn(), ['terminal-1']);
    await hydrate(lost);
    ptys[3]?.options.onClose({ kind: 'connection-lost', phase: 'connecting' });
    expect(records.saved.has('terminal-1')).toBe(true);
    ptys[2]?.options.onClose({
      kind: 'connection-lost',
      phase: 'connecting',
      gone: true,
    });
    expect(exits).toEqual([
      expect.objectContaining({
        terminalId: 'terminal-1',
        signal: TERMINAL_CONNECTION_LOST_SIGNAL,
      }),
    ]);
    expect(records.saved.has('terminal-1')).toBe(false);

    for (const terminalId of ['terminal-1', 'terminal-2'])
      await after.command('terminal.restore', {
        terminalId,
        cols: 100,
        rows: 30,
      });
    expect(ptys.slice(4).map((pty) => pty.options.resume)).toEqual([
      undefined,
      undefined,
    ]);
    expect(ptys[4]?.options.dimensions).toEqual({ cols: 100, rows: 30 });
    ptys[4]?.open();
    expect(records.saved.get('terminal-1')?.shellTerminalId).toBe('shell-5');
  });

  it('shows a bound tab with no record as ended, and restarts it as a new shell', async () => {
    const records = recordStore();
    // A tab bound before records existed.
    const after = page(records, jest.fn(), ['terminal-legacy']);
    const state = await hydrate(after);
    expect(ptys).toHaveLength(0);
    expect(state.liveTerminalIds).toEqual([]);
    expect(reported(state)).toEqual([
      {
        id: 'terminal-legacy',
        exitCode: null,
        signal: TERMINAL_CONNECTION_LOST_SIGNAL,
      },
    ]);
    await after.command('terminal.restore', {
      terminalId: 'terminal-legacy',
      cols: 80,
      rows: 24,
    });
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.options.resume).toBeUndefined();
    ptys[0]?.open();
    expect(records.saved.get('terminal-legacy')).toMatchObject({
      chatId: 'chat-1',
      shellTerminalId: 'shell-1',
    });
  });

  it('still kills the shell when the user closes its tab', async () => {
    const records = recordStore();
    const before = page(records);
    await before.command('terminal.spawn', spawnArgs);
    ptys[0]?.open();
    const after = page(records, jest.fn(), ['terminal-1']);
    await hydrate(after);
    await after.command('terminal.kill', { terminalId: 'terminal-1' });
    expect(ptys[1]?.disposed).toBe(true);
    expect(records.saved.size).toBe(0);
    await hydrate(page(records));
    expect(ptys).toHaveLength(2);
  });

  it("forgets a closed tab's terminal: its record goes, and a reload brings nothing back", async () => {
    const records = recordStore();
    const before = page(records);
    await before.command('terminal.spawn', spawnArgs);
    await before.command('terminal.spawn', spawnArgs);
    ptys.forEach((pty) => pty.open());
    // The first tab was closed before the reload; no saved tab binds it.
    const after = page(records, jest.fn(), ['terminal-2']);
    const state = await hydrate(after);
    expect(state.liveTerminalIds).toEqual(['terminal-2']);
    expect(ptys.slice(2).map((pty) => pty.options.resume?.terminalId)).toEqual([
      'shell-2',
    ]);
    expect(records.saved.has('terminal-1')).toBe(false);
    // The second's shell then exits, and the user closes its ended tab.
    ptys[2]?.options.onClose({ kind: 'exit', code: 0 });
    expect(records.saved.has('terminal-2')).toBe(true);
    await after.command('terminal.kill', { terminalId: 'terminal-2' });
    expect(records.saved.size).toBe(0);
    await hydrate(page(records, jest.fn(), []));
    expect(ptys).toHaveLength(3);
  });

  it("never adopts another chat's terminal, nor lists the sandbox", async () => {
    const records = recordStore();
    // Another chat's shell runs in the sandbox, and a record names it for
    // this work entry; another work entry has its own record too.
    records.put({
      sessionId: 'terminal-other-chat',
      projectId: 'project-1',
      worktreeId: CLOUD,
      chatId: 'chat-2',
      shellTerminalId: 'shell-of-chat-2',
      createdAt: 1,
    });
    records.put({
      sessionId: 'terminal-other-entry',
      projectId: 'project-1',
      worktreeId: 'web-core:chat-2',
      chatId: 'chat-2',
      shellTerminalId: 'shell-of-chat-2',
      createdAt: 1,
    });
    const request = jest.fn();
    const after = page(records, request, ['terminal-other-chat']);
    const state = await hydrate(after);
    expect(ptys).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
    expect(state.liveTerminalIds).toEqual([]);
    expect(reported(state)).toEqual([
      {
        id: 'terminal-other-chat',
        exitCode: null,
        signal: TERMINAL_CONNECTION_LOST_SIGNAL,
      },
    ]);
    expect(after.owns('terminal-other-entry')).toBe(false);
    // The mismatched record goes; the other work entry's stays its own.
    expect([...records.saved.keys()]).toEqual(['terminal-other-entry']);
  });
});

describe('scoped terminal client (CAN-6175 R10)', () => {
  it('sends cloud scopes and their terminals to the cloud client, everything else local', async () => {
    // Two durable clients told apart by the chat their shells run in.
    let localId = 0;
    const local = createDurableTerminalClient({
      connection: () => connection,
      chatIdOf: () => 'local-host',
      maxTerminals: 2,
      randomUUID: () => `local-${(localId += 1)}`,
    });
    const cloud = client();
    const scoped = createScopedTerminalClient({
      local,
      cloud,
      isCloudScope: (worktreeId) => worktreeId.startsWith('web-core:'),
    });
    const exits: string[] = [];
    const stop = scoped.subscribe('terminal.exit', (event) =>
      exits.push(event.terminalId),
    );

    await scoped.command('terminal.spawn', spawnArgs);
    await scoped.command('terminal.spawn', {
      ...spawnArgs,
      worktreeId: 'local-wt',
    });
    expect(ptys.map((pty) => pty.options.chatId)).toEqual([
      'chat-1',
      'local-host',
    ]);
    ptys.forEach((pty) => pty.open());

    await scoped.command('terminal.write', {
      terminalId: 'terminal-1',
      data: 'a',
    });
    await scoped.command('terminal.write', {
      terminalId: 'local-1',
      data: 'b',
    });
    expect(ptys.map((pty) => pty.writes)).toEqual([['a'], ['b']]);

    await expect(scoped.query('terminal.list', {})).resolves.toHaveLength(2);
    await expect(
      scoped.query('terminal.list', { worktreeId: 'local-wt' }),
    ).resolves.toMatchObject([{ id: 'local-1' }]);

    await scoped.command('terminal.kill', { terminalId: 'terminal-1' });
    await scoped.command('terminal.kill', {
      terminalId: 'local-1',
      scope: { projectId: 'project-1', worktreeId: 'local-wt' },
    });
    expect(exits).toEqual(['terminal-1', 'local-1']);
    stop();
  });

  it('restarts an ended cloud terminal on the cloud client, never the local terminal service (CAN-6732)', async () => {
    const localRestore = jest.fn(() =>
      Promise.reject(new Error('Terminal not found: terminal-1')),
    );
    const local = createDurableTerminalClient({
      connection: () => connection,
      chatIdOf: () => 'local-host',
      maxTerminals: 2,
    });
    const cloud = client();
    const scoped = createScopedTerminalClient({
      local: {
        ...local,
        command: (name, args) =>
          name === 'terminal.restore'
            ? localRestore()
            : local.command(name, args),
      },
      cloud,
      isCloudScope: (worktreeId) => worktreeId.startsWith('web-core:'),
    });
    await scoped.command('terminal.spawn', spawnArgs);
    ptys[0]?.options.onClose({ kind: 'sandbox-asleep', wakeAllowed: true });

    await expect(
      scoped.command('terminal.restore', {
        terminalId: 'terminal-1',
        cols: 80,
        rows: 24,
      }),
    ).resolves.toMatchObject({ id: 'terminal-1' });
    expect(localRestore).not.toHaveBeenCalled();
    expect(ptys.map((pty) => pty.options.chatId)).toEqual(['chat-1', 'chat-1']);
  });
});

describe('durable shell on the web core (CAN-6690)', () => {
  const { DurablePtyClient } = jest.requireActual<typeof DurablePty>(
    '../durable-pty-client',
  );
  const ASLEEP = {
    kind: 'failed_precondition',
    message: 'The sandbox is asleep.',
    code: 'worker.terminal.invalidState',
    details: { reason: 'sandbox_sleeping', wakeAllowed: true },
    retry: { kind: 'after_refresh', resource: 'worker.terminal' },
  } as const;

  function shell(): {
    calls: { method: string; params: Record<string, unknown> }[];
    closes: unknown[];
    asleep: { value: boolean };
    start: () => Promise<void>;
  } {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const closes: unknown[] = [];
    const asleep = { value: true };
    const pty = new DurablePtyClient({
      client: (): DurableTerminalConnection => ({
        invoker: {
          request: (method, params): Promise<CanopyCoreRelayLikeReply> => {
            calls.push({ method, params });
            if (method === 'worker.filesystem.roots.list')
              return Promise.resolve({
                ok: true,
                value: {
                  roots: [
                    {
                      fileRootId: 'workspace',
                      name: 'Workspace',
                      kind: 'workspace-root',
                    },
                  ],
                },
              });
            if (method === 'worker.terminal.create')
              return Promise.resolve(
                asleep.value
                  ? { ok: false, error: ASLEEP }
                  : {
                      ok: true,
                      value: {
                        terminalId: 'shell-1',
                        scope: { chatId: 'chat-1' },
                        state: 'running',
                        cwdRootId: 'workspace',
                        cwdRelativePath: '',
                        cols: 80,
                        rows: 24,
                        exitCode: null,
                        signal: null,
                        outputOffset: 0,
                        profileId: null,
                        initialCommand: null,
                      },
                    },
              );
            return Promise.reject(new Error(`unexpected ${method}`));
          },
          // The attach stays open with nothing to read.
          openStream: (): Promise<CoreCoworkStream> =>
            Promise.resolve({
              next: (): Promise<never> => new Promise(() => undefined),
              close: (): Promise<void> => Promise.resolve(),
            }),
        },
        signal: new AbortController().signal,
      }),
      chatId: 'chat-1',
      dimensions: { cols: 80, rows: 24 },
      randomUUID: (): string => 'key-1',
      onData: (): void => undefined,
      onClose: (reason: DurablePtyCloseReason): void => {
        closes.push(reason);
      },
    });
    return {
      calls,
      closes,
      asleep,
      start: async (): Promise<void> => {
        pty.connect();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      },
    };
  }

  it('closes as asleep, never as a lost connection, when the web core refuses the shell for a sleeping sandbox', async () => {
    const { calls, closes, start } = shell();
    await start();
    expect(calls.map((call) => call.method)).toEqual([
      'worker.filesystem.roots.list',
      'worker.terminal.create',
    ]);
    expect(closes).toEqual([{ kind: 'sandbox-asleep', wakeAllowed: true }]);
  });
});
