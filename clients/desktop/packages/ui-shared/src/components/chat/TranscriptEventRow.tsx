import { useState, type JSX, type ReactNode } from 'react';
import { Surface } from '../Surface';
import { StepRow } from './StepRow';

export function TranscriptEventRow({
  icon,
  label,
  detail,
  children,
  dataTestId,
  forceOpen = false,
}: {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly children?: ReactNode;
  readonly dataTestId?: string;
  readonly forceOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = children != null;
  const expanded = open || forceOpen;

  return (
    <div className="min-w-0">
      <div className="px-2">
        <StepRow
          step
          icon={icon}
          label={label}
          detail={detail}
          expandable={expandable}
          isOpen={expanded}
          onToggle={
            forceOpen ? undefined : (): void => setOpen((value) => !value)
          }
          extent="fill"
          dataTestId={dataTestId}
        />
      </div>
      {expanded && expandable ? (
        <div className="pl-9 text-s fg-secondary">
          <Surface
            variant="transcript-nested-well"
            padding="tight"
            className="min-w-0"
          >
            {children}
          </Surface>
        </div>
      ) : null}
    </div>
  );
}

/** Quiet transcript context that does not require an action. */
export function TranscriptEventMarker({
  icon,
  children,
  dataTestId,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly dataTestId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={dataTestId}
      data-chat-notice=""
      className="flex min-w-0 items-center gap-2 py-1 text-xs fg-tertiary"
    >
      <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-line-base" />
      <span className="flex min-w-0 items-center justify-center gap-1.5 text-center">
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
        <span>{children}</span>
      </span>
      <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-line-base" />
    </div>
  );
}
