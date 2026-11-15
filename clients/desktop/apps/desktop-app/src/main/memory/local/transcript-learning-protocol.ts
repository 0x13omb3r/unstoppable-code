import { z } from 'zod';

export const CHAT_LEARNING_WORKER_LIMITS = {
  bytes: 16 * 1024 * 1024,
  rows: 20_000,
};
export const CHAT_LEARNING_WORKER_TIMEOUT_MS = 5_000;
export const CHAT_LEARNING_MAX_EVIDENCE_ENTRIES = 256;
const id = z.string().min(1).max(512);
const origin = z.object({
  organizationId: id.optional(),
  projectId: id.optional(),
});
const evidence = z
  .array(
    z.object({
      turnId: id,
      role: z.enum(['user', 'assistant']),
      text: z.string().max(3000),
      at: z.string().datetime(),
    }),
  )
  .max(CHAT_LEARNING_MAX_EVIDENCE_ENTRIES);
export const ChatLearningWorkerRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('extract'),
    snapshot: z.object({
      fd: z.number().int().nonnegative(),
      size: z.number().int().min(0).max(CHAT_LEARNING_WORKER_LIMITS.bytes),
      count: z.number().int().min(0).max(CHAT_LEARNING_WORKER_LIMITS.rows),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    allowed: z.array(id).max(200),
  }),
  z.object({
    kind: z.literal('render'),
    evidence,
    value: z.object({
      facts: z
        .array(
          z.object({
            text: z
              .string()
              .min(1)
              .max(500)
              .refine((value) => value.trim().length > 0),
            evidence: z
              .array(
                z.object({
                  turnId: id,
                  role: z.enum(['user', 'assistant']),
                  quote: z
                    .string()
                    .min(1)
                    .max(300)
                    .refine((value) => value.trim().length > 0),
                }),
              )
              .min(1)
              .max(2),
          }),
        )
        .max(5),
    }),
    source: z.object({ provider: id, chatId: id }),
    origin: origin.optional(),
  }),
]);
export type ChatLearningWorkerRequest = z.output<
  typeof ChatLearningWorkerRequestSchema
>;
export const ChatLearningWorkerResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('evidence'),
    evidence,
    prompt: z.string().max(24_000),
  }),
  z.object({
    kind: z.literal('notes'),
    notes: z
      .array(
        z.object({
          filename: z
            .string()
            .max(200)
            .regex(/^[a-zA-Z0-9_-]+\.md$/),
          noteId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
          content: z.string().max(12_000),
          origin: origin.optional(),
        }),
      )
      .max(5),
  }),
]);
export type ChatLearningWorkerResult = z.output<
  typeof ChatLearningWorkerResultSchema
>;
