'use client';

import type { JSX, ReactNode } from 'react';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { MobileTopBarButton, Surface } from '@canopy/ui-shared/components';
import { AppAdvisorIcon } from '@canopy/ui-shared/icons/AppIcons';

export interface OrchestratorTopBarProps {
  /** Window chrome reserves a native corner; content chrome sits in a pane. */
  readonly presentation: 'window' | 'content';
  readonly cornerWidth?: string | number;
  readonly controls?: ReactNode;
  readonly actions?: ReactNode;
  readonly mobile?: boolean;
  readonly onClose?: () => void;
  readonly testIdPrefix: string;
}

/** One title bar for the Orchestrator; native actions are injected by its host. */
export function OrchestratorTopBar({
  presentation,
  cornerWidth = 0,
  controls,
  actions,
  mobile = false,
  onClose,
  testIdPrefix: prefix,
}: OrchestratorTopBarProps): JSX.Element {
  if (presentation === 'window') {
    return (
      <div className="flex min-h-10.75 shrink-0">
        <Surface
          variant="well"
          boundary="bottom"
          // Existing inset-layout CSS makes this painted surface transparent.
          data-testid={`${prefix}-top-bar`}
          className="@container/prbar flex min-w-0 flex-1 items-stretch"
        >
          <div
            className="electron-drag shrink-0 self-stretch overflow-hidden transition-[width] duration-150 ease-out"
            style={{ width: cornerWidth }}
            data-testid={`${prefix}-top-bar-corner`}
          />
          <div className="electron-drag flex min-w-0 flex-1 items-center gap-1.5 px-3">
            <AppAdvisorIcon size="sm" className="shrink-0 fg-secondary" />
            <span className="select-none truncate text-xs font-medium fg-secondary">
              {ORCHESTRATOR_LABEL}
            </span>
          </div>
          <div className="electron-drag flex shrink-0 items-center gap-2 pr-2.25">
            {actions}
          </div>
        </Surface>
      </div>
    );
  }
  return (
    <div
      className={mobile ? 'flex h-12 shrink-0' : 'flex h-10.75 shrink-0'}
      data-testid={mobile ? undefined : `${prefix}-titlebar`}
    >
      <Surface
        variant="section"
        boundary="bottom"
        padding={mobile ? 'toolbar-tight' : 'toolbar-compact'}
        gap="inline"
        direction="row"
        className="min-w-0 flex-1 items-center"
      >
        {!mobile && controls}
        <AppAdvisorIcon size="sm" className="shrink-0 fg-secondary" />
        <span className="min-w-0 flex-1 truncate text-s font-medium fg-primary/80">
          {ORCHESTRATOR_LABEL}
        </span>
        {mobile && (
          <MobileTopBarButton
            onClick={onClose}
            aria-label={`Close ${ORCHESTRATOR_LABEL}`}
            data-testid={`${prefix}-close`}
          >
            <span aria-hidden="true">✕</span>
          </MobileTopBarButton>
        )}
        {actions}
      </Surface>
    </div>
  );
}
