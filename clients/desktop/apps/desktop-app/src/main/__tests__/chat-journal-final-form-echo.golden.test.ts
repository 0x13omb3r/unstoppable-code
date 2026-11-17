/**
 * CAN-6902: a turn can write a row's open form after that row was committed
 * in its format 4 final form, whose finalization offloaded fields the open
 * form keeps inline. The transcript log's writers treat the two as one row
 * and skip the echo. The delta journal's overlay, which applies the same
 * write and replays it at startup, must agree, or a chat whose journal holds
 * such a write can't be read after a restart ("Active message conflicts with
 * committed history"). A row that really differs is still refused.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, readdir, readFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import {
  ChatTranscriptOverlay,
  type TranscriptOverlayBase,
} from '../lib/chat-delta-journal/transcript-overlay';
import {
  DELTA_JOURNAL_FILE_NAME,
  encodeDeltaJournalFrame,
  isActiveEffect,
  type DeltaJournalTranscriptEffect,
} from '../lib/chat-delta-journal/format';
import {
  primaryEffects,
  readDeltaJournal,
} from '../lib/chat-delta-journal/replay';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  type DeltaJournalDiagnostic,
} from '../lib/chat-delta-journal/writer';
import type { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  createV2Scope,
  message,
  replayedScopeState,
  scopeSource,
} from './helpers/chat-delta-journal-harness';
import { format4Scope } from './helpers/chat-format4-scope';

const CHAT = 'chat-1';
// Over the 64 KiB inline budget, so its final form offloads the text.
const LONG_OUTPUT = 'a line of tool output\n'.repeat(4_000);

function row(id: string, text: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1_794_797_640_000,
    blocks: [{ type: 'text', text }],
  };
}

/** The overlay's view of the files, as the journal writer builds it. */
function baseOver(log: ChatTranscriptLog): TranscriptOverlayBase {
  return {
    exists: (): Promise<boolean> => Promise.resolve(true),
    committedMessageState: (chatId, message) =>
      log.committedMessageState(chatId, message),
    hasCommittedMessage: (chatId, messageId) =>
      log.hasCommittedMessage(chatId, messageId),
    matchesCommitted: (chatId, open, committed) =>
      log.matchesCommitted(chatId, open, committed),
    activeMessages: (chatId) => log.activeMessages(chatId),
    activeSnapshot: (chatId) => log.activeSnapshot(chatId),
    iterate: (chatId) => log.iterate(chatId),
    transcriptRevision: async (chatId) =>
      (await log.descriptor(chatId)).transcriptRevision,
  };
}

function activeEffectFor(
  chatId: string,
  kind: 'active' | 'active-upsert',
  messages: PersistedChatMessage[],
): DeltaJournalTranscriptEffect {
  const effect: DeltaJournalTranscriptEffect = {
    kind,
    chatId,
    create: false,
    messages,
  };
  return effect;
}

function activeEffect(
  kind: 'active' | 'active-upsert',
  messages: PersistedChatMessage[],
): DeltaJournalTranscriptEffect {
  return activeEffectFor(CHAT, kind, messages);
}

let root: string;
let log: ChatTranscriptLog;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'chat-journal-final-form-'));
  log = new ChatTranscriptLog(join(root, 'transcripts'));
  await log.initialize(CHAT);
  await log.append(
    CHAT,
    [row('u1', 'run the build'), row('m1', LONG_OUTPUT)],
    undefined,
    undefined,
    'format4',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a row written in its open form after its final form was committed (CAN-6902)', () => {
  it('is the committed row to the log', async () => {
    await expect(
      log.committedMessageState(CHAT, row('m1', LONG_OUTPUT)),
    ).resolves.toBe('identical');
    await expect(
      log.committedMessageState(CHAT, row('m1', 'something else')),
    ).resolves.toBe('different');
  });

  it.each(['active-upsert', 'active'] as const)(
    'replays through the journal overlay as a %s write, and the echo is skipped',
    async (kind) => {
      const overlay = await ChatTranscriptOverlay.open(
        CHAT,
        baseOver(log),
        false,
      );
      await expect(
        overlay.apply(activeEffect(kind, [row('m1', LONG_OUTPUT)]), 2),
      ).resolves.toBeUndefined();
      await expect(overlay.activeMessages()).resolves.toEqual([]);
    },
  );

  it('still refuses a row that really differs from the committed one', async () => {
    const overlay = await ChatTranscriptOverlay.open(
      CHAT,
      baseOver(log),
      false,
    );
    await expect(
      overlay.apply(activeEffect('active-upsert', [row('m1', 'edited')]), 2),
    ).rejects.toThrow('Active message conflicts with committed history');
  });
});

