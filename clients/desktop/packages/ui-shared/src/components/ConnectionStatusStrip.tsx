import type { JSX, ReactNode } from 'react';
import { HAIRLINE_INSET_RING_CLASS } from '../lib/row-chips';

const STATUS_PAINT = {
  reconnecting: 'ring-line-attention/40 bg-warning-subtle fg-warning',
  disconnected: 'ring-line-destructive/40 bg-destructive-subtle fg-destructive',
} as const;

export function ConnectionStatusStrip({
  status,
  leading,
  children,
  'data-testid': testId,
}: {
  readonly status: keyof typeof STATUS_PAINT;
  readonly leading?: ReactNode;
  readonly children: ReactNode;
  readonly 'data-testid': string;
}): JSX.Element {
  return (
    <div
      className={`shrink-0 text-xs ${HAIRLINE_INSET_RING_CLASS} ${STATUS_PAINT[status]} ${leading === undefined ? 'px-4 py-2' : 'flex items-center gap-1.5 px-3 py-1.5'}`}
      data-testid={testId}
    >
      {leading === undefined ? (
        children
      ) : (
        <>
          <span aria-hidden="true" className="shrink-0 leading-none">
            {leading}
          </span>
          <span className="min-w-0 flex-1 truncate">{children}</span>
        </>
      )}
    </div>
  );
}
