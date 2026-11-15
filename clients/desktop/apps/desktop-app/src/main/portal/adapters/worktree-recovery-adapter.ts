import {
  WorktreeRecoveryListParamsSchema,
  WorktreeRecoveryListResultSchema,
  WorktreeRecoveryResolveParamsSchema,
  WorktreeRecoveryResolveResultSchema,
  WorktreeRecoveryFinishParamsSchema,
  WorktreeRecoveryFinishResultSchema,
} from '@canopy/protocol/canopy-core';
import {
  PORTAL_CATALOG_RESULT_MAX_BYTES,
  type PortalCommandEnvelope,
} from '@canopy/protocol/portal';
import { getDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import { createPortalCaller } from '../portal-caller';
import type { PortalAdapterContext } from './types';
import { resultByteLength } from './result-budget';
import { broadcastWorktreeListToRenderer } from './worktree-adapter';
import { logMainProcessWarn } from '../../lib/main-process-logging';

/** Paired people use the same exact operation admission, never cold W5 decisions. */
export async function handlePortalWorktreeRecovery(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const listing = command.type === 'portal.worktree.recovery.list';
  const active = (): boolean =>
    listing
      ? context.canReadAssets?.() === true
      : context.canMutateResources?.() === true;
  if (context.origin || !context.sessionId || !active()) {
    context.fail(
      command,
      'forbidden',
      'Archive recovery requires a user review.',
    );
    return;
  }
  const caller = createPortalCaller({ sessionId: context.sessionId }, [
    'core.worktree.read',
    'core.worktree.write',
  ]);
  try {
    if (!listing && (!(await context.confirmArchivePairing?.()) || !active())) {
      context.fail(
        command,
        'forbidden',
        'Reconnect to the desktop before continuing archive recovery.',
      );
      return;
    }
    const runtime = getDesktopCanopyRuntime();
    let result: unknown;
    let changedWorkspace: string | undefined;
    switch (command.type) {
      case 'portal.worktree.recovery.list':
        result = WorktreeRecoveryListResultSchema.parse(
          await runtime.query(
            'core.worktree.recovery.list',
            WorktreeRecoveryListParamsSchema.parse(command.payload),
            { caller },
          ),
        );
        break;
      case 'portal.worktree.recovery.resolve':
        {
          const params = WorktreeRecoveryResolveParamsSchema.parse(
            command.payload,
          );
          result = WorktreeRecoveryResolveResultSchema.parse(
            await runtime.instruction(
              'core.worktree.recovery.resolve',
              params,
              { caller },
            ),
          );
          changedWorkspace = params.workspaceId;
        }
        break;
      case 'portal.worktree.recovery.finish':
        {
          const params = WorktreeRecoveryFinishParamsSchema.parse(
            command.payload,
          );
          result = WorktreeRecoveryFinishResultSchema.parse(
            await runtime.instruction('core.worktree.recovery.finish', params, {
              caller,
            }),
          );
          changedWorkspace = params.workspaceId;
        }
        break;
      default:
        context.fail(
          command,
          'unsupported_command',
          'Archive recovery is unavailable.',
        );
        return;
    }
    // Refuse an oversized enumeration, rather than silently hiding incidents.
    if (resultByteLength(result) > PORTAL_CATALOG_RESULT_MAX_BYTES) {
      context.fail(
        command,
        'execution_failed',
        "Couldn't show all recovery records. Review them on the computer that holds this project.",
      );
      return;
    }
    context.complete(command, result);
    if (changedWorkspace)
      void broadcastWorktreeListToRenderer(context, changedWorkspace).catch(
        (error: unknown): void => {
          logMainProcessWarn('Archive recovery renderer refresh failed', {
            error,
          });
        },
      );
  } catch {
    // Persisted errors and local filesystem targets never enter Portal output.
    context.fail(
      command,
      'execution_failed',
      "The desktop hasn't confirmed archive recovery. Check again before continuing.",
    );
  }
}
