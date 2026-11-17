// ---------------------------------------------------------------------------
// The publisher's MCP server as a stand-in for a ChatGPT app (CAN-6818,
// behind the `customize-discovery` Labs experiment).
//
// A plugin's apps are ChatGPT apps: only ChatGPT and Codex run them. On a
// harness that can't run the app, the stand-in is the same publisher's MCP
// server: the integration's preferred MCP endpoint, as CAN-6808's
// `integrationKey` grouping picks it. The host that groups the catalog passes
// that endpoint as a {@link PluginStandInCandidate}.
//
// This slice covers harnesses where the plugin's own installed copy already
// loads an MCP server on that endpoint's host: the row says so. A harness
// without one reads "ChatGPT app only."; installing a separate server there
// is a follow-up. Desktop main keeps a {@link PluginStandInLink} in its own
// file, so the plugin record and older app versions' reads never change.
//
// Pure: no Node, Electron, React or app imports.
// ---------------------------------------------------------------------------

import type {
  HarnessCompatibility,
  HarnessCompatibilityHarness,
} from './harness-compatibility';

/** Every harness a stand-in can serve, in the Works with filter's order. */
const HARNESSES: readonly HarnessCompatibilityHarness[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
];

/** Wire version of {@link PluginStandInLink}. */
export const PLUGIN_STAND_IN_LINK_VERSION = 1;

/** Longest stand-in name kept; the name reads "Uses the {name} MCP server". */
export const PLUGIN_STAND_IN_NAME_MAX_LENGTH = 80;

/** Longest endpoint kept. */
const ENDPOINT_MAX_LENGTH = 2048;

/** Longest catalog key kept. */
const KEY_MAX_LENGTH = 200;

/** What a harness that can't run the app shows when there is no stand-in. */
export const CHATGPT_APP_ONLY = 'ChatGPT app only.';

/**
 * The MCP server that stands in for a plugin's ChatGPT app: the
 * integration's preferred endpoint (CAN-6808), named for the row.
 */
export interface PluginStandInCandidate {
  /** An https MCP endpoint; never carries a secret. */
  readonly endpoint: string;
  /** The integration's name, e.g. `Canva`. */
  readonly name: string;
  /** The MCP catalog card for the same endpoint, when the catalog has one. */
  readonly curatedKey?: string;
}

/**
 * The candidate for a plugin, and the harnesses where its own installed copy
 * loaded an MCP server on the candidate's host when last worked out (Add, Try
 * again, a user-started update). Kept beside the plugin's record; rows work
 * the harnesses out again from the record and the installed copy.
 */
export interface PluginStandInLink {
  readonly version: number;
  readonly candidate: PluginStandInCandidate;
  readonly harnesses: readonly HarnessCompatibilityHarness[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A harness where the publisher's MCP server stands in, served only. */
export interface ItemHarnessStandIn {
  readonly name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/** An https URL with a host and no credentials, or `undefined`. */
export function standInEndpoint(value: unknown): string | undefined {
  const text = shortText(value, ENDPOINT_MAX_LENGTH);
  if (text === undefined) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.hostname === '') return undefined;
    if (url.username !== '' || url.password !== '') return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** The lower-case host of an http(s) URL, or `undefined`. */
export function standInEndpointHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Reads a candidate at a trust boundary; a sanitized copy or `undefined`. */
export function parsePluginStandInCandidate(
  value: unknown,
): PluginStandInCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const endpoint = standInEndpoint(value.endpoint);
  const name = shortText(value.name, PLUGIN_STAND_IN_NAME_MAX_LENGTH);
  if (endpoint === undefined || name === undefined) return undefined;
  const curatedKey = shortText(value.curatedKey, KEY_MAX_LENGTH);
  return {
    endpoint,
    name,
    ...(curatedKey !== undefined ? { curatedKey } : {}),
  };
}

/**
 * Reads a link at a trust boundary. Unknown versions are absent, an unknown
 * harness is dropped, and the result is a sanitized copy.
 */
export function parsePluginStandInLink(
  value: unknown,
): PluginStandInLink | undefined {
  if (
    !isRecord(value) ||
    value.version !== PLUGIN_STAND_IN_LINK_VERSION ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !Array.isArray(value.harnesses)
  )
    return undefined;
  const candidate = parsePluginStandInCandidate(value.candidate);
  if (candidate === undefined) return undefined;
  const listed: readonly unknown[] = value.harnesses;
  return {
    version: PLUGIN_STAND_IN_LINK_VERSION,
    candidate,
    harnesses: HARNESSES.filter((harness) => listed.includes(harness)),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** Reads one served stand-in; a sanitized copy or `undefined`. */
export function parseItemHarnessStandIn(
  value: unknown,
): ItemHarnessStandIn | undefined {
  if (!isRecord(value)) return undefined;
  const name = shortText(value.name, PLUGIN_STAND_IN_NAME_MAX_LENGTH);
  return name === undefined ? undefined : { name };
}

/**
 * The harnesses where a plugin's ChatGPT app doesn't run, from its
 * compatibility rating: the ones that only have the app to offer, and the
 * ones that load the rest but leave the app out. In order; empty without a
 * rating or without an app.
 */
export function chatGptAppMissingHarnesses(
  compatibility: HarnessCompatibility | undefined,
): HarnessCompatibilityHarness[] {
  return HARNESSES.filter((harness) => {
    const result = compatibility?.harnesses[harness];
    if (result === undefined) return false;
    if (result.level === 'unsupported') return result.reason === 'app_only';
    return result.level === 'partial' && result.missing.includes('apps');
  });
}

function harnessName(harness: HarnessCompatibilityHarness): string {
  switch (harness) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'copilot':
      return 'Copilot';
    case 'opencode':
      return 'OpenCode';
  }
}

/** "Uses the Canva MCP server in Claude Code." */
export function standInSentence(
  name: string,
  harness: HarnessCompatibilityHarness,
): string {
  return `Uses the ${name} MCP server in ${harnessName(harness)}.`;
}
