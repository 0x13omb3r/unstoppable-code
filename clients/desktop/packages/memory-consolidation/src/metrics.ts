import type { MemoryConsolidationMetrics } from '@canopy/protocol/local-memory';
import type { ConsolidationOutput } from './input';
import { inspectMemoryLinks } from './link-health';

export function memoryTreeBytes(tree: ConsolidationOutput): number {
  return (
    new TextEncoder().encode(tree.memoryMd).length +
    (tree.topicFiles ?? []).reduce(
      (sum, topic) => sum + new TextEncoder().encode(topic.content).length,
      0,
    )
  );
}

/** Raw UTF-8 document bytes, excluding bookkeeping and prompt envelopes. */
export function measureMemoryConsolidation(
  before: ConsolidationOutput,
  after: ConsolidationOutput,
  inputBytes: number,
  repairedLinkCount = 0,
  brokenLinkCount?: number,
): MemoryConsolidationMetrics {
  const health = inspectMemoryLinks(after);
  const indexBytes = new TextEncoder().encode(after.memoryMd).length;
  const topicBytes = memoryTreeBytes(after) - indexBytes;
  const growthBytes = indexBytes + topicBytes - memoryTreeBytes(before);
  return {
    indexBytes,
    topicCount: after.topicFiles?.length ?? 0,
    topicBytes,
    inputBytes,
    growthBytes,
    growthRatio: inputBytes === 0 ? null : growthBytes / inputBytes,
    brokenLinkCount: brokenLinkCount ?? health.unresolvedLinks.length,
    orphanTopicCount: health.orphanTopics.length,
    repairedLinkCount,
  };
}
