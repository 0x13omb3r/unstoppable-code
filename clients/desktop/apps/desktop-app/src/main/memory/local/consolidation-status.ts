import type { LocalMemoryConsolidationStatus } from '@canopy/desktop-shared/types';
import {
  isLocalMemoryConsolidationRunning,
  isLocalMemoryRebuildRunning,
} from './consolidation-run-tracker';
import { readConsolidationStatusState } from './consolidation-state';
import { listPendingInboxNotes } from './pending-sources';

/** Pending inbox notes, as consolidation reads them; unreadable counts none. */
async function countPendingInboxNotes(scopeDir: string): Promise<number> {
  return (await listPendingInboxNotes(scopeDir).catch(() => [])).length;
}

export async function readLocalMemoryConsolidationStatus(
  scopeDir: string,
): Promise<LocalMemoryConsolidationStatus> {
  const [pendingNotes, state] = await Promise.all([
    countPendingInboxNotes(scopeDir),
    readConsolidationStatusState(scopeDir).catch(() => null),
  ]);
  return {
    pendingNotes,
    metrics: state?.history?.[state.history.length - 1]?.metrics ?? null,
    running: isLocalMemoryConsolidationRunning(scopeDir),
    rebuilding: isLocalMemoryRebuildRunning(scopeDir),
    lastRunAt: state?.lastRunAt ?? state?.lastConsolidatedAt ?? null,
    lastResult:
      state?.lastResult ?? (state?.lastConsolidatedAt ? 'success' : null),
    lastReason: state?.lastReason ?? null,
    lastConsolidatedAt: state?.lastConsolidatedAt ?? null,
  };
}
