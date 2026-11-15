import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react';

type FeedTone = 'default' | 'danger';

interface OrganizationFeedCardProps extends Omit<
  ComponentPropsWithoutRef<'article'>,
  'className'
> {
  readonly tone?: FeedTone;
  readonly highlighted?: boolean;
}

/** Activity card with enough intrinsic height for deferred feed rendering. */
export function OrganizationFeedCard({
  tone = 'default',
  highlighted = false,
  ...props
}: OrganizationFeedCardProps): JSX.Element {
  const toneClass =
    tone === 'danger'
      ? 'border-line-destructive/40 bg-destructive/5'
      : 'bg-card';
  const highlightClass = highlighted
    ? 'ring-2 ring-line-accent ring-offset-2 ring-offset-base'
    : '';
  // Deferred layout keeps long feeds responsive. Find-in-page may miss
  // off-screen content until Chromium lays out its card. The intrinsic
  // estimate reduces scroll drift when jumping to an unloaded permalink.
  return (
    <article
      {...props}
      className={`scroll-mt-24 rounded-xl border p-4 [content-visibility:auto] [contain-intrinsic-size:auto_280px] ${toneClass} ${highlightClass}`}
    />
  );
}

/** Activity glyph over a feed actor's avatar. The card text names the event. */
export function OrganizationFeedActivityMark({
  tone = 'default',
  children,
}: {
  readonly tone?: FeedTone;
  readonly children: ReactNode;
}): JSX.Element {
  const toneClass =
    tone === 'danger' ? 'bg-destructive fg-emphasis' : 'bg-secondary fg-accent';
  return (
    <span
      className={`absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-card [&>svg]:h-3 [&>svg]:w-3 ${toneClass}`}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}
