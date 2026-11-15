import { useChatDetailPreference } from '@/stores/chatDetailStore';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { CustomizeDiscoveryProvider } from '@canopy/ui-app/customize-discovery';
import { CUSTOMIZE_DISCOVERY_EXPERIMENT } from '@canopy/protocol/experiments';
import { brand } from '@/lib/brand';
import {
  StandardPresentationProvider,
  ChatAppNameProvider,
  ChatDetailProvider,
  ContextMenuPlacementProvider,
  IconStyleProvider,
  LoadingIndicatorStyleProvider,
  HostTooltipProvider,
} from '@canopy/ui-shared/components';
import { PanelTabLiveReorderContext } from '@canopy/ui-shared/components/panels/panel-tab-live-reorder-context';
import { usePanelTabLiveReorder } from '@canopy/ui-shared/components/panels/use-panel-tab-live-reorder';
import type { JSX, ReactNode } from 'react';

/** Standard presentation for every desktop window; chat detail follows Appearance. */
export function EarlyAccessUiProviders({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const chatDetail = useChatDetailPreference();
  // New Customize (CAN-6809): main's resolved Labs verdict, off until ready.
  const customizeDiscovery = useLabsExperimentEnabled(
    CUSTOMIZE_DISCOVERY_EXPERIMENT.id,
  );

  return (
    <PanelTabLiveReorderContext.Provider value={usePanelTabLiveReorder}>
      <StandardPresentationProvider>
        <ContextMenuPlacementProvider value="cursor">
          <HostTooltipProvider stacking={'single'}>
            <LoadingIndicatorStyleProvider value={'spinner'}>
              <IconStyleProvider value={'central'}>
                <ChatDetailProvider value={chatDetail}>
                  <ChatAppNameProvider value={brand.displayName}>
                    <CustomizeDiscoveryProvider enabled={customizeDiscovery}>
                      {children}
                    </CustomizeDiscoveryProvider>
                  </ChatAppNameProvider>
                </ChatDetailProvider>
              </IconStyleProvider>
            </LoadingIndicatorStyleProvider>
          </HostTooltipProvider>
        </ContextMenuPlacementProvider>
      </StandardPresentationProvider>
    </PanelTabLiveReorderContext.Provider>
  );
}
