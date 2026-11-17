import { z } from 'zod';
import {
  pagedSearchMemoryInputSchema,
  saveMemoryInputSchema,
  pagedReadMemoryInputSchema,
} from '../../tools/memory';
export const MEMORY_READ_ACTION_TYPES = [
  'memory.search',
  'memory.read',
] as const;
export const MEMORY_WRITE_ACTION_TYPES = ['memory.save'] as const;
export const memoryActionSchema = z.discriminatedUnion('type', [
  saveMemoryInputSchema.extend({ type: z.literal('memory.save') }).strict(),
  pagedSearchMemoryInputSchema
    .extend({ type: z.literal('memory.search') })
    .strict(),
  pagedReadMemoryInputSchema
    .extend({ type: z.literal('memory.read') })
    .strict(),
]);
