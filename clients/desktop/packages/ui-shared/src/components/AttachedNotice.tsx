import type { ComponentPropsWithoutRef, JSX } from 'react';

const VARIANT_CLASS = {
  'workflow-error': 'border-b bg-destructive-subtle px-3 py-2',
  'yaml-error':
    'shrink-0 border-b border-line-destructive/30 bg-destructive-subtle px-4 py-2 text-xs fg-destructive',
  'csv-fallback': 'border-b bg-warning-subtle px-4 py-2 text-xs fg-warning',
} as const;

/** Feedback attached to the top edge of an editor or preview. */
export function AttachedNotice({
  variant,
  ...props
}: Omit<ComponentPropsWithoutRef<'div'>, 'className'> & {
  readonly variant: keyof typeof VARIANT_CLASS;
}): JSX.Element {
  return <div {...props} className={VARIANT_CLASS[variant]} />;
}
