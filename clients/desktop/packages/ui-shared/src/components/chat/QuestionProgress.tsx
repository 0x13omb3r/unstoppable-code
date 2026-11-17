import type { JSX } from 'react';

export function QuestionProgress({
  count,
  step,
  density = 'default',
}: {
  readonly count: number;
  readonly step: number;
  readonly density?: 'default' | 'compact';
}): JSX.Element {
  return (
    <ol
      aria-label="Question progress"
      className={
        density === 'compact'
          ? 'flex items-center gap-2 px-1'
          : 'flex items-center gap-1.5'
      }
    >
      {Array.from({ length: count }, (_, index) => (
        <li
          key={index}
          aria-label={`Question ${index + 1} of ${count}`}
          aria-current={index === step ? 'step' : undefined}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 6 6"
            className={`shrink-0 ${density === 'compact' ? 'size-1.25' : 'size-1.5'} ${index === step ? 'fg-primary' : 'fg-quaternary'}`}
          >
            <circle cx="3" cy="3" r="3" fill="currentColor" />
          </svg>
        </li>
      ))}
    </ol>
  );
}
