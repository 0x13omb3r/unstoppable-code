import {
  MaskedKeyAllocator,
  normalizedSecretRanges,
  redactStructuredValue,
  redactNormalizedPreservingFormat,
  normalizeSingleLine,
  withJsonEscapedVariants,
} from '@canopy/protocol/value-redaction';

interface ObservationMatchState {
  readonly matched: readonly ReadonlySet<number>[];
  readonly trailingSpace: boolean;
}

/** Immediate observations cannot retract a prefix when a later completion arrives. */
export class CopilotObservationTextRedactor {
  private readonly patterns: readonly {
    text: string;
    normalized: boolean;
    failure: readonly number[];
  }[];
  private previous: readonly ObservationMatchState[] = [];
  private readonly current = new Map<boolean, Set<number>[]>();

  constructor(private readonly secrets: readonly string[]) {
    this.patterns = Array.from(
      new Set(withJsonEscapedVariants(secrets.filter((s) => s.length >= 6))),
      (value) => {
        const normalized = normalizeSingleLine(value);
        const text = normalized || value;
        const failure = Array<number>(text.length).fill(0);
        for (let i = 1, matched = 0; i < text.length; i++) {
          while (matched && text[i] !== text[matched])
            matched = failure[matched - 1];
          if (text[i] === text[matched]) matched++;
          failure[i] = matched;
        }
        return { text, normalized: normalized.includes(' '), failure };
      },
    );
  }

  beginEvent(): void {
    if (!this.current.size) return;
    this.previous = Array.from(this.current, ([trailingSpace, matched]) => ({
      matched,
      trailingSpace,
    }));
    this.current.clear();
  }

  redact(text: string): string {
    if (!text || !this.patterns.length) return text;
    const spans = [...normalizedSecretRanges(text, this.secrets)];
    const projected = this.patterns.some((pattern) => pattern.normalized)
      ? Array.from(text.matchAll(/\s+|\S/g), (match) => ({
          value: /^\s/.test(match[0]) ? ' ' : match[0],
          start: match.index,
          end: match.index + match[0].length,
        }))
      : [];
    // Fields can be mirrors OR successive fragments. Keep both interpretations,
    // but discard the old frontier at the next event instead of retaining history.
    const sources: readonly ObservationMatchState[] = [
      { matched: this.patterns.map(() => new Set([0])), trailingSpace: false },
      ...this.previous,
      ...Array.from(this.current, ([trailingSpace, matched]) => ({
        matched,
        trailingSpace,
      })),
    ];
    const next = this.patterns.map(() => new Set<number>());
    for (const source of sources) {
      const parts =
        source.trailingSpace && projected[0]?.value === ' '
          ? projected.slice(1)
          : projected;
      const normalized = parts.map((part) => part.value).join('');
      this.patterns.forEach((pattern, index) => {
        const input = pattern.normalized ? normalized : text;
        const span = (start: number, end: number): void => {
          if (start >= end) return;
          spans.push({
            start: pattern.normalized ? parts[start].start : start,
            end: pattern.normalized ? parts[end - 1].end : end,
          });
        };
        for (const pending of source.matched[index]) {
          let matched = pending;
          let continued = 0;
          if (matched) {
            while (
              continued < input.length &&
              matched + continued < pattern.text.length &&
              input[continued] === pattern.text[matched + continued]
            )
              continued++;
            span(0, continued);
          }
          for (let i = 0; i < input.length; i++) {
            while (matched && input[i] !== pattern.text[matched])
              matched = pattern.failure[matched - 1];
            if (input[i] === pattern.text[matched]) matched++;
            if (matched === pattern.text.length) {
              span(Math.max(0, i + 1 - matched), i + 1);
              matched = pattern.failure[matched - 1];
            }
          }
          // No fragment floor: even one pending character can begin a protected value.
          span(Math.max(0, input.length - matched), input.length);
          next[index].add(matched);
        }
      });
    }
    const trailingSpace = /\s$/.test(text);
    const frontier = this.current.get(trailingSpace);
    if (frontier)
      next.forEach((matches, index) => {
        for (const matched of matches) frontier[index].add(matched);
      });
    else this.current.set(trailingSpace, next);
    spans.sort((a, b) => a.start - b.start);
    let output = '';
    let offset = 0;
    for (const span of spans) {
      if (span.end <= offset) continue;
      output += text.slice(offset, Math.max(offset, span.start));
      if (span.start >= offset) output += '***';
      offset = span.end;
    }
    return output + text.slice(offset);
  }
}

/** Mask decoded tool values before JSON escaping can hide reflowed secrets. */
export function redactCopilotToolValue(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (!secrets.length) return value;
  const reflowed = (node: unknown): unknown => {
    if (typeof node === 'string')
      return redactNormalizedPreservingFormat(node, secrets);
    if (Array.isArray(node)) return node.map(reflowed);
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node).map(
        ([key, entry]: [string, unknown]) => ({
          key,
          masked: redactNormalizedPreservingFormat(key, secrets),
          entry,
        }),
      );
      const keys = new MaskedKeyAllocator();
      for (const { key, masked } of entries)
        if (key === masked) keys.reserveIn(0, key);
      return Object.fromEntries(
        entries.map(({ key, masked, entry }) => [
          key === masked ? key : keys.allocateIn(0, masked, masked),
          reflowed(entry),
        ]),
      );
    }
    return node;
  };
  return reflowed(redactStructuredValue(value, secrets));
}

/** Preserve block ownership while masking values split across message boundaries. */
export function redactCopilotTextParts(
  parts: readonly string[],
  secrets: readonly string[],
): string[] {
  const spans = normalizedSecretRanges(parts.join(''), secrets);
  if (!spans.length) return [...parts];
  let start = 0;
  let nextSpan = 0;
  return parts.map((part) => {
    const end = start + part.length;
    let offset = start;
    let result = '';
    while (nextSpan < spans.length && spans[nextSpan].start < end) {
      const span = spans[nextSpan];
      if (span.start >= start)
        result += part.slice(offset - start, span.start - start) + '***';
      offset = Math.min(span.end, end);
      if (span.end <= end) nextSpan++;
      else break;
    }
    result += part.slice(offset - start);
    start = end;
    return result;
  });
}
