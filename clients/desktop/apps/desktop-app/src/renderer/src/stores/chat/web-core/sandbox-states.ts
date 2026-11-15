import type { CoreChatSandbox } from '@canopy/protocol/canopy-core';
import { create } from 'zustand';

export type CloudSandboxState = CoreChatSandbox['state'];

/**
 * Each cloud chat's sandbox as the web core last reported it, by the store's
 * chat key (`liveReplyKey`): asleep, waking, ready or unknown (CAN-6766).
 * The web core reports it in the chat's snapshot and in `sandbox.changed`,
 * from Core's sandbox record and from what it observes: any wake, including
 * a Files wake, reads waking until a call succeeds or the record says ready.
 * A chat it has not reported is absent.
 */
interface SandboxStates {
  readonly byChat: Readonly<Record<string, CloudSandboxState>>;
  /**
   * The newest state any of a worktree's chats reported, by
   * `projectId/worktreeId`, with the task revision it came from: a task's
   * chats share its sandbox and its revision (CAN-6766). Newest is by that
   * revision, never by arrival, so a late older report doesn't overwrite it.
   */
  readonly byWorktree: Readonly<Record<string, WorktreeSandbox>>;
  /** `revision` is the task revision the report came from, when known. */
  readonly set: (
    key: string,
    state: CloudSandboxState,
    revision?: number,
  ) => void;
  readonly clear: () => void;
}

interface WorktreeSandbox {
  readonly state: CloudSandboxState;
  readonly revision: number | null;
}

/** A chat key's worktree, `projectId/worktreeId`, or null for a bad key. */
function worktreeOfKey(key: string): string | null {
  const last = key.lastIndexOf('/');
  return last > 0 ? key.slice(0, last) : null;
}

export const useCloudSandboxStateStore = create<SandboxStates>((set) => ({
  byChat: {},
  byWorktree: {},
  set: (key, next, revision): void =>
    set((state) => {
      const worktree = worktreeOfKey(key);
      const held = worktree === null ? undefined : state.byWorktree[worktree];
      // A report from an older task revision than the one held is stale.
      const newer =
        worktree !== null &&
        (held === undefined ||
          revision === undefined ||
          held.revision === null ||
          revision >= held.revision);
      const byWorktree =
        newer && (held?.state !== next || held.revision !== (revision ?? null))
          ? {
              ...state.byWorktree,
              [worktree]: { state: next, revision: revision ?? null },
            }
          : state.byWorktree;
      if (state.byChat[key] === next && byWorktree === state.byWorktree)
        return state;
      return { byChat: { ...state.byChat, [key]: next }, byWorktree };
    }),
  clear: (): void => set({ byChat: {}, byWorktree: {} }),
}));

/**
 * A worktree's sandbox state, as any of its chats last reported it; null
 * before the web core reports one.
 */
export function useCloudWorktreeSandboxState(
  projectId: string | null,
  worktreeId: string | null,
): CloudSandboxState | null {
  return useCloudSandboxStateStore((state) =>
    projectId === null || worktreeId === null
      ? null
      : (state.byWorktree[`${projectId}/${worktreeId}`]?.state ?? null),
  );
}

/** The chat's sandbox state by `liveReplyKey`; null before the web core reports one. */
export function useCloudSandboxState(
  key: string | null,
): CloudSandboxState | null {
  return useCloudSandboxStateStore((state) =>
    key === null ? null : (state.byChat[key] ?? null),
  );
}
