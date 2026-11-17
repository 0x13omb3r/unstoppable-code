import { decodeString } from 'micromark-util-decode-string';
import type { ConsolidationOutput } from './input';
import { titleFromProbeHead } from './memory-summary';
import { topicIdentity } from './topic-identity';
import {
  escapeMemoryReferenceText,
  findTopicReferences,
} from './topic-reference';

export interface UnresolvedTopicLink {
  source: string;
  target: string;
}

export interface MemoryLinkHealth {
  unresolvedLinks: UnresolvedTopicLink[];
  orphanTopics: string[];
  /** Existing targets whose reference spelling still needs canonicalization. */
  pendingRepairCount?: number;
}

/**
 * Reconcile canonical occurrences and saved retries without adding their
 * counts together. Maximum multiplicity preserves repeated real references
 * and legacy sidecar-only targets while keeping unchanged passes stable.
 */
export function mergeUnresolvedMemoryLinks(
  ...lists: (readonly UnresolvedTopicLink[])[]
): MemoryLinkHealth['unresolvedLinks'] {
  const merged = new Map<string, MemoryLinkHealth['unresolvedLinks']>();
  for (const links of lists) {
    const occurrences = new Map<string, MemoryLinkHealth['unresolvedLinks']>();
    for (const link of links) {
      const key = JSON.stringify([link.source, link.target]);
      const group = occurrences.get(key) ?? [];
      group.push(link);
      occurrences.set(key, group);
    }
    for (const [key, group] of occurrences) {
      if (group.length > (merged.get(key)?.length ?? 0)) merged.set(key, group);
    }
  }
  return Array.from(merged.values()).flat();
}

function alias(filename: string): string {
  return filename
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[-_.\s]+/g, '');
}

/** Exact identity first, then an unambiguous spelling/heading alias only. */
function topicResolver(
  topics: NonNullable<ConsolidationOutput['topicFiles']>,
): (filename: string) => string | undefined {
  const exact = new Map(
    topics.map((topic) => [topicIdentity(topic.filename), topic.filename]),
  );
  const aliases = new Map<string, Set<string>>();
  for (const topic of topics) {
    // Share the explorer's linear ATX parser: literal title hashes,
    // indented code and non-Markdown whitespace must not invent aliases.
    const heading = titleFromProbeHead(topic.content, { inbox: false });
    for (const name of [topic.filename, ...(heading ? [heading] : [])]) {
      const key = alias(name);
      const values = aliases.get(key) ?? new Set<string>();
      values.add(topic.filename);
      aliases.set(key, values);
    }
  }
  return (filename): string | undefined => {
    const found = exact.get(topicIdentity(filename));
    if (found !== undefined) return found;
    const candidates = aliases.get(alias(filename));
    return candidates?.size === 1
      ? candidates.values().next().value
      : undefined;
  };
}

export function inspectMemoryLinks(
  tree: ConsolidationOutput,
): MemoryLinkHealth {
  const topics = tree.topicFiles ?? [];
  const resolve = topicResolver(topics);
  const incoming = new Set<string>();
  const unresolvedLinks: UnresolvedTopicLink[] = [];
  let pendingRepairCount = 0;
  for (const document of [
    { filename: 'MEMORY.md', content: tree.memoryMd },
    ...topics.map((topic) => ({
      ...topic,
      filename: `topics/${topic.filename}`,
    })),
  ]) {
    for (const reference of findTopicReferences(
      document.content,
      document.filename,
    )) {
      const filename = reference.filename ?? reference.aliasFilename;
      const canonical = filename === null ? undefined : resolve(filename);
      if (canonical === undefined) {
        unresolvedLinks.push({
          source: document.filename,
          target: reference.encodedPath,
        });
      } else {
        const expected =
          reference.span.destination && document.filename.startsWith('topics/')
            ? canonical
            : `topics/${canonical}`;
        if (decodeString(reference.encodedPath) !== expected)
          pendingRepairCount += 1;
        if (
          topicIdentity(document.filename) !==
          topicIdentity(`topics/${canonical}`)
        ) {
          incoming.add(topicIdentity(canonical));
        }
      }
    }
  }
  return {
    unresolvedLinks,
    ...(pendingRepairCount > 0 ? { pendingRepairCount } : {}),
    orphanTopics: topics
      .filter((topic) => !incoming.has(topicIdentity(topic.filename)))
      .map((topic) => topic.filename),
  };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

export function repairMemoryLinks(tree: ConsolidationOutput): {
  tree: ConsolidationOutput;
  health: MemoryLinkHealth;
  repairedLinkCount: number;
  repairedLinkCounts: ReadonlyMap<string, number>;
} {
  const topics = tree.topicFiles ?? [];
  const resolve = topicResolver(topics);
  let repairedLinkCount = 0;
  const repairedLinkCounts = new Map<string, number>();
  const repair = (source: string, sourceFileKey: string): string => {
    const edits: Edit[] = [];
    for (const reference of findTopicReferences(source, sourceFileKey)) {
      const { span, index, encodedPath } = reference;
      const start = span.offsets[index];
      const filename = reference.filename ?? reference.aliasFilename;
      const canonical = filename === null ? undefined : resolve(filename);
      // Canonical documents are the retry state shared by every host. Keep
      // the destination (and label) until it can resolve, even when this pair
      // was omitted from the model's bounded Link health section. Unlinking
      // here would leave a fresh cloud or desktop replica no target to retry.
      if (canonical === undefined) continue;
      const text =
        span.destination && sourceFileKey.startsWith('topics/')
          ? canonical
          : `topics/${canonical}`;
      if (
        decodeString(
          source.slice(start, span.offsets[index + encodedPath.length]),
        ) === text
      )
        continue;
      edits.push({
        start,
        end: span.offsets[index + encodedPath.length],
        text:
          span.destination || span.literal
            ? text
            : escapeMemoryReferenceText(text),
      });
      repairedLinkCount += 1;
      repairedLinkCounts.set(
        sourceFileKey,
        (repairedLinkCounts.get(sourceFileKey) ?? 0) + 1,
      );
    }
    if (edits.length === 0) return source;
    const replacements = new Map(edits.map((edit) => [edit.start, edit]));
    // Walk forward once and join disjoint original slices once. No destination
    // rescans, edit sorting or repeated document rebuilding.
    const pieces: string[] = [];
    let copied = 0;
    let index = 0;
    while (index < source.length) {
      const replacement = replacements.get(index);
      if (replacement !== undefined) {
        if (index > copied) pieces.push(source.slice(copied, index));
        pieces.push(replacement.text);
        index = replacement.end;
        copied = index;
      } else index += 1;
    }
    pieces.push(source.slice(copied));
    return pieces.join('');
  };
  const health = inspectMemoryLinks(tree);
  return {
    tree: {
      memoryMd: repair(tree.memoryMd, 'MEMORY.md'),
      topicFiles: topics.map((topic) => ({
        ...topic,
        content: repair(topic.content, `topics/${topic.filename}`),
      })),
    },
    health,
    repairedLinkCount,
    repairedLinkCounts,
  };
}