describe('startup recovery of a journal holding an active row that conflicts with history (CAN-6902)', () => {
  let scopeRoot: string;
  beforeEach(() => {
    scopeRoot = mkdtempSync(join(tmpdir(), 'chat-journal-echo-recovery-'));
  });
  afterEach(() => {
    rmSync(scopeRoot, { recursive: true, force: true });
  });

  /**
   * A promoted scope whose journal ends with a streaming record today's
   * writer committed, with its rows swapped for an exact copy of one
   * committed row and an edited copy of another, as the journals that
   * CAN-6902 met on disk hold.
   */
  async function scopeWithConflictingEcho(): Promise<ChatStorageV2> {
    const store = await createV2Scope(join(scopeRoot, 'v2'), 'scope', [
      {
        id: 'c0',
        messages: [message('u1', 'hi', 'user'), message('m2', 'original')],
      },
    ]);
    await promoteToDeltaJournal(store);
    const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    const before = await readDeltaJournal(store.directory, 'scope');
    const writer = await ChatDeltaJournalWriter.open(store);
    const next = structuredClone(writer.indexes());
    next.live.revision += 1;
    next.archive.revision += 1;
    next.recovery.mutationIds = [...next.recovery.mutationIds, 'echo'];
    const { applied } = await writer.commit({
      expectedRevision: writer.indexes().live.revision,
      next,
      writes: [
        {
          chatId: 'c0',
          kind: 'active-upsert',
          messages: [message('m3', 'streaming')],
        },
      ],
      mutationIds: ['echo'],
    });
    expect(applied).toBe(true);
    const after = await readDeltaJournal(store.directory, 'scope');
    const record = after.records.at(-1);
    if (record?.v !== 1) throw new Error('Expected one version 1 record');
    expect(record.transcripts.map((effect) => effect.kind)).toEqual([
      'active-upsert',
    ]);
    const { frame } = encodeDeltaJournalFrame({
      ...record,
      transcripts: [
        activeEffectFor('c0', 'active-upsert', [
          message('u1', 'hi', 'user'),
          message('m2', 'edited'),
        ]),
      ],
    });
    await truncate(path, before.validEnd);
    await appendFile(path, frame);
    return store;
  }

  it('quarantines only the row it cannot reconcile, replays the rest, and leaves the scope readable', async () => {
    const store = await scopeWithConflictingEcho();
    const diagnostics: DeltaJournalDiagnostic[] = [];
    const writer = await ChatDeltaJournalWriter.open(store, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(writer.isOpen()).toBe(true);

    const quarantined = (await readdir(store.directory)).filter((name) =>
      name.startsWith('delta-journal-echo-quarantine-'),
    );
    expect(quarantined).toEqual(['delta-journal-echo-quarantine-1.json']);
    const copy: unknown = JSON.parse(
      await readFile(join(store.directory, quarantined[0] ?? ''), 'utf8'),
    );
    expect(copy).toMatchObject({
      chatId: 'c0',
      effect: 'active-upsert',
      rows: [message('m2', 'edited')],
    });
    expect(diagnostics).toEqual([
      {
        kind: 'delta_journal_conflicting_echo_quarantined',
        rowCount: 1,
        journalQuarantineFile: 'delta-journal-echo-quarantine-1.json',
      },
    ]);
    // The committed history is unchanged, and every reader replays it.
    const state = await replayedScopeState(store);
    expect(JSON.stringify(state.chats.c0)).toContain('original');
    expect(JSON.stringify(state.chats.c0)).not.toContain('edited');

    // The next open has nothing to quarantine and writes nothing.
    const files = (await readdir(store.directory)).sort();
    const journal = await readFile(
      join(store.directory, DELTA_JOURNAL_FILE_NAME),
    );
    const later: DeltaJournalDiagnostic[] = [];
    await ChatDeltaJournalWriter.open(store, {
      onDiagnostic: (diagnostic) => later.push(diagnostic),
    });
    expect(later).toEqual([]);
    expect((await readdir(store.directory)).sort()).toEqual(files);
    expect(
      await readFile(join(store.directory, DELTA_JOURNAL_FILE_NAME)),
    ).toEqual(journal);
  });

  it('after a crash between the quarantine copy and the checkpoint, the next start reuses the copy and checkpoints', async () => {
    const store = await scopeWithConflictingEcho();
    await expect(
      ChatDeltaJournalWriter.open(store, {
        onBoundary: (boundary) =>
          boundary === 'echo-quarantined'
            ? Promise.reject(new Error('crash'))
            : Promise.resolve(),
      }),
    ).rejects.toThrow('crash');
    const crashed = (await readdir(store.directory)).sort();
    expect(crashed).toContain('delta-journal-echo-quarantine-1.json');

    // The read-only replay still refuses the record, and writes nothing.
    await expect(replayedScopeState(store)).rejects.toThrow();
    expect((await readdir(store.directory)).sort()).toEqual(crashed);

    const diagnostics: DeltaJournalDiagnostic[] = [];
    await ChatDeltaJournalWriter.open(store, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith('delta-journal-echo-quarantine-'),
      ),
    ).toEqual(['delta-journal-echo-quarantine-1.json']);
    expect(diagnostics).toEqual([
      {
        kind: 'delta_journal_conflicting_echo_quarantined',
        rowCount: 1,
        journalQuarantineFile: 'delta-journal-echo-quarantine-1.json',
      },
    ]);
    const state = await replayedScopeState(store);
    expect(JSON.stringify(state.chats.c0)).toContain('original');
    expect(JSON.stringify(state.chats.c0)).not.toContain('edited');
  });

  it('after a crash inside the checkpoint that follows the quarantine, the resumed checkpoint keeps the row out', async () => {
    const store = await scopeWithConflictingEcho();
    await expect(
      ChatDeltaJournalWriter.open(store, {
        onBoundary: (boundary) =>
          boundary === 'checkpoint-transcripts-applied'
            ? Promise.reject(new Error('crash'))
            : Promise.resolve(),
      }),
    ).rejects.toThrow('crash');

    const diagnostics: DeltaJournalDiagnostic[] = [];
    await ChatDeltaJournalWriter.open(store, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.startsWith('delta-journal-echo-quarantine-'),
      ),
    ).toEqual(['delta-journal-echo-quarantine-1.json']);
    expect(diagnostics).toEqual([
      {
        kind: 'delta_journal_conflicting_echo_quarantined',
        rowCount: 1,
        journalQuarantineFile: 'delta-journal-echo-quarantine-1.json',
      },
    ]);
    const state = await replayedScopeState(store);
    expect(JSON.stringify(state.chats.c0)).toContain('original');
    expect(JSON.stringify(state.chats.c0)).not.toContain('edited');
  });
});

