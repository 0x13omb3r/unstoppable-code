import {
  APP_ADVISOR_PROJECT_ID,
  type WorkspaceLayoutMode,
} from '@canopy/desktop-shared/types';
import {
  initializePanelLayoutModeFile,
  readPanelLayoutModeFile,
  savePanelLayoutModeFile,
  type PanelLayoutModeFileTarget,
} from '@canopy/desktop-shared/node/lib/panel-layout-mode';
import { getWorktreePanelLayoutModeFilePath } from '../lib/paths';

function target(
  projectId: string,
  worktreeId: string,
): PanelLayoutModeFileTarget {
  return {
    workspaceId: projectId,
    worktreeId,
    filePath: getWorktreePanelLayoutModeFilePath(projectId, worktreeId),
  };
}

export class PanelLayoutModePersistenceStore {
  public load(
    projectId: string,
    worktreeId: string,
  ): Promise<WorkspaceLayoutMode | null> {
    // Default Bot only: its global panel has no per-worktree layout file.
    if (projectId === APP_ADVISOR_PROJECT_ID) return Promise.resolve(null);
    return readPanelLayoutModeFile(target(projectId, worktreeId));
  }

  public initialize(
    projectId: string,
    worktreeId: string,
    mode: WorkspaceLayoutMode,
  ): Promise<WorkspaceLayoutMode> {
    // Default Bot only: its global panel always uses the advanced layout.
    if (projectId === APP_ADVISOR_PROJECT_ID) {
      return Promise.resolve('advanced');
    }
    return initializePanelLayoutModeFile(target(projectId, worktreeId), mode);
  }

  public save(
    projectId: string,
    worktreeId: string,
    mode: WorkspaceLayoutMode,
  ): Promise<void> {
    // Default Bot only: it has no per-worktree layout preference to save.
    if (projectId === APP_ADVISOR_PROJECT_ID) return Promise.resolve();
    return savePanelLayoutModeFile(target(projectId, worktreeId), mode);
  }
}

export const panelLayoutModePersistenceStore =
  new PanelLayoutModePersistenceStore();
