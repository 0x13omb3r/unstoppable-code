/** Wire semantics and derivation rules are versioned independently of content. */
export const HARNESS_COMPATIBILITY_VERSION = 1;
export const HARNESS_COMPATIBILITY_RULES_VERSION = 1;

export type HarnessCompatibilityHarness =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'opencode';

export type HarnessCompatibilityPart =
  | 'skills'
  | 'commands'
  | 'agents'
  | 'apps'
  | 'hooks'
  | 'mods'
  | 'mcpServers'
  | 'lspServers';

export type HarnessCompatibilityUnsupportedReason =
  | 'no_content'
  | 'nothing_loadable'
  | 'app_only'
  | 'no_conversion'
  | 'provider_account_only';

export type HarnessCompatibilityResult =
  | { level: 'native' }
  | { level: 'full' }
  | { level: 'partial'; missing: HarnessCompatibilityPart[] }
  | {
      level: 'unsupported';
      reason: HarnessCompatibilityUnsupportedReason;
    };

export interface HarnessCompatibility {
  version: number;
  rulesVersion: number;
  harnesses: Partial<
    Record<HarnessCompatibilityHarness, HarnessCompatibilityResult>
  >;
}

const HARNESSES: readonly HarnessCompatibilityHarness[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
];
const PARTS: readonly HarnessCompatibilityPart[] = [
  'skills',
  'commands',
  'agents',
  'apps',
  'hooks',
  'mods',
  'mcpServers',
  'lspServers',
];
const REASONS: readonly HarnessCompatibilityUnsupportedReason[] = [
  'no_content',
  'nothing_loadable',
  'app_only',
  'no_conversion',
  'provider_account_only',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResult(value: unknown): HarnessCompatibilityResult | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.level) {
    case 'native':
    case 'full':
      return { level: value.level };
    case 'partial': {
      const missing = value.missing;
      if (
        !Array.isArray(missing) ||
        missing.length === 0 ||
        !missing.every((part) => PARTS.some((known) => known === part))
      )
        return undefined;
      return {
        level: 'partial',
        missing: PARTS.filter((part) => missing.includes(part)),
      };
    }
    case 'unsupported': {
      const reason = REASONS.find((known) => known === value.reason);
      return reason === undefined
        ? undefined
        : { level: 'unsupported', reason };
    }
    default:
      return undefined;
  }
}

/**
 * Read JSON metadata without rejecting the containing catalog item. Unknown
 * versions are absent; a bad harness result never poisons its valid siblings.
 * This returns a sanitized copy: a boolean guard cannot remove invalid data.
 */
export function parseHarnessCompatibility(
  value: unknown,
): HarnessCompatibility | undefined {
  if (
    !isRecord(value) ||
    value.version !== HARNESS_COMPATIBILITY_VERSION ||
    value.rulesVersion !== HARNESS_COMPATIBILITY_RULES_VERSION ||
    !isRecord(value.harnesses)
  )
    return undefined;
  const harnesses: HarnessCompatibility['harnesses'] = {};
  for (const harness of HARNESSES) {
    const result = parseResult(value.harnesses[harness]);
    if (result !== undefined) harnesses[harness] = result;
  }
  if (Object.keys(harnesses).length === 0) return undefined;
  return {
    version: HARNESS_COMPATIBILITY_VERSION,
    rulesVersion: HARNESS_COMPATIBILITY_RULES_VERSION,
    harnesses,
  };
}
