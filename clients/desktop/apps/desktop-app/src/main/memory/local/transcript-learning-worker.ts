import { parentPort, workerData } from 'node:worker_threads';
import { readPinnedCommittedTranscript } from '../../lib/chat-transcript-log';
import { groundedChatFacts } from '@canopy/memory-consolidation/transcript-extraction';
import { collectChatEvidence } from './transcript-learning-evidence';
import { prepareInboxNote } from './prepared-note';
import {
  ChatLearningWorkerRequestSchema,
  type ChatLearningWorkerResult,
} from './transcript-learning-protocol';
import { z } from 'zod';

const envelope = z.object({
  request: ChatLearningWorkerRequestSchema,
  deadline: z.number().finite(),
});
async function run(): Promise<ChatLearningWorkerResult> {
  const { request, deadline } = envelope.parse(workerData);
  const current = (): boolean => Date.now() < deadline;
  if (!current()) throw new Error('Chat learning deadline exceeded');
  if (request.kind === 'extract') {
    const evidence = await collectChatEvidence(
      readPinnedCommittedTranscript(request.snapshot, deadline),
      new Set(request.allowed),
      current,
    );
    return { kind: 'evidence', evidence, prompt: JSON.stringify(evidence) };
  }
  const notes = groundedChatFacts(request.value, request.evidence).flatMap(
    (text) => {
      if (!current()) throw new Error('Chat learning deadline exceeded');
      const note = prepareInboxNote({
        text,
        source: request.source,
        ...(request.origin ? { origin: request.origin } : {}),
      });
      return note ? [note] : [];
    },
  );
  return { kind: 'notes', notes };
}
void run()
  .then(
    (result) => parentPort?.postMessage(result),
    () => {
      parentPort?.postMessage({ error: 'Chat learning worker failed' });
    },
  )
  .finally(() => parentPort?.close());
