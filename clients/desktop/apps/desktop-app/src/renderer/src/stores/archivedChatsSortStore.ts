import { create } from 'zustand';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  DEFAULT_ARCHIVED_CHAT_SORT,
  isArchivedChatSort,
  type ArchivedChatSort,
} from '@canopy/ui-shared/lib';

/**
 * The Archived chats dialog's sort, one choice for every worktree, kept so it
 * survives a restart. A renderer-only UI choice, like the other `canopy.*`
 * keys: it stays on this device, and another window reads it on its next load.
 */
export const ARCHIVED_CHATS_SORT_STORAGE_KEY = 'canopy.archivedChats.sort';

function readSort(): ArchivedChatSort {
  try {
    const raw = window.localStorage.getItem(ARCHIVED_CHATS_SORT_STORAGE_KEY);
    return isArchivedChatSort(raw) ? raw : DEFAULT_ARCHIVED_CHAT_SORT;
  } catch (error) {
    // Storage unavailable: start on the default sort.
    reportClientAppError(error);
    return DEFAULT_ARCHIVED_CHAT_SORT;
  }
}

function writeSort(sort: ArchivedChatSort): void {
  try {
    window.localStorage.setItem(ARCHIVED_CHATS_SORT_STORAGE_KEY, sort);
  } catch (error) {
    // Storage full or unavailable: the choice still holds for this session.
    reportClientAppError(error);
  }
}

interface ArchivedChatsSortState {
  readonly sort: ArchivedChatSort;
  readonly setSort: (sort: ArchivedChatSort) => void;
}

export const useArchivedChatsSortStore = create<ArchivedChatsSortState>(
  (set) => ({
    sort: readSort(),
    setSort: (sort): void => {
      writeSort(sort);
      set({ sort });
    },
  }),
);
