import type { PreferencesDocument } from '@canopy/core-runtime/node/preferences';
import {
  USAGE_DATA_KEYS,
  type UsageDataKey,
} from '@canopy/desktop-shared/types';

import { isRecord } from './type-guards';

export interface ConsentJournal {
  read(): Promise<readonly UsageDataKey[]>;
  write(denied: readonly UsageDataKey[]): Promise<void>;
  deny(denied: readonly UsageDataKey[]): void;
}

function deniedKeys(usage: unknown): UsageDataKey[] {
  return USAGE_DATA_KEYS.filter(
    (key) => isRecord(usage) && usage[key] === false,
  );
}

/** Record revocations before any primary-save bookkeeping can fail. */
export async function recordUsageDataRevocations(
  journal: ConsentJournal,
  usage: unknown,
): Promise<readonly UsageDataKey[]> {
  const denied = deniedKeys(usage);
  const prior = await journal.read();
  const pending = [...new Set([...prior, ...denied])];
  if (pending.length) {
    journal.deny(pending);
    if (denied.some((key) => !prior.includes(key)))
      await journal.write(pending);
  }
  return pending;
}

function parseDocument(
  text: string,
): Record<string, unknown> & { preferences: Record<string, unknown> } {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.preferences))
    throw new Error('Invalid preferences consent document');
  return { ...parsed, preferences: parsed.preferences };
}

/** Write-ahead revocations survive a failed primary save and last-good recovery. */
export function withUsageDataConsentJournal(
  document: PreferencesDocument,
  journal: ConsentJournal,
): PreferencesDocument {
  return {
    ...document,
    async readText(slot): Promise<string> {
      const text = await document
        .readText(slot)
        .catch(async (error: unknown): Promise<string> => {
          // A retained revocation is existing consent state, not a fresh profile.
          if (
            slot === 'primary' &&
            isRecord(error) &&
            error.code === 'ENOENT' &&
            (await journal.read()).length &&
            !(await document.exists('lastGood'))
          )
            throw new Error(
              'Preferences missing while usage-data revocations remain',
            );
          throw error;
        });
      if (slot === 'generation') return text;
      const denied = await journal.read();
      if (!denied.length) return text;
      // Keep malformed bytes as a parse failure owned by the repository, so
      // its normal recovery can still use a current last-good document.
      let parsed: ReturnType<typeof parseDocument>;
      try {
        parsed = parseDocument(text);
      } catch {
        return text;
      }
      const preferences = parsed.preferences;
      parsed.preferences = {
        ...preferences,
        usageData: {
          ...(isRecord(preferences.usageData) ? preferences.usageData : {}),
          ...Object.fromEntries(denied.map((key) => [key, false])),
        },
      };
      return JSON.stringify(parsed);
    },
    async install(slot, content): Promise<void> {
      if (slot !== 'primary') return document.install(slot, content);
      const preferences = parseDocument(content).preferences;
      const denied = deniedKeys(preferences.usageData);
      const pending = await recordUsageDataRevocations(
        journal,
        preferences.usageData,
      );
      await document.install(slot, content);
      // Never lift a revocation before the allowing primary is durable.
      if (pending.some((key) => !denied.includes(key)))
        await journal.write(denied);
    },
  };
}
