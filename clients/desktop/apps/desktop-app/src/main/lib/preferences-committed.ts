import type { PreferencesData } from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from './main-process-logging';

type Listener = (preferences: Readonly<PreferencesData>) => void;
const listeners = new Set<Listener>();
let committed: Readonly<PreferencesData> | null = null;

function notify(
  listener: Listener,
  preferences: Readonly<PreferencesData>,
): void {
  try {
    listener(preferences);
  } catch (error) {
    logMainProcessWarn('[preferences] Commit listener failed', error);
  }
}

/** Synchronous so consumers revoke admission before a save acknowledges. */
export function publishCommittedPreferences(
  preferences: Readonly<PreferencesData>,
): void {
  committed = preferences;
  for (const listener of listeners) notify(listener, preferences);
}

/** Late consumers receive the last committed state without loading the store. */
export function subscribeCommittedPreferences(listener: Listener): () => void {
  listeners.add(listener);
  if (committed) notify(listener, committed);
  return () => {
    listeners.delete(listener);
  };
}
