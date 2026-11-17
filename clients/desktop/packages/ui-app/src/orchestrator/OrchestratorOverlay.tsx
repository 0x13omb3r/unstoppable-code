'use client';

import type { JSX, ReactNode } from 'react';
import { Surface } from '@canopy/ui-shared/components';

export interface OrchestratorOverlayProps {
  readonly children: ReactNode;
  readonly titlebar?: ReactNode;
  /** A workspace reserves the panel minimum; an overlay fills its shell. */
  readonly extent: 'workspace' | 'overlay';
  readonly testId: string;
}

/** Chat execution and transcript ownership stay in the supplied host content. */
export function OrchestratorOverlay({
  children,
  titlebar,
  extent,
  testId,
}: OrchestratorOverlayProps): JSX.Element {
  return (
    <div
      className={
        extent === 'workspace'
          ? 'relative flex min-h-55 min-w-0 flex-1 flex-col'
          : 'relative flex min-h-0 min-w-0 flex-1 flex-col'
      }
    >
      <Surface
        as="section"
        variant="tinted-panel"
        // The host's inset-material rule must reach the painted region.
        data-testid={testId}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {titlebar}
        {children}
      </Surface>
    </div>
  );
}
