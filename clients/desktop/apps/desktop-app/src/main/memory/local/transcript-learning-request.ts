import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import { getActiveDesktopRuntimeIfAccepting } from '../../canopy-runtime/desktop-runtime';
import { CHAT_LEARNING_SCHEDULER_CALLER } from './transcript-learning-caller';
import { chatLearningEnabled } from './transcript-learning-recorder';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from '../../lib/background-helper-queue';

export async function requestChatLearning(
  scope: LocalMemoryScopeRequest,
): Promise<void> {
  if (!(await chatLearningEnabled())) return;
  const runtime = getActiveDesktopRuntimeIfAccepting();
  if (!runtime) return;
  await enqueueBackgroundHelperTask({
    priority: BACKGROUND_HELPER_PRIORITIES.memoryConsolidation,
    task: async () => {
      await runtime.instruction(
        'core.memory.chats.learn',
        {
          memory: scope.scope,
          ...(scope.scope === 'workspace'
            ? { workspaceId: scope.workspaceId }
            : {}),
        },
        {
          caller: CHAT_LEARNING_SCHEDULER_CALLER,
        },
      );
    },
  });
}
