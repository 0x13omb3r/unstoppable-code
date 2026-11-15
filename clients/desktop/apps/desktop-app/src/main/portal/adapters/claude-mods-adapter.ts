import {
  parseClaudeModsGetArgs,
  parseClaudeModsUpdate,
} from '@canopy/protocol/claude-mods';
import { parseClaudeModSurfaceCommandArgs } from '@canopy/protocol/extension-ui';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import { runClaudeModSurfaceCommand } from '../../agents/claude-mod-surface-bridge';
import { broadcastCommittedPreferences } from '../../ipc/preferences';
import {
  getClaudeModsState,
  updateClaudeModsState,
} from '../../lib/claude-mod-admission-service';
import type { PortalAdapterContext } from './types';
import { failServiceError } from './validation';

export async function handlePortalClaudeModsGet(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const args = parseClaudeModsGetArgs(command.payload);
  if (args === null) {
    context.fail(command, 'invalid_payload', 'Invalid Claude Mod get payload.');
    return;
  }
  try {
    const state = await getClaudeModsState(args);
    context.complete(command, state);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalClaudeModsUpdate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const update = parseClaudeModsUpdate(command.payload);
  if (update === null) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid Claude Mod update payload.',
    );
    return;
  }
  try {
    // A typed refusal (including flag-off) is still a completed command.
    const result = await updateClaudeModsState(
      update,
      broadcastCommittedPreferences,
    );
    context.complete(command, result);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * What the person did on a chat's Mod surface in the web Portal, run as the
 * desktop's own window command is. A chat whose session is gone, or not
 * drawing its surface, ignores it, and the command still completes.
 */
export async function handlePortalClaudeModSurfaceCommand(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const args = parseClaudeModSurfaceCommandArgs(command.payload);
  // Only a desktop window answers a Mod's ask of its composer.
  if (args === null || args.command.kind === 'composer-answer') {
    context.fail(
      command,
      'invalid_payload',
      'Invalid Claude Mod surface command payload.',
    );
    return;
  }
  try {
    await runClaudeModSurfaceCommand(args);
    context.complete(command, {});
  } catch (error) {
    failServiceError(command, context, error);
  }
}
