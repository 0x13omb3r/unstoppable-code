import { materializeSelectedPluginRoots } from '../cursor/capability-root';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { supportedOpenCodeHookMatcher } from '@canopy/plugin-interop/opencode-support';
import type {
  ProviderProcessOwner,
  ProviderProcessSpawner,
} from '../provider-process/spawn';
import type { CursorHookOutcome } from '../cursor/hook-transport';
import type { OpenCodeToolInput } from './runtime';
import type { OpenCodeApprovalPort } from './tool-approval';
import type { OpenCodeCapabilitySnapshot } from './capability-snapshot';
import {
  openCodeMcpNativeKey,
  resolveOpenCodeMcpSnapshotTool,
} from './mcp-tool-identity';

export interface OpenCodeCommandHook {
  event: 'PreToolUse' | 'PostToolUse';
  root: string;
  command: string;
  matcher: string;
  timeoutMs: number;
}

class HookTurnStopped extends Error {}

function matches(matcher: string, name: string): boolean {
  return matcher
    .split('|')
    .some(
      (part) =>
        !part ||
        part === '*' ||
        part === '.*' ||
        (part.endsWith('.*')
          ? name.startsWith(part.slice(0, -2))
          : name === part),
    );
}

/** Read only admitted plugin roots. Config paths cannot escape an installed plugin. */
export async function readOpenCodeCommandHooks(
  roots: readonly string[],
  signal: AbortSignal,
): Promise<{
  hooks: OpenCodeCommandHook[];
  warnings: string[];
}> {
  const hooks: OpenCodeCommandHook[] = [];
  const warnings: string[] = [];
  for (const source of new Set(roots)) {
    signal.throwIfAborted();
    const root = await realpath(source);
    const read = async (
      path: string,
    ): Promise<Record<string, unknown> | undefined> => {
      const requested = resolve(root, path);
      let file: string;
      try {
        file = await realpath(requested);
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return undefined;
        throw error;
      }
      const within = relative(root, file);
      if (within.startsWith('..') || isAbsolute(within))
        throw new Error('Hook configuration escapes its plugin.');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of createReadStream(file, { signal })) {
        if (!Buffer.isBuffer(chunk))
          throw new Error('Invalid hook configuration.');
        size += chunk.byteLength;
        if (size > 256 * 1024)
          throw new Error('Hook configuration is too large.');
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!isRecord(parsed)) throw new Error('Hook configuration is invalid.');
      return parsed;
    };
    const manifest = await read('.claude-plugin/plugin.json');
    const configured = manifest?.hooks;
    const configs: Record<string, unknown>[] = [];
    if (isRecord(configured)) configs.push(configured);
    else {
      const references: unknown[] =
        configured === undefined
          ? ['hooks/hooks.json']
          : Array.isArray(configured)
            ? configured
            : [configured];
      for (const reference of new Set(references)) {
        if (typeof reference !== 'string')
          throw new Error('Hook configuration path is invalid.');
        const config = await read(
          reference.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, ''),
        );
        if (config) configs.push(config);
        else if (configured !== undefined)
          throw new Error('A selected plugin hook configuration is missing.');
      }
    }
    for (const config of configs) {
      const events = isRecord(config.hooks) ? config.hooks : config;
      for (const [event, entries] of Object.entries(events)) {
        if (event === 'modules') continue;
        if (!Array.isArray(entries))
          throw new Error('Hook event configuration is invalid.');
        for (const entry of entries) {
          if (
            !isRecord(entry) ||
            (entry.hooks !== undefined && !Array.isArray(entry.hooks))
          )
            throw new Error('Hook configuration is invalid.');
          const matcher =
            typeof entry.matcher === 'string' ? entry.matcher : '';
          const entriesToRun: unknown[] = Array.isArray(entry.hooks)
            ? entry.hooks
            : [entry];
          for (const hook of entriesToRun) {
            if (!isRecord(hook))
              throw new Error('Hook configuration is invalid.');
            if (
              (event !== 'PreToolUse' && event !== 'PostToolUse') ||
              (hook.type ?? 'command') !== 'command' ||
              hook.async === true ||
              !supportedOpenCodeHookMatcher(matcher)
            ) {
              warnings.push(
                `OpenCode skipped an unsupported ${event} hook in ${source}.`,
              );
              continue;
            }
            if (
              typeof hook.command !== 'string' ||
              !hook.command.trim() ||
              hook.command.length > 16 * 1024
            )
              throw new Error('Hook command is invalid.');
            const timeout = hook.timeout ?? 60;
            if (
              typeof timeout !== 'number' ||
              !Number.isFinite(timeout) ||
              timeout <= 0 ||
              timeout > 300
            )
              throw new Error(
                'Hook timeout must be between 0 and 300 seconds.',
              );
            hooks.push({
              event,
              root,
              command: hook.command,
              matcher,
              timeoutMs: timeout * 1000,
            });
            if (hooks.length > 64)
              throw new Error('Too many plugin command hooks.');
          }
        }
      }
    }
  }
  signal.throwIfAborted();
  return { hooks, warnings };
}

