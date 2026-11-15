import type { JSX, ReactNode } from 'react';

/** A compact usage donut with room for a total and label at its center. */
export function ActivityDonut({
  gradient,
  children,
}: {
  readonly gradient: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="mx-auto grid h-48 w-48 place-items-center rounded-full"
      style={{ background: gradient }}
    >
      <div className="grid h-28 w-28 place-items-center rounded-full bg-card text-center">
        {children}
      </div>
    </div>
  );
}

/** Matches the segment color in a chart's summary or legend. */
export function ActivitySwatch({
  color,
  size = 'legend',
}: {
  readonly color: string;
  readonly size?: 'legend' | 'summary' | 'selector';
}): JSX.Element {
  const sizeClass = {
    legend: 'h-2 w-2 rounded-full',
    summary: 'h-2.5 w-2.5 rounded-full',
    selector: 'inline-block h-2 w-2 rounded-sm',
  }[size];
  return (
    <span
      aria-hidden="true"
      className={sizeClass}
      style={{ backgroundColor: color }}
    />
  );
}
