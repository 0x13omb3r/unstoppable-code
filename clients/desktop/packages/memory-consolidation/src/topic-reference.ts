import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import { decodeString } from 'micromark-util-decode-string';
import {
  memoryFileIdentity,
  normalizeTopicName,
  topicFileKeyIdentity,
} from './topic-identity';

// The one parser of topic references in a memory index, shared by the
// consolidation resolver (which rewrites each reference to the topic's real
// filename) and injection usage (which records each referenced topic as
// used). Both must recognise exactly the same forms, so neither keeps its
// own pattern: plain `topics/<name>.md`, a `./` prefix, percent-encoded
// characters and separators, Markdown escapes and entities, a `?query` or
// `#fragment`, and trailing sentence punctuation outside link destinations.

// A name with a path separator, `.` or `..` fails the pattern, so it also
// rejects every name that is not its own final path segment.
function normalizeExistingTopicFilename(filename: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) {
    return null;
  }
  // Canonicalize the extension to lowercase: the topic store discovers files
  // with a case-sensitive `.md` filter, so `preferences.MD` would be written
  // but permanently unreachable on case-sensitive filesystems.
  return filename.toLowerCase().endsWith('.md')
    ? `${filename.slice(0, -3)}.md`
    : `${filename}.md`;
}

/**
 * A topic filename written by consolidation output or named by an index
 * reference, with a lowercase `.md`; null when it is not a valid topic name.
 */
export function normalizeOutputTopicFilename(topic: string): string | null {
  const trimmed = topic.trim().replace(/^topics\//, '');
  const filename = normalizeExistingTopicFilename(trimmed);
  if (filename === null || !trimmed.toLowerCase().endsWith('.md')) return null;
  const stem = filename.slice(0, -3);
  return normalizeTopicName(stem) === stem ? filename : null;
}

/** Literal text of a Markdown document, with source offsets per character. */
export interface MarkdownReferenceSpan {
  text: string;
  offsets: number[];
  end: number;
  destination: boolean;
  /** Code and raw HTML preserve literal path characters without Markdown escapes. */
  literal: boolean;
}

export function markdownReferenceSpans(
  source: string,
): MarkdownReferenceSpan[] {
  const events = postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(source, 'utf8', true)),
  );
  // Definition/reference identifiers are Markdown mechanics, not file paths.
  // Rewriting them can disconnect a valid reference link from its definition.
  let identifierRanges: Int32Array | undefined;
  const markIdentifier = (start: number, end: number): void => {
    identifierRanges ??= new Int32Array(source.length + 1);
    identifierRanges[start] += 1;
    identifierRanges[end] -= 1;
  };
  const links: Array<{
    label?: { start: number; end: number };
    inline: boolean;
  }> = [];
  for (const [event, token] of events) {
    if (event === 'enter') {
      if (token.type === 'link' || token.type === 'image')
        links.push({ inline: false });
      const link = links[links.length - 1];
      if (token.type === 'resource' && link) link.inline = true;
      if (token.type === 'labelText' && link && link.label === undefined)
        link.label = { start: token.start.offset, end: token.end.offset };
      if (
        token.type === 'referenceString' ||
        token.type === 'definitionLabelString'
      )
        markIdentifier(token.start.offset, token.end.offset);
    } else if (token.type === 'link' || token.type === 'image') {
      const link = links.pop();
      if (link && !link.inline && link.label)
        markIdentifier(link.label.start, link.label.end);
    }
  }
  let identifierCounts: Uint32Array | undefined;
  if (identifierRanges !== undefined) {
    identifierCounts = new Uint32Array(source.length + 1);
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
      depth += identifierRanges[index];
      identifierCounts[index + 1] =
        identifierCounts[index] + (depth > 0 ? 1 : 0);
    }
  }
  const spans: MarkdownReferenceSpan[] = [];
  let destination = false;
  for (const [event, token] of events) {
    if (
      token.type === 'resourceDestinationString' ||
      token.type === 'definitionDestinationString'
    ) {
      destination = event === 'enter';
      continue;
    }
    if (event !== 'enter') continue;
    const escaped =
      token.type === 'characterEscape' || token.type === 'characterReference';
    const literal = [
      'codeTextData',
      'codeFlowValue',
      'htmlFlowData',
      'htmlTextData',
    ].includes(token.type);
    if (
      !escaped &&
      ![
        'data',
        'codeTextData',
        'codeFlowValue',
        'htmlFlowData',
        'htmlTextData',
      ].includes(token.type)
    )
      continue;
    const start = token.start.offset;
    const end = token.end.offset;
    if (
      identifierCounts !== undefined &&
      identifierCounts[end] - identifierCounts[start] === end - start
    )
      continue;
    const raw = source.slice(start, end);
    const text = escaped ? decodeString(raw) : raw;
    const previous = spans[spans.length - 1];
    const span =
      previous?.end === start &&
      previous.destination === destination &&
      previous.literal === literal
        ? previous
        : { text: '', offsets: [start], end: start, destination, literal };
    if (span !== previous) spans.push(span);
    span.text += text;
    // Decoded escapes span several source characters; keep replacements on original token boundaries.
    for (let index = 1; index <= text.length; index += 1)
      span.offsets.push(
        escaped ? (index === text.length ? end : start) : start + index,
      );
    span.end = end;
  }
  return spans;
}

