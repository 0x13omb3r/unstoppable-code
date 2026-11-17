'use client';

import type { JSX, ReactNode } from 'react';
import {
  Badge,
  ProviderRowLabel,
  ProviderStatusDot,
  ReadyStatusLine,
  SettingsRowsRow,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared/components';

/**
 * One provider as a Settings-style row: its mark, name and status dot, a
 * description, an optional detail line and a trailing control. Purely
 * presentational, so the first-run page and the provider-choice list render
 * the same row; each host supplies the control and its mechanics.
 */
export interface ProviderSourceRowProps {
  /** The provider's mark at 16px. */
  readonly icon?: ReactNode;
  readonly name: ReactNode;
  /** The status dot's tone, or omitted while there is nothing to report. */
  readonly status?: ProviderStatusDotTone;
  /** Names the dot's state for assistive technology when the text doesn't. */
  readonly statusLabel?: string;
  /** A neutral badge after the name, such as "Current". */
  readonly badge?: string;
  readonly description?: ReactNode;
  /**
   * A line under the description. `ready` renders it as a ready line (a
   * decorative check); `plain` in tertiary ink, a step quieter than the
   * description, so what choosing the row does reads apart from what the
   * source is.
   */
  readonly detail?: {
    readonly kind: 'ready' | 'plain';
    readonly text: ReactNode;
    readonly testId?: string;
  };
  readonly control?: ReactNode;
  readonly dataTestId?: string;
}

/** The name's trailing markers: the status dot, then the badge. */
function rowMarkers({
  status,
  statusLabel,
  badge,
  badgeTestId,
}: {
  readonly status: ProviderStatusDotTone | undefined;
  readonly statusLabel: string | undefined;
  readonly badge: string | undefined;
  readonly badgeTestId: string | undefined;
}): JSX.Element | undefined {
  if (status === undefined && badge === undefined) return undefined;
  return (
    <>
      {status !== undefined && (
        <ProviderStatusDot
          tone={status}
          {...(statusLabel !== undefined ? { label: statusLabel } : {})}
        />
      )}
      {badge !== undefined && (
        <Badge
          {...(badgeTestId !== undefined ? { 'data-testid': badgeTestId } : {})}
        >
          {badge}
        </Badge>
      )}
    </>
  );
}

/** The description, then the detail line under it. */
function rowDescription({
  description,
  detail,
}: Pick<ProviderSourceRowProps, 'description' | 'detail'>): ReactNode {
  if (detail === undefined) return description;
  return (
    <span className="flex flex-col gap-0.5">
      {description !== undefined && <span>{description}</span>}
      {detail.kind === 'ready' ? (
        <ReadyStatusLine
          {...(detail.testId !== undefined
            ? { 'data-testid': detail.testId }
            : {})}
        >
          {detail.text}
        </ReadyStatusLine>
      ) : (
        <span data-testid={detail.testId} className="fg-tertiary">
          {detail.text}
        </span>
      )}
    </span>
  );
}

export function ProviderSourceRow({
  icon,
  name,
  status,
  statusLabel,
  badge,
  description,
  detail,
  control,
  dataTestId,
}: ProviderSourceRowProps): JSX.Element {
  return (
    <SettingsRowsRow
      label={
        <ProviderRowLabel
          icon={icon}
          name={name}
          status={rowMarkers({
            status,
            statusLabel,
            badge,
            badgeTestId:
              dataTestId !== undefined ? `${dataTestId}-badge` : undefined,
          })}
        />
      }
      // Called, not rendered: the row draws its description block only
      // when there is one.
      description={rowDescription({ description, detail })}
      control={control}
      {...(dataTestId !== undefined ? { dataTestId } : {})}
    />
  );
}
