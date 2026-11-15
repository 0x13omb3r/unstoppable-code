import type { JSX } from 'react';

const ACTIVITY_HEATMAP_LEVEL = [
  'bg-secondary',
  'bg-accent-subtle',
  'bg-accent/50',
  'bg-accent/75',
  'bg-accent',
] as const;

export function ActivityHeatmapCell({
  level,
  title,
  legend = false,
}: {
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly title?: string;
  readonly legend?: boolean;
}): JSX.Element {
  return (
    <span
      title={title}
      aria-hidden={legend || undefined}
      className={`rounded-sm ${legend ? 'h-3 w-3' : 'aspect-square w-full'} ${ACTIVITY_HEATMAP_LEVEL[level]}`}
    />
  );
}
