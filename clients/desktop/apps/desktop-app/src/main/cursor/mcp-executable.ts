import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * Resolves an MCP server command the way the Cursor child would find it: bare
 * names against the child's PATH, relative paths against the definition's own
 * directory when it declares one (a plugin's root), otherwise the worktree.
 * ACP requires an absolute executable path. macOS-only today, like the turn
 * itself (see the platform gate below): Windows would need `PATHEXT`
 * expansion and its own path separators before that gate lifts.
 */
export async function resolveMcpExecutable(
  command: string,
  pathValue: string | undefined,
  cwd: string,
  fallbackCwd: string,
): Promise<string | null> {
  if (command.includes('\0') || command.length === 0) return null;
  // A relative declared directory must never widen the search to the
  // Electron process's own cwd; fall back to the worktree instead.
  const candidates = command.includes('/')
    ? [resolve(isAbsolute(cwd) ? cwd : fallbackCwd, command)]
    : (pathValue ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}

/** The MCP transports a Cursor ACP `initialize` advertised. */
export interface CursorMcpCapabilities {
  readonly http?: boolean;
  readonly sse?: boolean;
}

/**
 * What the pinned CLI advertises (docs/cursor-chat.md, MCP over ACP), until
 * a session reports what the installed CLI actually advertised.
 */
const PINNED_CLI_MCP_CAPABILITIES: CursorMcpCapabilities = {
  http: true,
  sse: true,
};

let lastAdvertised: CursorMcpCapabilities | undefined;

/** Records the capabilities a Cursor session's ACP initialization reported. */
export function recordCursorMcpCapabilities(
  capabilities: CursorMcpCapabilities | undefined,
): void {
  lastAdvertised = {
    http: capabilities?.http === true,
    sse: capabilities?.sse === true,
  };
}

/**
 * The capabilities the last Cursor session advertised, or the pinned CLI's
 * when no session has started yet. One Add stages servers against these
 * (CAN-6815), so a CLI without HTTP support records the refusal a session
 * would hit.
 */
export function cursorMcpCapabilities(): CursorMcpCapabilities {
  return lastAdvertised ?? PINNED_CLI_MCP_CAPABILITIES;
}
