import { Surface } from '@canopy/ui-shared/components';
import type { JSX } from 'react';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';

/**
 * Early access: the shadow under the floating App Advisor panel. The panel
 * is a native view the main process places over this window's bottom-right
 * corner (`floatingAppAdvisorBounds`: the panel's size, 16px from the edges,
 * capped to the window), and a native view casts no shadow of its own, so
 * the window draws it at the same spot and size, behind the panel.
 */
export function AppAdvisorPanelShadow(): JSX.Element | null {
  const floating = useAppAdvisorStore((s) => s.open && s.layout === 'floating');
  const size = useAppAdvisorStore((s) => s.floatingSize);
  if (!floating) return null;
  return (
    <Surface
      aria-hidden="true"
      data-testid="app-advisor-panel-shadow"
      paneWidth={size.width}
      paneHeight={size.height}
      variant="advisor-shadow"
      extent="advisor-overlay"
      className="pointer-events-none fixed bottom-4 right-4 z-drawer max-w-[calc(100vw-32px)]"
    />
  );
}
