'use client';

import type { JSX } from 'react';
import { AutoArchiveSettingsControl } from './AutoArchiveSettingsControl';
import { TextInput } from './Field';
import { Heading } from './Heading';
import { Inline, Stack } from './Stack';
import { Surface } from './Surface';

export interface OrchestratorRetentionCardProps {
  readonly retentionDays: number;
  readonly onRetentionDaysChange: (days: number) => void;
  readonly maxDays: number;
  readonly fallbackRetentionDays: number;
  readonly autoArchiveEnabled: boolean;
  readonly autoArchiveDays: number;
  readonly fallbackAutoArchiveDays: number;
  readonly onAutoArchiveEnabledChange: (enabled: boolean) => void;
  readonly onAutoArchiveDaysChange: (days: number) => void;
  readonly autoArchiveDaysLabel?: string;
  readonly testIdPrefix: string;
  readonly surfaceTestId?: string;
}

export function OrchestratorRetentionCard({
  retentionDays,
  onRetentionDaysChange,
  maxDays,
  fallbackRetentionDays,
  autoArchiveEnabled,
  autoArchiveDays,
  fallbackAutoArchiveDays,
  onAutoArchiveEnabledChange,
  onAutoArchiveDaysChange,
  autoArchiveDaysLabel,
  testIdPrefix,
  surfaceTestId,
}: OrchestratorRetentionCardProps): JSX.Element {
  const labelId = `${testIdPrefix}-retention-days-label`;
  const settingsTestId = `${testIdPrefix}-settings`;
  const unit = retentionDays === 1 ? 'day' : 'days';

  return (
    <Surface
      variant="outline"
      padding="default"
      data-testid={surfaceTestId ?? `${settingsTestId}-retention-card`}
    >
      <Stack
        gap="item"
        data-testid={
          surfaceTestId ? `${settingsTestId}-retention-card` : undefined
        }
      >
        <Stack gap="tight">
          <Heading level={3} variant="title">
            Deletion retention
          </Heading>
          <p className="text-xs fg-secondary">
            {`Deleted and archived chats are kept for ${retentionDays} ${unit} before they're removed. Archived work entries are kept until you delete them.`}
          </p>
        </Stack>
        <div>
          <Inline gap="item">
            <span id={labelId} className="text-s fg-primary">
              Keep deleted chats for
            </span>
            <div className="w-28">
              <TextInput
                density="settings"
                type="number"
                aria-labelledby={labelId}
                trailing="days"
                value={retentionDays}
                onChange={(event) =>
                  onRetentionDaysChange(
                    Math.max(
                      1,
                      Math.min(
                        maxDays,
                        Number.parseInt(event.target.value, 10) ||
                          fallbackRetentionDays,
                      ),
                    ),
                  )
                }
                min={1}
                max={maxDays}
                data-testid={`${settingsTestId}-retention-days`}
              />
            </div>
          </Inline>
          <AutoArchiveSettingsControl
            enabled={autoArchiveEnabled}
            days={autoArchiveDays}
            maxDays={maxDays}
            fallbackDays={fallbackAutoArchiveDays}
            description="Delete fully idle sessions after a period of inactivity."
            toggleTestId={`${settingsTestId}-auto-archive-toggle`}
            daysTestId={`${settingsTestId}-auto-archive-days`}
            onEnabledChange={onAutoArchiveEnabledChange}
            onDaysChange={onAutoArchiveDaysChange}
            daysLabel={autoArchiveDaysLabel}
          />
        </div>
      </Stack>
    </Surface>
  );
}
