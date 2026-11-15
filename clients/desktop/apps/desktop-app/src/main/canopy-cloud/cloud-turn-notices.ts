import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A note this desktop keeps on a turn it sent to a cloud chat (CAN-6176, D9
 * revised): the turn used the last published copy of a skill because its
 * republish failed or timed out. Names only, never content. CAN-6267 moves
 * these onto the message itself.
 */
export interface CloudTurnNotice {
  kind: 'capability_copy_stale';
  name: string;
}

/** Turns kept per chat; the oldest go first. */
export const MAX_NOTED_TURNS_PER_CHAT = 20;
/** Notes kept per turn. */
export const MAX_NOTICES_PER_TURN = 5;
/** Chats kept per file; the least recently noted go first. */
export const MAX_NOTED_CHATS = 500;
const MAX_NAME_LENGTH = 256;

interface NotedChat {
  updatedAt: string;
  turns: { messageId: string; notices: CloudTurnNotice[] }[];
}

const FILE_NAME = 'cloud-turn-notices.json';

/** The file's format: entries in an envelope. A bare map is version 0. */
const FILE_VERSION = 1;

/**
 * The file's entries, or 'newer' when a later version of the app wrote it:
 * this one then reads nothing and never overwrites it.
 */
function readEntries(filePath: string): Record<string, unknown> | 'newer' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
  if (!isPlainRecord(parsed)) return {};
  if (!('version' in parsed)) return { ...parsed };
  if (parsed.version !== FILE_VERSION) return 'newer';
  return isPlainRecord(parsed.entries) ? { ...parsed.entries } : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NEWER_FILE_MESSAGE =
  'A newer version of the app wrote this file, so it is left as it is.';

const chatKey = (accountId: string, chatId: string): string =>
  JSON.stringify([accountId, chatId]);

function parseNotice(value: unknown): CloudTurnNotice | null {
  if (typeof value !== 'object' || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  return record.kind === 'capability_copy_stale' &&
    typeof record.name === 'string'
    ? { kind: 'capability_copy_stale', name: record.name }
    : null;
}

function parseChat(value: unknown): NotedChat | null {
  if (typeof value !== 'object' || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  if (typeof record.updatedAt !== 'string' || !Array.isArray(record.turns))
    return null;
  const rawTurns: readonly unknown[] = record.turns;
  const turns: NotedChat['turns'] = [];
  for (const turn of rawTurns) {
    if (typeof turn !== 'object' || turn === null) continue;
    const entry: Record<string, unknown> = { ...turn };
    if (typeof entry.messageId !== 'string' || !Array.isArray(entry.notices))
      continue;
    const rawNotices: readonly unknown[] = entry.notices;
    const notices = rawNotices
      .map(parseNotice)
      .filter((notice): notice is CloudTurnNotice => notice !== null);
    turns.push({ messageId: entry.messageId, notices });
  }
  return { updatedAt: record.updatedAt, turns };
}

/**
 * Notes on cloud chat turns, keyed by account, chat and message (CAN-6176).
 * Bounded per turn, per chat and per file, and pruned with the chat.
 */
export class CloudTurnNoticeStore {
  constructor(
    private readonly filePath: string,
    private readonly now: () => string = (): string => new Date().toISOString(),
  ) {}

  static inDataDir(dataDir: string): CloudTurnNoticeStore {
    return new CloudTurnNoticeStore(path.join(dataDir, FILE_NAME));
  }

  /** An unreadable file, or one a newer app wrote, reads as no notes. */
  private read(): Record<string, NotedChat> {
    const entries = readEntries(this.filePath);
    if (entries === 'newer') return {};
    const chats: Record<string, NotedChat> = {};
    for (const [key, value] of Object.entries(entries)) {
      const chat = parseChat(value);
      if (chat !== null) chats[key] = chat;
    }
    return chats;
  }

  /** The notes on each noted turn of one chat, by message id. */
  list(accountId: string, chatId: string): Record<string, CloudTurnNotice[]> {
    const chat = this.read()[chatKey(accountId, chatId)];
    return Object.fromEntries(
      (chat?.turns ?? []).map((turn) => [turn.messageId, turn.notices]),
    );
  }

  record(
    accountId: string,
    chatId: string,
    messageId: string,
    notices: readonly CloudTurnNotice[],
  ): void {
    if (notices.length === 0) return;
    const chats = this.read();
    const key = chatKey(accountId, chatId);
    const turns = (chats[key]?.turns ?? []).filter(
      (turn) => turn.messageId !== messageId,
    );
    turns.push({
      messageId,
      notices: notices.slice(0, MAX_NOTICES_PER_TURN).map((notice) => ({
        kind: notice.kind,
        name: notice.name.slice(0, MAX_NAME_LENGTH),
      })),
    });
    chats[key] = {
      updatedAt: this.now(),
      turns: turns.slice(-MAX_NOTED_TURNS_PER_CHAT),
    };
    const kept = Object.entries(chats)
      .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_NOTED_CHATS);
    this.write(Object.fromEntries(kept));
  }

  /** Forgets a chat's notes, as deleting or archiving the chat does. */
  prune(accountId: string, chatId: string): void {
    const chats = this.read();
    const key = chatKey(accountId, chatId);
    if (!(key in chats)) return;
    delete chats[key];
    this.write(chats);
  }

  private write(chats: Record<string, NotedChat>): void {
    if (readEntries(this.filePath) === 'newer')
      throw new Error(NEWER_FILE_MESSAGE);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: FILE_VERSION, entries: chats })}\n`,
      'utf8',
    );
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}
