import {
  memoryCitationFiles,
  stripMemoryCitationTags,
} from '@canopy/agent-transcript/lib/memory-citation';
import { memoryFileIdentity } from '@canopy/memory-consolidation/topic-identity';
import { isRecord } from '../../lib/type-guards';
import type { PreparedLocalMemory } from './prepare';

export interface MemorySignalSource {
  fileKey: string;
  text: string;
}

export interface MemoryFileSignal {
  fileKey: string;
  citationCount: number;
  usageSignalCount: number;
}

// Fixed budgets bound work and retained output even for very long/tool-heavy turns.
const OUTPUT_LIMIT = 256_000;
const ITEM_LIMIT = 256;
const STOP_WORDS = new Set(
  'following different information reference instructions workspace project memory context remember should before after through without including configuration directory'.split(
    ' ',
  ),
);

function terms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}_-]{8,64}/gu) ?? []).filter(
      (term) => !STOP_WORDS.has(term),
    ),
  );
}

/** Each destination is scanned once, including balanced/escaped parentheses. */
function withoutLinkDestinations(text: string): string {
  const kept: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('](', cursor);
    if (open < 0) break;
    kept.push(text.slice(cursor, open + 1));
    let end = open + 2;
    let depth = 1;
    let angle = false;
    let quote = '';
    while (end < text.length && depth > 0) {
      const char = text[end];
      if (char === '\\') {
        end += 2;
        continue;
      }
      if (angle) {
        if (char === '>') angle = false;
      } else if (quote) {
        if (char === quote) quote = '';
      } else if (char === '<') {
        angle = true;
      } else if (
        (char === '"' || char === "'") &&
        (end === open + 2 || /\s/.test(text[end - 1] ?? ''))
      ) {
        quote = char;
      } else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      end += 1;
    }
    if (depth > 0) {
      // Incomplete markup is literal text. Do not retry every nested opener.
      cursor = open + 1;
      break;
    }
    cursor = end;
  }
  kept.push(text.slice(cursor));
  return kept.join('');
}

/** Destinations are retrieval pointers, not evidence in visible prose. */
function evidenceTerms(text: string): Set<string> {
  return terms(
    withoutLinkDestinations(text)
      .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*(?:\n[ \t]+[^\n]*)*/gm, '')
      .replace(/\S+/g, (token): string =>
        token.includes('://') || token.slice(0, 7).toLowerCase() === 'mailto:'
          ? ''
          : token,
      ),
  );
}

/** Scan JSON-like strings once so escaped quotes cannot trigger retries. */
function withoutArgumentNames(text: string): string {
  const kept: string[] = [];
  let cursor = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue;
    const open = index;
    index += 1;
    while (index < text.length && text[index] !== '"') {
      index += text[index] === '\\' ? 2 : 1;
    }
    if (index >= text.length) break;
    let colon = index + 1;
    while (colon < text.length && /\s/.test(text[colon] ?? '')) colon += 1;
    if (text[colon] !== ':') continue;
    kept.push(text.slice(cursor, open));
    cursor = colon + 1;
    index = colon;
  }
  kept.push(text.slice(cursor));
  return kept.join('');
}

/** Conservative positive evidence, never proof that uncited memory was unused. */
export function localMemorySignals(
  sources: readonly MemorySignalSource[],
  userText: string,
  assistantText: string,
  toolInputs: string,
): MemoryFileSignal[] {
  const citations = new Set(
    memoryCitationFiles(assistantText).map(memoryFileIdentity),
  );
  const citationOwners = new Map<string, number>();
  for (const source of sources) {
    const key = memoryFileIdentity(source.fileKey);
    citationOwners.set(key, (citationOwners.get(key) ?? 0) + 1);
  }
  const userTerms = terms(userText.slice(0, OUTPUT_LIMIT));
  // Some providers serialize tool inputs while others deliver JSON objects.
  // Object keys are schema vocabulary, not agent-selected argument values.
  // Scrub them during deferred matching, including escaped JSON strings; an
  // occasional false negative inside a shell snippet remains conservative.
  const toolValues = withoutArgumentNames(toolInputs);
  const boundedTagEnd = assistantText.lastIndexOf('>') + 1;
  const outputTerms = evidenceTerms(
    stripMemoryCitationTags(assistantText.slice(0, boundedTagEnd), {
      trimEnd: false,
    }) +
      assistantText.slice(boundedTagEnd) +
      '\n' +
      toolValues,
  );
  const sourceTerms = sources.map((source) => evidenceTerms(source.text));
  const owners = new Map<string, Set<number>>();
  sources.forEach((source, index) => {
    for (const term of sourceTerms[index] ?? []) {
      const files = owners.get(term) ?? new Set<number>();
      files.add(index);
      owners.set(term, files);
    }
  });
  return sources.map((source, index) => {
    let matches = 0;
    for (const term of sourceTerms[index] ?? []) {
      if (
        !userTerms.has(term) &&
        owners.get(term)?.size === 1 &&
        outputTerms.has(term)
      ) {
        matches += 1;
        if (matches === 2) break;
      }
    }
    return {
      fileKey: source.fileKey,
      citationCount:
        citations.has(memoryFileIdentity(source.fileKey)) &&
        citationOwners.get(memoryFileIdentity(source.fileKey)) === 1
          ? 1
          : 0,
      usageSignalCount: matches >= 2 ? 1 : 0,
    };
  });
}

