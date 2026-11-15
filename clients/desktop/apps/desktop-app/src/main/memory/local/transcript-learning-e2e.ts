import { z } from 'zod';
import { isE2eBuild } from '../../lib/e2e-gate';
import { runLocalMemoryLearningPassForE2e } from './consolidation-scheduler';

const requestSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('user') }).strict(),
  z
    .object({
      scope: z.literal('workspace'),
      workspaceId: z.string().trim().min(1),
    })
    .strict(),
]);

/** Main-process evaluation only; no renderer, IPC, Portal or production route. */
export async function runChatLearningPassForE2e(input: unknown): Promise<void> {
  if (!isE2eBuild()) throw new Error('Test-only memory pass unavailable');
  await runLocalMemoryLearningPassForE2e(requestSchema.parse(input));
}
