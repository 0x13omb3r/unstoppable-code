/**
 * Local-memory citation tag stripping for display.
 *
 * `stripMemoryCitationTags` removes ANY bounded `<memory_citation ...>` tag —
 * self-closed or not, with or without a `files` attribute — so a sloppily
 * emitted tag (e.g. a missing trailing slash) never leaks into user-visible
 * text. The pattern bounds the tag body with `[^>]*`, so a single tag can
 * never cross a `>`: an unclosed `<memory_citation ...` prefix never swallows
 * unrelated text up to a later element (e.g. `<br/>`).
 */

/**
 * Any bounded `<memory_citation ...>` opening tag or `</memory_citation>`
 * closing tag, up to the first `>`. The optional `/` covers the paired form a
 * model may emit instead of self-closing.
 */
const MEMORY_CITATION_TAG_SOURCE = String.raw`</?memory_citation\b[^>]*>`;

/** Read citation identities from assembled agent text before display stripping. */
export function memoryCitationFiles(text: string): string[] {
  const files = new Set<string>();
  // A suffix with no closing delimiter contains no complete tag. Excluding
  // it prevents retrying the rest of a malformed stream at every prefix.
  const bounded = text.slice(0, text.lastIndexOf('>') + 1);
  for (const tag of bounded.matchAll(/<memory_citation\b[^>]*>/gi)) {
    const attribute = /\bfiles\s*=\s*["']([^"']*)["']/i.exec(tag[0]);
    for (const value of (attribute?.[1] ?? '').split(/[,，]/)) {
      const file = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
      if (/^(?:MEMORY\.md|topics\/[^/]+\.md|inbox\/[^/]+\.md)$/i.test(file)) {
        files.add(file);
      }
    }
  }
  return [...files];
}

export interface StripMemoryCitationTagsOptions {
  /**
   * Trim trailing whitespace once a tag was removed (default `true`). Pass
   * `false` when the text is still being assembled from streamed deltas: the
   * stripped result feeds the next append, so trimming would glue the next
   * delta onto the previous line.
   */
  trimEnd?: boolean;
}

/**
 * Remove model-emitted local-memory citation control tags from display text.
 *
 * Providers that deliver self-contained items (Claude, Codex) strip once,
 * after the item is assembled, so a tag split across independently-rendered
 * events is only recognized once a later assembled item carries the full tag.
 * Cursor streams `canopy_assistant_patch` deltas instead; its reducer strips
 * each patched block, with `trimEnd: false`, whenever the patch could complete
 * a tag (a new block, or an append that carries a `>`), so a split tag
 * disappears as soon as the delta that closes it is applied. See
 * `stripCursorAssistantMemoryCitations` in `transcript-parser.ts` for the
 * exact rule.
 *
 * Any bounded `<memory_citation ...>` tag, including non-self-closed tags
 * and tags without a `files` attribute, is removed so no variant leaks into
 * visible output. The case-insensitive prefix check mirrors the `/i` pattern
 * flag and skips the scan entirely for tag-free text.
 */
export function stripMemoryCitationTags(
  text: string,
  options: StripMemoryCitationTagsOptions = {},
): string {
  if (!/<\/?memory_citation/i.test(text)) {
    return text;
  }
  const stripped = text.replace(
    new RegExp(MEMORY_CITATION_TAG_SOURCE, 'gi'),
    '',
  );
  if (stripped === text) return text;
  return options.trimEnd === false ? stripped : stripped.trimEnd();
}
