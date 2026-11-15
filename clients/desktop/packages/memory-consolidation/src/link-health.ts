import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
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

/** Remove inline and reference-link wrappers, keeping their original label text. */
function unlinkMissing(source: string, missing: ReadonlySet<number>): Edit[] {
  if (missing.size === 0) return [];
  // Prefix counts make every destination membership query constant time.
  const missingCounts = new Uint32Array(source.length + 1);
  for (let index = 0; index < source.length; index += 1)
    missingCounts[index + 1] =
      missingCounts[index] + (missing.has(index) ? 1 : 0);
  const hasMissing = (start: number, end: number): boolean =>
    missingCounts[end] > missingCounts[start];
  const events = postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(source, 'utf8', true)),
  );
  const definitions = new Map<
    string,
    { start: number; end: number; missing: boolean }
  >();
  const definitionList: Array<{
    start: number;
    end: number;
    missing: boolean;
  }> = [];
  const links: Array<{
    start: number;
    end: number;
    label: string;
    labelStart?: number;
    labelEnd?: number;
    inline: boolean;
    reference?: string;
    missing: boolean;
  }> = [];
  let definition:
    | { start: number; end: number; name: string; missing: boolean }
    | undefined;
  const linkStack: typeof links = [];
  // Match CommonMark's raw reference identifiers: only ASCII Markdown
  // whitespace collapses, escapes/entities stay literal, and case folding
  // runs lower then upper so multi-character Unicode forms compare equally.
  const key = (text: string): string => {
    const characters: string[] = [];
    let pendingSpace = false;
    for (const character of text) {
      if (' \t\r\n'.includes(character)) {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && characters.length > 0) characters.push(' ');
      characters.push(character);
      pendingSpace = false;
    }
    return characters.join('').toLowerCase().toUpperCase();
  };
  for (const [event, token] of events) {
    const start = token.start.offset;
    const end = token.end.offset;
    let link = linkStack[linkStack.length - 1];
    if (event === 'enter') {
      if (token.type === 'definition')
        definition = { start, end, name: '', missing: false };
      if (token.type === 'definitionLabelString' && definition)
        definition.name = key(source.slice(start, end));
      if (token.type === 'definitionDestinationString' && definition)
        definition.missing = hasMissing(start, end);
      if (token.type === 'link' || token.type === 'image') {
        link = { start, end, label: '', inline: false, missing: false };
        linkStack.push(link);
      }
      if (token.type === 'labelText' && link && link.labelStart === undefined) {
        link.label = source.slice(start, end);
        link.labelStart = start;
        link.labelEnd = end;
      }
      if (token.type === 'resource' && link) link.inline = true;
      if (token.type === 'referenceString' && link)
        link.reference = key(source.slice(start, end));
      if (token.type === 'resourceDestinationString' && link)
        link.missing = hasMissing(start, end);
    } else {
      if (token.type === 'definition' && definition) {
        if (!definitions.has(definition.name))
          definitions.set(definition.name, definition);
        definitionList.push(definition);
        definition = undefined;
      }
      if ((token.type === 'link' || token.type === 'image') && link) {
        links.push(link);
        linkStack.pop();
      }
    }
  }
  const broken = links.filter(
    (item) =>
      item.missing ||
      (!item.inline &&
        definitions.get(item.reference ?? key(item.label))?.missing),
  );
  const edits: Edit[] = [];
  for (const item of broken) {
    if (item.labelStart === undefined || item.labelEnd === undefined) continue;
    // Remove delimiters independently, so nested label content keeps its
    // original offsets and an inner repair cannot consume trailing prose.
    edits.push(
      { start: item.start, end: item.labelStart, text: '' },
      { start: item.labelEnd, end: item.end, text: '' },
    );
  }
  for (const definition of definitionList)
    if (definition.missing)
      edits.push({ start: definition.start, end: definition.end, text: '' });
  return edits;
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
    const missing = new Set<number>();
    for (const reference of findTopicReferences(source, sourceFileKey)) {
      const { span, index, encodedPath } = reference;
      const start = span.offsets[index];
      const filename = reference.filename ?? reference.aliasFilename;
      const canonical = filename === null ? undefined : resolve(filename);
      if (canonical === undefined) {
        missing.add(start);
        continue;
      }
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
    const wrappers = unlinkMissing(source, missing);
    if (wrappers.length === 0 && edits.length === 0) return source;
    // Mark removed ranges without sorting or comparing pairs. Overlapping
    // nested wrappers are a union of delimiters, preserving all label text.
    const removals = new Int32Array(source.length + 1);
    for (const wrapper of wrappers) {
      removals[wrapper.start] += 1;
      removals[wrapper.end] -= 1;
    }
    const removedCounts = new Uint32Array(source.length + 1);
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
      depth += removals[index];
      removedCounts[index + 1] = removedCounts[index] + (depth > 0 ? 1 : 0);
    }
    const replacements = new Map<number, Edit>();
    for (const edit of edits)
      if (removedCounts[edit.end] === removedCounts[edit.start])
        replacements.set(edit.start, edit);
    // Walk forward once and join disjoint original slices once. No destination
    // rescans, binary searches, edit sorting or repeated document rebuilding.
    const pieces: string[] = [];
    let copied = 0;
    let index = 0;
    while (index < source.length) {
      if (removedCounts[index + 1] > removedCounts[index]) {
        if (index > copied) pieces.push(source.slice(copied, index));
        do index += 1;
        while (
          index < source.length &&
          removedCounts[index + 1] > removedCounts[index]
        );
        copied = index;
        continue;
      }
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
