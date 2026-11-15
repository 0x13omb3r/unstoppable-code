'use client';

import { type JSX, useState } from 'react';
import {
  ErrorBanner,
  SettingsRowsRow,
  ToggleSwitch,
} from '@canopy/ui-shared/components';

export interface LearnFromChatsSettingProps {
  readonly enabled: boolean;
  readonly disabled?: boolean;
  readonly save: (enabled: boolean) => Promise<void>;
}

/** A host supplies preference persistence; the control carries no desktop dependencies. */
export function LearnFromChatsSetting({
  enabled,
  disabled = false,
  save,
}: LearnFromChatsSettingProps): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const change = async (next: boolean): Promise<void> => {
    setSaving(true);
    setError(false);
    try {
      await save(next);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SettingsRowsRow
        label="Learn from chats"
        htmlFor="settings-memory-learn-from-chats"
        description="Learn facts and decisions while your chats are idle. Turning this off keeps existing memories."
        control={
          <ToggleSwitch
            id="settings-memory-learn-from-chats"
            label="Learn from chats"
            checked={enabled}
            disabled={disabled || saving}
            onChange={(next) => {
              void change(next);
            }}
            dataTestId="local-memory-learn-from-chats-toggle"
          />
        }
      />
      {error && (
        <ErrorBanner
          errorSource="memory-learn-from-chats-setting"
          error="Couldn't save this setting. Try again."
        />
      )}
    </>
  );
}