/** Canonical paths stay readable as ordinary Markdown, including emphasis markers. */
export function escapeMemoryReferenceText(path: string): string {
  return path.replace(/_/g, '\\_');
}

const TOPIC_REFERENCE_CANDIDATE =
  /(?<![A-Za-z0-9._/%-])(?:(?:\.{1,2}(?:\/|%2f))+)?topics(?:\/|%2f)[^\s`<>()\[\]{}"']+/gi;

/** One topic reference found in a Markdown index. */
export interface TopicReference {
  span: MarkdownReferenceSpan;
  /** Where the reference starts in `span.text`. */
  index: number;
  /** The reference as written, without its query, fragment, or punctuation. */
  encodedPath: string;
  /**
   * The topic filename it names, normalized; null when the reference does
   * not name a valid topic directly under `topics/` (for example
   * `../topics/x.md`, a nested path, or an invalid name).
   */
  filename: string | null;
  /** Safe final basename for alias lookup; may contain decoded spaces. */
  aliasFilename: string | null;
}

/** Every topic reference candidate in `source`, resolvable or not. */
export function findTopicReferences(
  source: string,
  sourceFileKey = 'MEMORY.md',
): TopicReference[] {
  const references: TopicReference[] = [];
  for (const span of markdownReferenceSpans(source)) {
    // Markdown supplies the whole destination, including literal spaces in
    // angle brackets. Whitespace delimits only references found in bare text.
    const candidates =
      span.destination &&
      /^(?:(?:\.{1,2}(?:\/|%2f))+)?topics(?:\/|%2f)/i.test(span.text)
        ? [{ text: span.text, index: 0, relative: false }]
        : span.destination
          ? []
          : Array.from(span.text.matchAll(TOPIC_REFERENCE_CANDIDATE)).map(
              (match) => ({
                text: match[0],
                index: match.index,
                relative: false,
              }),
            );
    // Topic documents also use sibling Markdown destinations. Bare prose is
    // still parsed as scope-relative file keys, matching injection usage.
    if (
      sourceFileKey.startsWith('topics/') &&
      span.destination &&
      candidates.length === 0 &&
      /^(?:\.{1,2}\/)*[A-Za-z0-9._% -]+\.md(?:[?#].*)?$/i.test(span.text)
    ) {
      candidates.push({ text: span.text, index: 0, relative: true });
    }
    for (const match of candidates) {
      const reference = match.text;
      // An unanchored punctuation-run regex followed by `$` retries at every
      // character on a long run ending in a letter. Scan the suffix once.
      let targetEnd = reference.length;
      if (!span.destination) {
        while (
          targetEnd > 0 &&
          '.,;:!?'.includes(reference.charAt(targetEnd - 1))
        )
          targetEnd -= 1;
      }
      const target = reference.slice(0, targetEnd);
      const suffixIndex = target.search(/[?#]/);
      const encodedPath =
        suffixIndex === -1 ? target : target.slice(0, suffixIndex);
      let path: string;
      try {
        path = decodeURIComponent(encodedPath).replace(/^\.\//, '');
        if (match.relative && /^\.\.\/MEMORY\.md$/i.test(path)) continue;
        if (match.relative) path = `topics/${path}`;
        else if (
          sourceFileKey.startsWith('topics/') &&
          path.startsWith('../topics/')
        )
          path = path.slice(3);
      } catch {
        path = '';
      }
      const basename = path.toLowerCase().startsWith('topics/')
        ? path.slice('topics/'.length)
        : '';
      const aliasFilename =
        /^[A-Za-z0-9][A-Za-z0-9 ._-]*\.md$/i.test(basename) &&
        !/\.md$/i.test(basename.slice(0, -3))
          ? basename.replace(/\.md$/i, '.md')
          : null;
      const normalized = normalizeOutputTopicFilename(
        path.toLowerCase().startsWith('topics/')
          ? path.slice('topics/'.length)
          : '',
      );
      references.push({
        span,
        index: match.index,
        encodedPath,
        aliasFilename,
        filename:
          normalized !== null &&
          memoryFileIdentity(path) === topicFileKeyIdentity(normalized)
            ? normalized
            : null,
      });
    }
  }
  return references;
}

/**
 * Topic files an index excerpt points at, as topic file key identities: a
 * link's spelling need not match the file on disk (on macOS and Windows
 * `topics/build.md` opens `Build.md`), and usage is keyed by identity so the
 * use lands on the real topic.
 */
export function referencedTopicFileKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const reference of findTopicReferences(source)) {
    if (reference.filename !== null) {
      keys.add(topicFileKeyIdentity(reference.filename));
    }
  }
  return Array.from(keys);
}