/** Capture script bytes before a turn so installation updates cannot change its hooks. */
export async function prepareOpenCodeCommandHooks(
  roots: readonly string[],
  snapshotRoot: string,
  signal: AbortSignal,
): Promise<{
  hooks: OpenCodeCommandHook[];
  warnings: string[];
  capabilityRoots: string[];
}> {
  const discovered = await readOpenCodeCommandHooks(roots, signal);
  const sources = [...new Set(discovered.hooks.map((hook) => hook.root))];
  const copies = await materializeSelectedPluginRoots(
    snapshotRoot,
    sources,
    signal,
  );
  const captured = await readOpenCodeCommandHooks(copies, signal);
  return {
    hooks: captured.hooks,
    warnings: discovered.warnings,
    capabilityRoots: [snapshotRoot],
  };
}

const nativeNames: Record<string, string> = {
  bash: 'Bash',
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
};

function hookInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const aliases: Record<string, string> = ['read', 'write', 'edit'].includes(
    name,
  )
    ? {
        path: 'file_path',
        filePath: 'file_path',
        oldString: 'old_string',
        newString: 'new_string',
        replaceAll: 'replace_all',
      }
    : name === 'shell' || name === 'bash'
      ? { workdir: 'cwd' }
      : {};
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [aliases[key] ?? key, value]),
  );
}

function nativeInput(
  name: string,
  original: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const aliases: Record<string, string> = ['read', 'write', 'edit'].includes(
    name,
  )
    ? {
        file_path: 'path' in original ? 'path' : 'filePath',
        old_string: 'oldString',
        new_string: 'newString',
        replace_all: 'replaceAll',
      }
    : name === 'shell' || name === 'bash'
      ? { cwd: 'workdir' }
      : {};
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [aliases[key] ?? key, value]),
  );
}