describe('a live open-form echo of a row committed in its final form (CAN-6902)', () => {
  let scopeRoot: string;
  beforeEach(() => {
    scopeRoot = mkdtempSync(join(tmpdir(), 'chat-journal-live-echo-'));
  });
  afterEach(() => {
    rmSync(scopeRoot, { recursive: true, force: true });
  });

  it('commits without journaling the echo', async () => {
    const { store, backend } = await format4Scope(
      join(scopeRoot, 'v2'),
      'scope',
      scopeSource([{ id: 'c0', messages: [row('u0', 'hello')] }]),
    );
    // A turn streams the long row, and its end commits the final form.
    const turn = (
      mutations: ChatCoreMutation[],
      mutationId: string,
    ): Promise<unknown> =>
      backend.transact(() => mutations, { source: 'automation', mutationId });
    await turn(
      [
        {
          type: 'runtime.patched',
          chatId: 'c0',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'u1', startedAt: 5 },
          },
        },
        {
          type: 'message.upserted',
          chatId: 'c0',
          message: message('u1', 'run the build', 'user'),
        },
      ],
      'start',
    );
    await turn(
      [
        {
          type: 'message.upserted',
          chatId: 'c0',
          message: row('m1', LONG_OUTPUT),
        },
      ],
      'stream',
    );
    await turn(
      [
        {
          type: 'runtime.patched',
          chatId: 'c0',
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ],
      'end',
    );
    backend.releaseJournal();
    const writer = await ChatDeltaJournalWriter.open(store);
    expect(writer.fieldMode).toBe('format4');
    // The stored copy is the final form, which offloaded the long text.
    const stored = await new ChatTranscriptLog(
      join(store.directory, 'transcripts'),
    ).committedMessage('c0', 'm1');
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored).length).toBeLessThan(LONG_OUTPUT.length);

    const next = structuredClone(writer.indexes());
    next.live.revision += 1;
    next.archive.revision += 1;
    next.recovery.mutationIds = [...next.recovery.mutationIds, 'echo'];
    const { applied } = await writer.commit({
      expectedRevision: writer.indexes().live.revision,
      next,
      writes: [
        {
          chatId: 'c0',
          kind: 'active-upsert',
          messages: [row('m1', LONG_OUTPUT), row('m2', 'still streaming')],
        },
      ],
      mutationIds: ['echo'],
    });
    expect(applied).toBe(true);

    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    const journal = await readDeltaJournal(store.directory, 'scope', manifest);
    const record = journal.records.at(-1);
    if (record === undefined) throw new Error('The commit wrote no record');
    expect(
      primaryEffects(record).flatMap((effect) =>
        isActiveEffect(effect)
          ? effect.messages.map((message) => message.id)
          : [],
      ),
    ).toEqual(['m2']);
    await expect(writer.activeMessages('c0')).resolves.toEqual([
      expect.objectContaining({ id: 'm2' }),
    ]);
  });
});
