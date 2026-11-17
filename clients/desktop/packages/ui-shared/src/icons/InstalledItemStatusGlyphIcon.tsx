import type { JSX } from 'react';
import type { InstalledItemStatus } from '@canopy/protocol/installed-items';

type Status = InstalledItemStatus | 'unavailable';

function StatusGlyph({ status }: { readonly status: Status }): JSX.Element {
  if (status === 'active' || status === 'available')
    return <circle cx="4" cy="4" r="4" fill="currentColor" />;
  return (
    <>
      <circle
        cx="4"
        cy="4"
        r="3.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {status === 'unavailable' && (
        <path
          data-status-slash
          d="M1.7 6.3 6.3 1.7"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </>
  );
}

/** Eight-pixel status dot, centered in its host's icon slot. */
export function InstalledItemStatusGlyphIcon({
  status,
  className,
}: {
  readonly status: Status;
  readonly className: string;
}): JSX.Element {
  return (
    <svg
      data-status-dot={status}
      width="8"
      height="8"
      viewBox="0 0 8 8"
      className={`shrink-0 ${className}`}
    >
      <StatusGlyph status={status} />
    </svg>
  );
}
