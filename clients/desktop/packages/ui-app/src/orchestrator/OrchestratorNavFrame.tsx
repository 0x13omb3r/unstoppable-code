'use client';

import type { JSX, ReactNode, Ref, TransitionEventHandler } from 'react';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { Surface } from '@canopy/ui-shared/components';

export interface OrchestratorNavFrameProps {
  readonly presentation: 'window' | 'rail';
  readonly collapsed?: boolean;
  readonly navRef?: Ref<HTMLElement>;
  readonly onTransitionEnd?: TransitionEventHandler<HTMLElement>;
  readonly controls?: ReactNode;
  readonly children: ReactNode;
  readonly testId: string;
}

/** The persistent frame is shared; each host supplies its existing row commands. */
export function OrchestratorNavFrame({
  presentation,
  collapsed = false,
  navRef,
  onTransitionEnd,
  controls,
  children,
  testId,
}: OrchestratorNavFrameProps): JSX.Element {
  if (presentation === 'window') {
    return (
      <nav
        ref={navRef}
        data-testid={testId}
        data-collapsed={collapsed ? 'true' : 'false'}
        aria-label={`${ORCHESTRATOR_LABEL} navigation`}
        onTransitionEnd={onTransitionEnd}
        className={`flex h-full shrink-0 flex-col overflow-hidden transition-[width] duration-150 ease-out ${collapsed ? 'w-0' : 'w-60'}`}
      >
        {!collapsed && (
          <div className="electron-drag h-10.75 shrink-0">{controls}</div>
        )}
        {children}
      </nav>
    );
  }
  return (
    <Surface
      aria-label={`${ORCHESTRATOR_LABEL} navigation`}
      data-testid={testId}
      as="nav"
      variant="rail"
      extent="parent"
      className="flex min-h-0 flex-col overflow-hidden"
    >
      <div className="flex h-10.75 shrink-0 items-center px-2">{controls}</div>
      {children}
    </Surface>
  );
}
