import type { PinnedCommittedTranscript } from '../../lib/chat-transcript-log';
import type { LearningTurn } from './transcript-learning-state';
import { CHAT_LEARNING_WORKER_LIMITS } from './transcript-learning-protocol';

/** The canonical service pins handles; only the thread reads/parses their bytes.
 * Uncommitted/journaled rows are deferred, never copied from main to the thread.
 */
export async function readLearningTranscript<T>(
  ref: LearningTurn,
  consume: (
    snapshot: PinnedCommittedTranscript,
    signal: AbortSignal,
  ) => Promise<T>,
  isCurrent: () => boolean,
): Promise<T> {
  const { getChatStateService } =
    await import('../../services/chat-state-service');
  return getChatStateService().consumeTranscriptPreview(
    { projectId: ref.projectId, worktreeId: ref.worktreeId },
    ref.chatId,
    () =>
      Promise.reject(
        new Error('Learning must not parse transcript rows on main'),
      ),
    isCurrent,
    undefined,
    (preview) =>
      preview.consumeCommittedInThread(consume, CHAT_LEARNING_WORKER_LIMITS),
  );
}
