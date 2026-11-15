import type { JSX, ReactNode } from 'react';

export type ScrollableTabFrameVariant = 'underline' | 'segmented';

const FRAME_CLASS: Record<ScrollableTabFrameVariant, string> = {
  segmented: 'min-w-0 max-w-full rounded-md border p-0.5',
  underline: 'border-b',
};

/** Outer frame for a scrolling tab strip. The strip owns the overflow mask. */
export function ScrollableTabFrame({
  variant,
  children,
}: {
  readonly variant: ScrollableTabFrameVariant;
  readonly children: ReactNode;
}): JSX.Element {
  return <div className={FRAME_CLASS[variant]}>{children}</div>;
}