/** Replays existing raw audit records after completion; never observes live events. */
class LocalMemoryTurnOutput {
  private items = new Map<string, { text: string; tool: boolean }>();
  private revisions = new Map<string, number>();
  private retained = 0;
  private finished = false;

  constructor(private readonly rootThreadId: string | undefined) {}

  private put(key: string, text: string, tool = false, append = false): void {
    if (
      this.finished ||
      (!this.items.has(key) && this.items.size >= ITEM_LIMIT)
    )
      return;
    const previous = this.items.get(key)?.text ?? '';
    const available =
      OUTPUT_LIMIT - this.retained + (append ? 0 : previous.length);
    const clipped = text.slice(0, Math.max(0, available));
    const next = append ? previous + clipped : clipped;
    this.retained += next.length - previous.length;
    this.items.set(key, { text: next, tool });
  }

  observe(value: unknown): void {
    if (this.finished || !isRecord(value) || value.parent_tool_use_id) return;
    const data =
      value.type === 'codex' && isRecord(value.event) ? value.event : value;
    if (data.type === 'assistant' && isRecord(data.message)) {
      const message = data.message;
      if (!Array.isArray(message.content)) return;
      const id =
        typeof message.id === 'string' ? message.id : String(this.items.size);
      message.content
        .slice(0, ITEM_LIMIT)
        .forEach((block: unknown, index: number) => {
          if (!isRecord(block)) return;
          if (block.type === 'text' && typeof block.text === 'string')
            this.put(`${id}:${index}`, block.text);
          if (block.type === 'tool_use')
            this.put(`${id}:${index}`, boundedInput(block.input), true);
        });
    } else if (data.type === 'item.completed' && isRecord(data.item)) {
      // Native child completions share the parent's raw audit. Without a
      // known matching root, threaded items cannot establish parent evidence.
      if (
        typeof data.thread_id === 'string' &&
        data.thread_id !== this.rootThreadId
      )
        return;
      const item = data.item;
      if (typeof item.id !== 'string') return;
      if (item.type === 'agent_message' && typeof item.text === 'string')
        this.put(item.id, item.text);
      if (item.type === 'command_execution' && typeof item.command === 'string')
        this.put(item.id, item.command, true);
      if (
        item.type === 'dynamic_tool_call' ||
        item.type === 'mcp_tool_call' ||
        item.type === 'function_call'
      ) {
        this.put(item.id, boundedInput(item.arguments), true);
      }
    } else if (
      data.type === 'canopy_assistant_patch' &&
      data.role !== 'system' &&
      typeof data.messageId === 'string' &&
      Array.isArray(data.patches)
    ) {
      if (
        typeof data.revision !== 'number' ||
        data.revision <= (this.revisions.get(data.messageId) ?? 0)
      )
        return;
      if (
        !this.revisions.has(data.messageId) &&
        this.revisions.size >= ITEM_LIMIT
      )
        return;
      this.revisions.set(data.messageId, data.revision);
      for (const patch of data.patches.slice(0, ITEM_LIMIT)) {
        if (!isRecord(patch) || typeof patch.index !== 'number') continue;
        const key = `${data.messageId}:${patch.index}`;
        if (
          typeof patch.appendText === 'string' &&
          this.items.get(key)?.tool === false
        )
          this.put(key, patch.appendText, false, true);
        else if (isRecord(patch.block)) {
          const block = patch.block;
          if (block.type === 'text' && typeof block.text === 'string')
            this.put(key, block.text);
          if (block.type === 'tool_use' && typeof block.input === 'string')
            this.put(key, block.input, true);
        }
      }
    }
  }

