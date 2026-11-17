/**
 * The thinking level wire clamp is a contract with Agentic Core (CAN-6855).
 * The clients clamp a level they send, and Core clamps a level a turn
 * inherits, so a turn runs the same level whichever side clamped it. Both
 * sides are pinned to one case table, kept as two identical copies: this
 * one and Core's (libs/workflow-contracts/fixtures/thinking-effort-clamp-cases.json).
 * The digest below is the same in both repositories' tests, so a change to
 * either copy fails here until both copies and both digests move together.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clampThinkingLevelToDeclared,
  isCoreThinkingLevel,
  type CoreThinkingLevel,
} from '../index';

const TABLE_SHA256 =
  '2e83371de7ce8e86adc29d7e404d8fdcab717e0a8524d06afe729361cfa5b0bd';

interface ClampCase {
  level: CoreThinkingLevel;
  declared: string[];
  expected: CoreThinkingLevel | null;
}

const raw = readFileSync(
  join(__dirname, '../fixtures/thinking-effort-clamp-cases.json'),
  'utf8',
);
const table = JSON.parse(raw) as { cases: ClampCase[] };

/** The clients send no level for a model that declares none. */
function clampForWire(
  level: CoreThinkingLevel,
  declaredLevels: readonly string[],
): CoreThinkingLevel | null {
  const declared = declaredLevels.filter(isCoreThinkingLevel);
  if (declared.length === 0) return null;
  const clamped = clampThinkingLevelToDeclared(level, declared);
  return isCoreThinkingLevel(clamped) ? clamped : null;
}

describe('the thinking level wire clamp shared with Core (CAN-6855)', () => {
  it("is pinned to the same case table as Core's clamp", () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(TABLE_SHA256);
  });

  it.each(table.cases.map((c) => [c.level, c.declared, c.expected] as const))(
    '%s on %j runs %s',
    (level, declared, expected) => {
      expect(clampForWire(level, declared)).toBe(expected);
    },
  );

  it("never runs Off above the model's least level", () => {
    expect(clampThinkingLevelToDeclared('off', ['low', 'high'])).toBe('low');
    expect(clampThinkingLevelToDeclared('off', ['high', 'max'])).toBe('high');
  });

  it('clamps the same whatever order the model lists its levels in', () => {
    for (const declared of [
      ['high', 'max'],
      ['max', 'high'],
    ] as const) {
      expect(clampThinkingLevelToDeclared('low', declared)).toBe('high');
      expect(clampThinkingLevelToDeclared('off', declared)).toBe('high');
    }
  });
});
