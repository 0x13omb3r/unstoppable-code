import type { HTMLAttributes, JSX, ReactNode, Ref } from 'react';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

type TranscriptSurfaceProps = HTMLAttributes<HTMLDivElement> & {
  readonly ref?: Ref<HTMLDivElement>;
};

export function StickyPromptSurface(
  props: TranscriptSurfaceProps,
): JSX.Element {
  return (
    <div
      {...props}
      className="group/sticky sticky top-0 z-20 before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-base"
    />
  );
}

export function StickyPromptFade(): JSX.Element {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-full hidden h-2.5 bg-gradient-to-b from-base/80 via-base/30 to-transparent group-data-[underlap]/sticky:block"
    />
  );
}

export function StickyPromptBacking({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="relative group-data-[stuck]/sticky:bg-base">{children}</div>
  );
}

export function StickyTurnBacking({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="relative bg-base before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-base">
      {children}
    </div>
  );
}

export function TranscriptReadingColumn(
  props: TranscriptSurfaceProps,
): JSX.Element {
  return (
    <div
      {...props}
      className={`${REPLAY_BLOCK_CLASS} mx-auto flex w-full max-w-[var(--chat-reading-width)] flex-col gap-2 chat-width-transition [&>*]:shrink-0 [&_[data-chat-call-focus]]:rounded-lg [&_[data-chat-call-focus]]:ring-2 [&_[data-chat-call-focus]]:ring-line-accent`}
    />
  );
}

export function TranscriptTurnSection(
  props: TranscriptSurfaceProps,
): JSX.Element {
  return (
    <div
      {...props}
      className="relative flex flex-col gap-2 rounded-lg transition-shadow data-[chat-turn-focus]:ring-2 data-[chat-turn-focus]:ring-line-accent"
    />
  );
}

export function RevertedTurnSurface({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      aria-label="Reverted turn"
      className="flex flex-col -ml-3 border-l-2 border-line-attention/40 pl-3 opacity-60 gap-2"
    >
      {children}
    </div>
  );
}