  finish(): { assistantText: string; toolInputs: string } | null {
    if (this.finished) return null;
    this.finished = true;
    const items = [...this.items.values()];
    this.items.clear();
    this.revisions.clear();
    return {
      assistantText: items
        .filter((item) => !item.tool)
        .map((item) => item.text)
        .join('\n'),
      toolInputs: items
        .filter((item) => item.tool)
        .map((item) => item.text)
        .join('\n'),
    };
  }
}

/** Bound replay as well as retained evidence. Oversize records stay unclear. */
export async function completedLocalMemoryTurnOutput(
  lines: readonly string[],
  rootThreadId?: string,
): Promise<{ assistantText: string; toolInputs: string }> {
  const output = new LocalMemoryTurnOutput(rootThreadId);
  let remaining = 8 * 1024 * 1024;
  for (let index = 0; index < Math.min(lines.length, 4096); index += 1) {
    const line = lines[index] ?? '';
    if (line.length > remaining) break;
    remaining -= line.length;
    if (line.length <= OUTPUT_LIMIT) {
      try {
        output.observe(JSON.parse(line));
      } catch {
        // Corrupt or truncated records cannot establish positive evidence.
      }
    }
    // Long transcripts yield between batches, outside event delivery.
    if (index % 64 === 63)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return output.finish() ?? { assistantText: '', toolInputs: '' };
}

interface LocalMemoryTurnMeasurement {
  prepared: PreparedLocalMemory;
  userText: string;
  finished: boolean;
  turnId: string | undefined;
}

// Deferred-tool reloads create a new dispatch closure for the same turn. Keep
// its recall metadata until the real terminal. Output already lives in the
// audit transcript. One entry per chat; abandoned entries have a hard cap.
const measurements = new Map<string, LocalMemoryTurnMeasurement>();

export function localMemoryTurnMeasurement(
  sessionKey: string,
  turnId: string | undefined,
  source: { prepared: PreparedLocalMemory; userText: string } | undefined,
  continuation: boolean,
): LocalMemoryTurnMeasurement | undefined {
  const previous = measurements.get(sessionKey);
  if (continuation)
    return turnId !== undefined && previous?.turnId === turnId
      ? previous
      : undefined;
  measurements.delete(sessionKey);
  if (!source) return undefined;
  const measurement = {
    ...source,
    finished: false,
    turnId,
  };
  if (turnId !== undefined) {
    if (measurements.size >= 64) {
      const oldest = measurements.keys().next().value;
      if (oldest !== undefined) measurements.delete(oldest);
    }
    measurements.set(sessionKey, measurement);
  }
  return measurement;
}

/** Claim a turn once, including when old continuation closures deliver again. */
export function finishLocalMemoryTurnMeasurement(
  sessionKey: string,
  measurement: LocalMemoryTurnMeasurement,
): boolean {
  if (measurement.finished) return false;
  measurement.finished = true;
  forgetLocalMemoryTurnMeasurement(sessionKey, measurement);
  return true;
}

export function forgetLocalMemoryTurnMeasurement(
  sessionKey: string,
  measurement: LocalMemoryTurnMeasurement,
): void {
  if (measurements.get(sessionKey) === measurement)
    measurements.delete(sessionKey);
}

// During post-turn replay, traverse only a bounded set of tool-input leaves;
// neither keys nor result/output text are evidence.
function boundedInput(value: unknown): string {
  const pieces: string[] = [];
  let remaining = 8_000;
  let visited = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (remaining === 0 || visited++ >= 64) return;
    if (typeof entry === 'string') {
      const text = entry.slice(0, remaining);
      pieces.push(text);
      remaining -= text.length;
    } else if (depth < 3 && Array.isArray(entry)) {
      for (const child of entry.slice(0, 16)) {
        if (remaining === 0 || visited >= 64) break;
        visit(child, depth + 1);
      }
    } else if (depth < 3 && isRecord(entry)) {
      let count = 0;
      for (const key in entry) {
        if (count++ >= 16 || remaining === 0 || visited >= 64) break;
        if (Object.prototype.hasOwnProperty.call(entry, key))
          visit(entry[key], depth + 1);
      }
    }
  };
  visit(value, 0);
  return pieces.join('\n');
}
