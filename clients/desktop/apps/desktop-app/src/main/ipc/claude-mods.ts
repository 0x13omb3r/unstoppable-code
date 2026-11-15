import {
  parseClaudeModsGetArgs,
  parseClaudeModsUpdate,
  type ClaudeModsGetArgs,
  type ClaudeModsState,
  type ClaudeModsUpdateResult,
} from '@canopy/protocol/claude-mods';
import { parseClaudeModSurfaceCommandArgs } from '@canopy/protocol/extension-ui';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { runClaudeModSurfaceCommand } from '../agents/claude-mod-surface-bridge';
import {
  getClaudeModsState,
  updateClaudeModsState,
} from '../lib/claude-mod-admission-service';
import { broadcastCommittedPreferences } from './preferences';
import { registerIpcHandler } from './register';

export function registerClaudeModsHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.claudeModsGet,
    async (_event, args: unknown): Promise<ClaudeModsState> => {
      const parsedArgs: ClaudeModsGetArgs | null = parseClaudeModsGetArgs(args);
      if (parsedArgs === null) {
        throw new Error('Invalid Claude Mod get arguments.');
      }
      return await getClaudeModsState(parsedArgs);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.claudeModsUpdate,
    async (_event, request: unknown): Promise<ClaudeModsUpdateResult> => {
      const update = parseClaudeModsUpdate(request);
      if (update === null) return { ok: false, code: 'invalid-input' };
      return await updateClaudeModsState(update, broadcastCommittedPreferences);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.claudeModSurfaceCommand,
    async (_event, args: unknown): Promise<void> => {
      const parsed = parseClaudeModSurfaceCommandArgs(args);
      if (parsed === null) {
        throw new Error('Invalid Claude Mod surface command.');
      }
      await runClaudeModSurfaceCommand(parsed);
    },
  );
}
