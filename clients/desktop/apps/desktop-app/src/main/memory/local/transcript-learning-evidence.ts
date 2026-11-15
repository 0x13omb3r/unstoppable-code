import { CHAT_LEARNING_MAX_EVIDENCE_ENTRIES } from './transcript-learning-protocol';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { isHumanAuthoredUserMessage } from '@canopy/agent-transcript/transcript-storage';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import type { ChatEvidence } from '@canopy/memory-consolidation/transcript-extraction';
const MAX_EVIDENCE_CHARS = 24_000;
const MAX_ROWS = 20_000;
/** No blocks from unregistered, hidden, synthetic or delegated turns reach evidence. */
export async function collectChatEvidence(
  messages: AsyncIterable<PersistedChatMessage>,
  allowed: ReadonlySet<string>,
  mayRead: () => boolean,
): Promise<ChatEvidence[]> {
  const evidence: ChatEvidence[] = [];
  let current: string | null = null;
  let remaining = MAX_EVIDENCE_CHARS - 2;
  let rows = 0;
  for await (const message of messages) {
    rows += 1;
    if (!mayRead() || rows > MAX_ROWS) throw new Error('Chat learning stopped');
    if (rows % 100 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    if (
      message.role === 'user' &&
      !message.parentToolUseId &&
      !message.parentBlockId
    ) {
      if (message.hidden || !isHumanAuthoredUserMessage(message))
        current = null;
      else if (!current && !allowed.has(message.id)) continue;
      else if (isUserTurnBoundary(message))
        current = allowed.has(message.id) ? message.id : null;
      else if (
        message.blocks.some(
          (block) =>
            block.type === 'text' &&
            block.steering?.rootUserMessageId !== undefined &&
            block.steering.rootUserMessageId !== current,
        )
      )
        current = null;
    }
    if (
      !current ||
      remaining <= 0 ||
      evidence.length >= CHAT_LEARNING_MAX_EVIDENCE_ENTRIES ||
      message.hidden ||
      message.parentToolUseId ||
      message.parentBlockId ||
      (message.role !== 'user' && message.role !== 'assistant')
    )
      continue;
    if (message.blocks.some((block) => block.type === 'automation_info'))
      return [];
    let raw = '';
    for (const block of message.blocks) {
      if (block.type !== 'text') continue;
      if (
        block.textRef !== undefined ||
        raw.length + block.text.length + 1 > 6000
      ) {
        // Omit oversized or artifact-preview messages: a partial PEM can
        // expose secret material when its closing marker was clipped away.
        raw = '';
        break;
      }
      raw += block.text + '\n';
    }
    const normalized = raw
      .split('')
      .filter(
        (character) =>
          character >= ' ' ||
          character === '\n' ||
          character === '\r' ||
          character === '\t',
      )
      .join('')
      .trim();
    const text = redactMemoryContent(normalized).slice(
      0,
      Math.min(3000, remaining),
    );
    if (text.trim()) {
      const entry: ChatEvidence = {
        turnId: current,
        role: message.role,
        text,
        at: new Date(message.timestamp).toISOString(),
      };
      const size = JSON.stringify(entry).length + 1;
      if (size > remaining) {
        remaining = 0;
        continue;
      }
      remaining -= size;
      evidence.push(entry);
    }
  }
  return evidence;
}