export function createOpenCodeCommandHooks(options: {
  hooks: readonly OpenCodeCommandHook[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  approval: OpenCodeApprovalPort;
  spawnProcess: ProviderProcessSpawner;
  processOwner: ProviderProcessOwner;
  permissionMode: string;
  /** Read the captured catalog after discovery completes, never rediscover during a hook. */
  mcpSnapshot?: () => OpenCodeCapabilitySnapshot['mcp'];
}): {
  before: (input: OpenCodeToolInput) => Promise<CursorHookOutcome>;
  after: (
    input: OpenCodeToolInput,
    result: unknown,
  ) => Promise<CursorHookOutcome>;
} {
  async function execute(
    hook: OpenCodeCommandHook,
    input: unknown,
  ): Promise<string> {
    options.signal.throwIfAborted();
    if (options.permissionMode === 'plan')
      throw new Error('Plan mode does not run plugin commands.');
    // The plugin placeholder is part of the hook contract, including cmd.exe.
    const command = hook.command.split('${CLAUDE_PLUGIN_ROOT}').join(hook.root);
    const approval = await options.approval.check(
      { kind: 'command', command, cwd: options.cwd },
      {
        title: `Plugin wants to run a ${hook.event} hook`,
        details: { kind: 'command', command, cwd: options.cwd },
        suggestedTarget: { kind: 'command', pattern: command },
      },
    );
    options.signal.throwIfAborted();
    if (approval.stopTurn)
      throw new HookTurnStopped('The plugin hook command was stopped.');
    if (approval.decision !== 'allow')
      throw new Error('The plugin hook command was denied.');
    const windows = hostPlatformOperatingSystem() === 'win32';
    const child = options.spawnProcess({
      command: windows ? (options.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
      args: windows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command],
      ...(windows ? { windowsVerbatimArguments: true } : {}),
      cwd: options.cwd,
      env: { ...options.env, CLAUDE_PLUGIN_ROOT: hook.root },
      owner: options.processOwner,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failed: Error | undefined;
    const stop = (message: string): void => {
      failed ??= new Error(message);
      void child.stop().catch(() => undefined);
    };
    const collect =
      (target: Buffer[]) =>
      (chunk: unknown): void => {
        if (!Buffer.isBuffer(chunk)) {
          stop('Invalid hook output.');
          return;
        }
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024) {
          stop('Plugin hook output exceeded 64 KiB.');
          return;
        }
        target.push(chunk);
      };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin?.on('error', (error: unknown) => {
      // Hooks may exit without consuming stdin. Keep their exit/output result;
      // closing that pipe is not itself a denial of the tool.
      if (
        isRecord(error) &&
        (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')
      )
        return;
      stop('Plugin hook input could not be delivered.');
    });
    const done = new Promise<number | null>((resolveDone) => {
      child.once('error', () => stop('Plugin hook could not start.'));
      child.once('close', (code) => resolveDone(code));
    });
    const abort = (): void => stop('Plugin hook was cancelled.');
    const timer = setTimeout(
      () => stop('Plugin hook timed out.'),
      hook.timeoutMs,
    );
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdin?.end(JSON.stringify(input) + '\n');
    try {
      const code = await done;
      if (failed) throw failed;
      if (code !== 0)
        throw new Error(
          Buffer.concat(stderr).toString('utf8').trim() ||
            'Plugin hook blocked the tool.',
        );
      return Buffer.concat(stdout).toString('utf8').trim();
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      await child.stop();
    }
  }
  async function run(
    event: OpenCodeCommandHook['event'],
    input: OpenCodeToolInput,
    result?: unknown,
  ): Promise<CursorHookOutcome> {
    let toolArgs = input.toolArgs;
    let rewritten = false;
    const context: string[] = [];
    try {
      const snapshot = options.mcpSnapshot?.() ?? [];
      const mcp = resolveOpenCodeMcpSnapshotTool(snapshot, input.toolName);
      if (
        !mcp &&
        snapshot.some((server) =>
          server.tools.some(
            (tool) =>
              openCodeMcpNativeKey(server.name, tool.name) === input.toolName,
          ),
        )
      )
        throw new Error('Plugin hook MCP tool identity is ambiguous.');
      const name = mcp
        ? `mcp__${mcp.server}__${mcp.tool.name}`
        : (nativeNames[input.toolName] ?? input.toolName);
      if (
        event === 'PreToolUse' &&
        ['patch', 'apply_patch'].includes(input.toolName) &&
        options.hooks.some(
          (hook) =>
            matches(hook.matcher, 'Write') || matches(hook.matcher, 'Edit'),
        )
      )
        throw new Error(
          'The selected plugin hooks require individual Edit or Write calls.',
        );
      for (const hook of options.hooks) {
        if (hook.event !== event || !matches(hook.matcher, name)) continue;
        const output = await execute(hook, {
          session_id: input.sessionId,
          cwd: options.cwd,
          hook_event_name: event,
          tool_name: name,
          tool_input: hookInput(input.toolName, toolArgs),
          tool_use_id: input.toolCallId,
          permission_mode:
            options.permissionMode === 'full-access' ||
            options.permissionMode === 'dangerous_all'
              ? 'bypassPermissions'
              : options.permissionMode === 'auto'
                ? 'acceptEdits'
                : options.permissionMode === 'plan'
                  ? 'plan'
                  : 'default',
          ...(event === 'PostToolUse' ? { tool_response: result } : {}),
        });
        if (!output) continue;
        if (!output.startsWith('{')) {
          if (event === 'PostToolUse') context.push(output);
          continue;
        }
        const parsed: unknown = JSON.parse(output);
        if (!isRecord(parsed)) throw new Error('Invalid plugin hook response.');
        const specific = parsed.hookSpecificOutput;
        if (parsed.continue === false)
          throw new HookTurnStopped(
            typeof parsed.stopReason === 'string'
              ? parsed.stopReason
              : 'Plugin hook stopped the turn.',
          );
        if (parsed.decision === 'block')
          throw new Error(
            typeof parsed.reason === 'string'
              ? parsed.reason
              : 'Plugin hook stopped the tool.',
          );
        if (
          specific !== undefined &&
          (!isRecord(specific) || specific.hookEventName !== event)
        )
          throw new Error('Plugin hook response names a different event.');
        if (isRecord(specific)) {
          if (
            specific.permissionDecision !== undefined &&
            (typeof specific.permissionDecision !== 'string' ||
              !['allow', 'deny', 'ask'].includes(specific.permissionDecision))
          )
            throw new Error('Invalid plugin hook permission decision.');
          if (
            specific.permissionDecision === 'deny' ||
            specific.permissionDecision === 'ask'
          )
            throw new Error(
              typeof specific.permissionDecisionReason === 'string'
                ? specific.permissionDecisionReason
                : 'Plugin hook requires approval.',
            );
          if (specific.updatedInput !== undefined) {
            if (event !== 'PreToolUse' || !isRecord(specific.updatedInput))
              throw new Error('Invalid plugin hook input rewrite.');
            toolArgs = nativeInput(
              input.toolName,
              toolArgs,
              specific.updatedInput,
            );
            rewritten = true;
          }
          if (typeof specific.additionalContext === 'string') {
            if (event === 'PreToolUse' && specific.additionalContext)
              throw new Error(
                'OpenCode cannot deliver additional context from a before-tool hook.',
              );
            context.push(specific.additionalContext);
          }
        }
      }
      options.signal.throwIfAborted();
      return {
        decision: 'allow',
        ...(event === 'PreToolUse'
          ? rewritten
            ? { updatedInput: toolArgs }
            : {}
          : { updatedInput: { additionalContext: context.join('\n') } }),
      };
    } catch (error) {
      return {
        decision: 'deny',
        ...(error instanceof HookTurnStopped ? { stopTurn: true } : {}),
        message: error instanceof Error ? error.message : 'Plugin hook failed.',
      };
    }
  }
  return {
    before: (input: OpenCodeToolInput): Promise<CursorHookOutcome> =>
      run('PreToolUse', input),
    after: (
      input: OpenCodeToolInput,
      result: unknown,
    ): Promise<CursorHookOutcome> => run('PostToolUse', input, result),
  };
}
