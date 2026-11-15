import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../lib/type-guards';
import { parseClaudeJsonFile } from './claude-mod-admission';

function readPolicyFile(file: string, strict: boolean): unknown {
  try {
    return parseClaudeJsonFile(readFileSync(file));
  } catch (error) {
    if (strict && !(isRecord(error) && error.code === 'ENOENT'))
      throw new Error('Claude plugin policy is unreadable.');
    return undefined;
  }
}

/** User-scope disables apply to explicit selections as well as carryover. */
export function readClaudeDisabledInstalledPlugins(
  claudeConfigDir: string,
  options: { strict?: boolean } = {},
): string[] {
  const strict = options.strict === true;
  const installedFile = readPolicyFile(
    join(claudeConfigDir, 'plugins', 'installed_plugins.json'),
    strict,
  );
  const settingsFile = readPolicyFile(
    join(claudeConfigDir, 'settings.json'),
    strict,
  );
  const installed =
    isRecord(installedFile) && isRecord(installedFile.plugins)
      ? installedFile.plugins
      : undefined;
  const settings =
    isRecord(settingsFile) && isRecord(settingsFile.enabledPlugins)
      ? settingsFile.enabledPlugins
      : {};
  if (
    strict &&
    ((installedFile !== undefined && !installed) ||
      (settingsFile !== undefined &&
        (!isRecord(settingsFile) ||
          (settingsFile.enabledPlugins !== undefined &&
            !isRecord(settingsFile.enabledPlugins)))) ||
      Object.values(settings).some((value) => typeof value !== 'boolean'))
  )
    throw new Error('Claude plugin policy is unreadable.');
  return Object.entries(installed ?? {}).flatMap(([id, entry]) => {
    const candidates = Array.isArray(entry) ? entry : [entry];
    return settings[id] === false &&
      candidates.some(
        (candidate) =>
          isRecord(candidate) &&
          candidate.scope !== 'project' &&
          candidate.scope !== 'local',
      )
      ? [id]
      : [];
  });
}
