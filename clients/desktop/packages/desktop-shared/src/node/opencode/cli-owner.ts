import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { classifyPersistedWorkspaceOwner } from '@canopy/protocol/workspace-owner';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { OpenCodePromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';

export interface CliOpenCodeOwner {
  owner: WorkOwner;
  organizationProjectId?: string;
  /** Includes the persisted binding generation, so a transfer ends the turn. */
  binding: string;
}

/** Authority read: malformed bindings never become Personal. */
export async function readCliOpenCodeOwner(
  request: Pick<OpenCodePromptRunnerRequest, 'projectId' | 'executionContext'>,
): Promise<CliOpenCodeOwner> {
  const context =
    request.executionContext === undefined
      ? undefined
      : parseWorkspaceContext(request.executionContext);
  if (context === null) throw new Error('The workflow context is invalid.');
  if (!request.projectId) {
    const owner: WorkOwner = context ?? { kind: 'personal' };
    return { owner, binding: JSON.stringify(owner) };
  }
  validateId(request.projectId, 'projectId');
  const value: unknown = JSON.parse(
    await readFile(
      join(
        getCanopyDataDir(),
        'workspaces',
        request.projectId,
        'workspace.json',
      ),
      'utf8',
    ),
  );
  if (!isRecord(value) || value.version !== 1)
    throw new Error('The workspace owner is unreadable.');
  const classified = classifyPersistedWorkspaceOwner(value.owner);
  if (classified.kind === 'malformed')
    throw new Error('The workspace owner is unreadable.');
  const owner: WorkOwner =
    classified.kind === 'organization'
      ? {
          kind: 'organization',
          organizationId: classified.owner.organizationId,
        }
      : { kind: 'personal' };
  if (context && JSON.stringify(context) !== JSON.stringify(owner))
    throw new Error('The workflow context does not match the workspace owner.');
  return {
    owner,
    binding: JSON.stringify(classified),
    ...(classified.kind === 'organization'
      ? { organizationProjectId: classified.owner.projectId }
      : {}),
  };
}
