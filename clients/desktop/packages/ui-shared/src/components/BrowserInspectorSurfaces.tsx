import type { JSX, ReactNode } from 'react';

export function BrowserInspectorSurface({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l bg-card/40">
      {children}
    </div>
  );
}

export function BrowserNetworkRequestRow({
  children,
  failed,
}: {
  readonly children: ReactNode;
  readonly failed: boolean;
}): JSX.Element {
  return (
    <li className={`border-b px-2 py-1.5 ${failed ? 'bg-destructive/5' : ''}`}>
      {children}
    </li>
  );
}
