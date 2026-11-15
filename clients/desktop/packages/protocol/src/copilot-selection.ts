import { z } from 'zod';
import { VaultSecretPinSchema } from './canopy-core';

const id = z.string().min(1).max(512);
export const CopilotSelectionIdentitySchema = z
  .object({
    operationId: id,
    epoch: id,
    account: z
      .object({ host: id, login: id, id: z.string().regex(/^[0-9]{1,128}$/) })
      .strict(),
    origin: z.enum(['setup', 'import']),
  })
  .strict();
export const CopilotHostSelectionSchema = z
  .object({
    version: z.literal(1),
    identity: CopilotSelectionIdentitySchema,
    pinGeneration: id,
    pin: VaultSecretPinSchema.nullable(),
    state: z.enum(['prepared', 'selected', 'disabled']),
  })
  .strict()
  .refine((value) => value.state !== 'selected' || value.pin !== null);
export type CopilotHostSelection = z.infer<typeof CopilotHostSelectionSchema>;
export type CopilotSelectionIdentity = z.infer<
  typeof CopilotSelectionIdentitySchema
>;
