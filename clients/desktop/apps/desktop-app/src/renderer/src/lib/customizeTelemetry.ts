import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import type { DesktopOperationName } from '@canopy/desktop-instrumentation';
import {
  CUSTOMIZE_DUPLICATE_RESULTS_EVENT,
  CUSTOMIZE_INSTALL_END_EVENT,
  CUSTOMIZE_INSTALL_START_EVENT,
  CUSTOMIZE_INTEGRATION_CLICK_EVENT,
  CUSTOMIZE_SEARCH_EVENT,
  setCustomizeTelemetrySink,
  type CustomizeTelemetryEvent,
} from '@canopy/ui-app/capability';

/**
 * Desktop transport for the shared Customize analytics (CAN-6806): each event
 * becomes one PostHog operation. The payload is already bounded by the shared
 * builders; `DESKTOP_OPERATIONS` keeps only its approved keys.
 */
function operationOf(event: CustomizeTelemetryEvent): DesktopOperationName {
  switch (event.name) {
    case CUSTOMIZE_SEARCH_EVENT:
      return 'canopy.customize_search';
    case CUSTOMIZE_DUPLICATE_RESULTS_EVENT:
      return 'canopy.customize_duplicate_results';
    case CUSTOMIZE_INTEGRATION_CLICK_EVENT:
      return 'canopy.customize_integration_click';
    case CUSTOMIZE_INSTALL_START_EVENT:
      return 'canopy.customize_install_start';
    case CUSTOMIZE_INSTALL_END_EVENT:
      return 'canopy.customize_install_end';
  }
}

export function reportDesktopCustomizeEvent(
  event: CustomizeTelemetryEvent,
): void {
  const name = operationOf(event);
  const context = { ...event.properties };
  startClientOperation(name, { context });
  succeedClientOperation(name, { context });
}

let installed = false;

/** Idempotent; called by the modules that render Customize. */
export function installDesktopCustomizeTelemetry(): void {
  if (installed) return;
  installed = true;
  setCustomizeTelemetrySink(reportDesktopCustomizeEvent);
}
