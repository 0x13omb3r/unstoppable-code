import type { PluginHookMember } from './types';

/** Bounded matchers: exact tool names, alternatives, and prefix wildcards. */
export function supportedOpenCodeHookMatcher(value: string): boolean {
  return (
    value.length <= 256 &&
    value
      .split('|')
      .every(
        (part) =>
          part === '' ||
          part === '*' ||
          /^[A-Za-z0-9_-]+(?:\.\*)?$/.test(part) ||
          part === '.*',
      )
  );
}

export function opencodeSupportsCommandHook(hook: PluginHookMember): boolean {
  return (
    (hook.event === 'PreToolUse' || hook.event === 'PostToolUse') &&
    hook.hookType === 'command' &&
    hook.async !== true &&
    typeof hook.command === 'string' &&
    !!hook.command.trim() &&
    supportedOpenCodeHookMatcher(hook.matcher ?? '')
  );
}
