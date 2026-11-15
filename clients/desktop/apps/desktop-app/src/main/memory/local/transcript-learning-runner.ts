import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import {
  ChatLearningWorkerRequestSchema,
  ChatLearningWorkerResultSchema,
  CHAT_LEARNING_WORKER_TIMEOUT_MS,
  type ChatLearningWorkerRequest,
  type ChatLearningWorkerResult,
} from './transcript-learning-protocol';

let active = false;
/** One bounded thread at a time; never queue transcript work or fall back to main. */
export function runChatLearningWorker(
  request: ChatLearningWorkerRequest,
  signal: AbortSignal,
): Promise<ChatLearningWorkerResult> {
  if (active || signal.aborted)
    return Promise.reject(new Error('Chat learning worker unavailable'));
  const parsed = ChatLearningWorkerRequestSchema.safeParse(request);
  if (!parsed.success)
    return Promise.reject(new Error('Invalid chat learning worker request'));
  active = true;
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (error?: Error, result?: ChatLearningWorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      const release = (): void => {
        active = false;
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error('Chat learning worker returned no result'));
      };
      // The canonical host still owns the borrowed FD. Stop every read before
      // resolving, so its owner can safely close it even on abort/deadline.
      if (worker) void worker.terminate().then(release, release);
      else release();
    };
    const abort = (): void =>
      finish(new Error('Chat learning worker cancelled'));
    const deadline = Date.now() + CHAT_LEARNING_WORKER_TIMEOUT_MS;
    const timer = setTimeout(
      () => finish(new Error('Chat learning worker timed out')),
      CHAT_LEARNING_WORKER_TIMEOUT_MS,
    );
    signal.addEventListener('abort', abort, { once: true });
    try {
      worker = new Worker(
        join(__dirname, 'local-memory-chat-learning-worker.js'),
        {
          workerData: { request: parsed.data, deadline },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        },
      );
      worker.once('error', () =>
        finish(new Error('Chat learning worker failed')),
      );
      worker.once('exit', () =>
        finish(new Error('Chat learning worker exited without a result')),
      );
      worker.once('message', (message: unknown) => {
        const result = ChatLearningWorkerResultSchema.safeParse(message);
        if (Date.now() >= deadline || signal.aborted || !result.success)
          finish(new Error('Invalid chat learning worker result'));
        else finish(undefined, result.data);
      });
      if (signal.aborted) abort();
    } catch {
      finish(new Error('Chat learning worker could not start'));
    }
  });
}
