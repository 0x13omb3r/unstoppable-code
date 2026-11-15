import type { JSX, ReactNode } from 'react';

const excerptClasses = {
  selection: 'line-clamp-2 text-xs',
  diagram: 'text-2xs',
} as const;

/** A short excerpt of plan text shown outside the document body. */
export function PlanExcerpt({
  variant,
  children,
}: {
  readonly variant: keyof typeof excerptClasses;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p
      className={`border-l-2 pl-2 italic fg-secondary ${excerptClasses[variant]}`}
    >
      {children}
    </p>
  );
}
