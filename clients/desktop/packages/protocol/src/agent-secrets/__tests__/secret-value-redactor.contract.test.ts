/**
 * Output redaction for agent secret requests is a contract with Agentic
 * Core: desktop redacts RunWithSecrets output with SecretValueRedactor, and
 * Core redacts the same tools' output in cloud sandboxes with its own copy
 * of the rules, so a value never reaches the model on either side. Both are
 * pinned to one case table (../fixtures/redaction-cases.json), copied
 * unchanged into Core; the digest below moves with every change to it.
 *
 * Every case must give its expected text and count for the whole text and
 * for every way of splitting it into chunks, and no case may leave a held
 * value of 4 or more characters in the output.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_SECRET_REDACTION_MIN_LENGTH,
  redactAgentSecretValues,
  SecretValueRedactor,
} from '../index';

const TABLE_SHA256 =
  'ac36e7b5ae7d2c06f7b7453e78ec1126b3d15e3826f123466c4e8e14c0ee7f13';

interface RedactionCase {
  name: string;
  secrets: Record<string, string>;
  input: string;
  expected: string;
  redactions: number;
}

const raw = readFileSync(
  join(__dirname, '../fixtures/redaction-cases.json'),
  'utf8',
);
const table = JSON.parse(raw) as { cases: RedactionCase[] };

function streamed(
  secrets: Record<string, string>,
  chunks: readonly string[],
): { text: string; redactions: number } {
  const redactor = new SecretValueRedactor(secrets);
  let text = '';
  for (const chunk of chunks) text += redactor.push(chunk);
  text += redactor.flush();
  return { text, redactions: redactor.redactions };
}

/** Every fixed chunk size, and every single cut point. */
function chunkings(input: string): string[][] {
  const result: string[][] = [];
  for (let size = 1; size <= input.length; size += 1) {
    const chunks: string[] = [];
    for (let at = 0; at < input.length; at += size) {
      chunks.push(input.slice(at, at + size));
    }
    result.push(chunks);
  }
  for (let cut = 0; cut <= input.length; cut += 1) {
    result.push([input.slice(0, cut), input.slice(cut)]);
  }
  return result;
}

describe('agent secret output redaction shared with Core', () => {
  it("is pinned to the same case table as Core's redactor", () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(TABLE_SHA256);
  });

  it.each(table.cases.map((c) => [c.name, c] as const))(
    '%s',
    (_name, testCase) => {
      const expected = {
        text: testCase.expected,
        redactions: testCase.redactions,
      };
      expect(redactAgentSecretValues(testCase.input, testCase.secrets)).toEqual(
        expected,
      );
      for (const chunks of chunkings(testCase.input)) {
        expect(streamed(testCase.secrets, chunks)).toEqual(expected);
      }
      for (const value of Object.values(testCase.secrets)) {
        if (value.length >= AGENT_SECRET_REDACTION_MIN_LENGTH) {
          expect(testCase.expected.includes(value)).toBe(false);
        }
      }
    },
  );

  it('keeps a long run of one value as one replacement within bounded memory', () => {
    const redactor = new SecretValueRedactor({ P: 'ababab' });
    let text = '';
    for (let index = 0; index < 50_000; index += 1) text += redactor.push('ab');
    text += redactor.flush();
    expect({ text, redactions: redactor.redactions }).toEqual({
      text: '[secret:P]',
      redactions: 1,
    });
  });
});
