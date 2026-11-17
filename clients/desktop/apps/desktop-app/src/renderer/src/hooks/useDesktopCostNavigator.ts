import type { CostNavigator } from '@canopy/app-core';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { desktopCostNavigatorFor } from '@/lib/cost/cost-navigator';
import { useScopeCapabilities } from './useScopeCapabilities';

/**
 * The cost navigator for `scope`: one that opens a chat's Session breakdown
 * only when the scope serves it (CAN-6941), so a cloud chat's cost rows never
 * offer a breakdown that can't load.
 */
export function useDesktopCostNavigator(scope: CostScopeRef): CostNavigator {
  return desktopCostNavigatorFor(
    useScopeCapabilities({ projectId: scope.projectId }),
  );
}
