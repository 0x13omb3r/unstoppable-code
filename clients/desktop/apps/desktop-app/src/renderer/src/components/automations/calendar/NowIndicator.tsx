import { CalendarNowMark } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import { minutesSinceMidnight } from './calendarDateUtils';

interface NowIndicatorProps {
  now: Date;
  /** Pixel height of one hour row in the time grid. */
  hourPx: number;
}

/**
 * Google-Calendar-style red "now" line + dot, absolutely positioned at
 * `top = (minutesSinceMidnight(now) / 60) * hourPx`. Mounted only inside
 * today's column by `DayWeekTimeGrid`, so its mere presence signals that the
 * visible window includes today.
 */
export function NowIndicator({ now, hourPx }: NowIndicatorProps): JSX.Element {
  const top = (minutesSinceMidnight(now) / 60) * hourPx;
  return (
    <CalendarNowMark top={top} testId="automations-calendar-now-indicator" />
  );
}
