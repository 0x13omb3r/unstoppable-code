import type {
  DurableTerminalRecord,
  DurableTerminalRecordStore,
} from '@canopy/app-state/core-cowork';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

const STORAGE_KEY = 'canopy.webCoreTerminalRecords.v1';
/** Records kept; the least recently saved drop first. */
const STORED_RECORD_LIMIT = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function terminalRecordOf(value: unknown): DurableTerminalRecord | null {
  if (!isRecord(value)) return null;
  const { sessionId, projectId, worktreeId, chatId, shellTerminalId } = value;
  const { createdAt } = value;
  if (
    typeof sessionId !== 'string' ||
    typeof projectId !== 'string' ||
    typeof worktreeId !== 'string' ||
    typeof chatId !== 'string' ||
    (shellTerminalId !== null && typeof shellTerminalId !== 'string') ||
    typeof createdAt !== 'number'
  )
    return null;
  return {
    sessionId,
    projectId,
    worktreeId,
    chatId,
    shellTerminalId,
    createdAt,
  };
}

function readRecords(storage: Storage): DurableTerminalRecord[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => terminalRecordOf(value) ?? []);
  } catch (error) {
    // Unreadable records: each bound tab then shows as ended, with restart.
    reportClientAppError(error);
    return [];
  }
}

function writeRecords(
  storage: Storage,
  records: readonly DurableTerminalRecord[],
): void {
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify(records.slice(-STORED_RECORD_LIMIT)),
    );
  } catch (error) {
    // Storage full or unavailable: the terminals still work for this page.
    reportClientAppError(error);
  }
}

/**
 * This window's cloud terminal records (CAN-6939), beside the panel layouts
 * that bind them (`panel-layout-storage.ts`). They hold no credentials.
 */
export function createCloudTerminalRecordStore(
  storage: Storage = window.localStorage,
): DurableTerminalRecordStore {
  return {
    list: (projectId, worktreeId) =>
      readRecords(storage).filter(
        (record) =>
          record.projectId === projectId && record.worktreeId === worktreeId,
      ),
    put: (record) =>
      writeRecords(storage, [
        ...readRecords(storage).filter(
          (saved) => saved.sessionId !== record.sessionId,
        ),
        record,
      ]),
    remove: (sessionId) => {
      const records = readRecords(storage);
      const kept = records.filter((saved) => saved.sessionId !== sessionId);
      if (kept.length !== records.length) writeRecords(storage, kept);
    },
  };
}
