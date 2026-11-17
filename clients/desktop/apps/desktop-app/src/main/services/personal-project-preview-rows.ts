import { isAbsolute } from 'node:path';
import type { PersonalProject } from '@canopy/protocol/organizations';
import { canRetireTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import { countArchivedContainers } from '../lib/archived-containers';
import { readWorkspaceIndexStoredDetailed } from '../lib/sidebar-items';
import {
  getWorkspaceManifestRepository,
  hasCommittedWorkspaceWorktrees,
} from '../lib/workspace-persistence';

/** Preview metadata. Repository eligibility is checked when moving. */
export async function readPersonalProjectPreviewRows(
  signal?: AbortSignal,
): Promise<PersonalProject[]> {
  signal?.throwIfAborted();
  const { entries, authority } = await readWorkspaceIndexStoredDetailed();
  if (authority !== 'ok' && authority !== 'absent')
    throw new Error('Workspace index unavailable');
  signal?.throwIfAborted();
  const manifests = getWorkspaceManifestRepository();
  const rows = await Promise.all(
    [...entries]
      .sort((left, right) => left.order - right.order)
      .map(async ({ id, name, type }): Promise<PersonalProject | null> => {
        if (type !== 'single-repo' && type !== 'multi-repo') return null;
        const manifest = await manifests.read(id);
        signal?.throwIfAborted();
        if (manifest.authority !== 'ok') return null;
        const { owner, repoPath, temporary, alwaysShow } = manifest.document;
        // A malformed owner is also ineligible until ownership can be read.
        if (owner !== undefined) return null;
        if (
          type === 'single-repo' &&
          (typeof repoPath !== 'string' || !isAbsolute(repoPath))
        )
          return null;
        if (
          canRetireTemporaryWorkspace({
            type,
            temporary: temporary === true,
            alwaysShow: alwaysShow === true,
          })
        ) {
          const hasWorktrees = await hasCommittedWorkspaceWorktrees(id);
          signal?.throwIfAborted();
          if (!hasWorktrees) {
            const archived = await countArchivedContainers(id, {
              waitForMutation: false,
            }).catch(() => 0);
            signal?.throwIfAborted();
            if (archived === 0) return null;
          }
        }
        return { workspaceId: id, name, kind: type };
      }),
  );
  return rows.filter((row) => row !== null);
}
