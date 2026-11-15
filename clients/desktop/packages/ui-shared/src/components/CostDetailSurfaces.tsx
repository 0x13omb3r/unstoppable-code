import type { JSX, ReactNode } from 'react';

export type CostBreakdownEntryLayout = 'stack' | 'inline';

function costBreakdownEntryClass(layout: CostBreakdownEntryLayout): string {
  return `flex w-full rounded-md px-2 py-2 text-left text-xs pointer-coarse:min-h-11 ${layout === 'stack' ? 'flex-col gap-1.5' : 'items-center gap-3'}`;
}

export function CostBreakdownEntry({
  layout,
  children,
  labelledBy,
  testId,
}: {
  readonly layout: CostBreakdownEntryLayout;
  readonly children: ReactNode;
  readonly labelledBy?: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <div
      role={labelledBy === undefined ? undefined : 'group'}
      aria-labelledby={labelledBy}
      data-testid={testId}
      className={costBreakdownEntryClass(layout)}
    >
      {children}
    </div>
  );
}

export function CostSourceSwatch({
  color,
}: {
  readonly color: string;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-xs"
      style={{ backgroundColor: color }}
    />
  );
}

export function ContextUsagePlotSurface({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="relative h-16 w-full rounded-sm bg-muted">{children}</div>
  );
}
