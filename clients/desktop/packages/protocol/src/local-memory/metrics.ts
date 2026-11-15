import { z } from 'zod';

/** Content-free, finite measurements of a completed consolidation run. */
export const MemoryConsolidationMetricsSchema = z.strictObject({
  indexBytes: z.int().min(0),
  topicCount: z.int().min(0),
  topicBytes: z.int().min(0),
  inputBytes: z.int().min(0),
  growthBytes: z.int(),
  growthRatio: z.number().nullable(),
  brokenLinkCount: z.int().min(0),
  orphanTopicCount: z.int().min(0),
  repairedLinkCount: z.int().min(0),
});
export type MemoryConsolidationMetrics = z.output<
  typeof MemoryConsolidationMetricsSchema
>;

export const MemoryConsolidationMeasurementSchema = z.strictObject({
  result: z.enum([
    'success',
    'partial',
    'clean',
    'cancelled',
    'invalid-output',
    'failed',
  ]),
  metrics: MemoryConsolidationMetricsSchema,
});
export type MemoryConsolidationMeasurement = z.output<
  typeof MemoryConsolidationMeasurementSchema
>;

export const MemoryConsolidationHistoryEntrySchema =
  MemoryConsolidationMeasurementSchema.extend({
    at: z.iso.datetime(),
    // Old clients can commit a run without measurements. Keep that absence
    // explicit instead of presenting an older run as this one's measurement.
    metrics: MemoryConsolidationMetricsSchema.nullable(),
  });
