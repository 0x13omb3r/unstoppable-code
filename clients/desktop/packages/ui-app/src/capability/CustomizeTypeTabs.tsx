'use client';

import type { JSX } from 'react';
import {
  Count,
  Divider,
  MarketplaceTypeTabs,
  RailIconButton,
  type MarketplaceTypeTabsProps,
} from '@canopy/ui-shared/components';
import { ShareIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  useCustomizeDiscoveryEnabled,
  useCustomizeSharedWithMe,
} from './CustomizeDiscoveryProvider';

const SHARED_TEST_ID = 'customize-shared-with-me';

/**
 * Shared with me (CAN-6810): toggles the list to items others shared with the
 * viewer. The counter shows shares since the viewer last opened it.
 */
function CustomizeSharedWithMeButton(): JSX.Element {
  const { active, setActive, newCount } = useCustomizeSharedWithMe();
  const name =
    newCount > 0 ? `Shared with me: ${String(newCount)} new` : 'Shared with me';
  return (
    <div className="relative shrink-0">
      <RailIconButton
        icon={ShareIcon}
        size="row"
        tone={active ? 'secondary' : 'neutral'}
        aria-label={name}
        aria-pressed={active}
        title="Shared with me"
        data-testid={SHARED_TEST_ID}
        data-active={active ? 'true' : 'false'}
        onClick={(): void => setActive((current) => !current)}
      />
      {newCount > 0 && (
        <Count
          value={newCount}
          placement="icon"
          tone="unread"
          aria-hidden
          data-testid={`${SHARED_TEST_ID}-count`}
          className="pointer-events-none absolute -right-1 -top-1"
        />
      )}
    </div>
  );
}

/**
 * Customize's type tabs, shared by desktop and web. While New Customize (the
 * `customize-discovery` Labs experiment) is on, Shared with me sits at the
 * right end of the row; off, this is exactly `MarketplaceTypeTabs`.
 */
export function CustomizeTypeTabs({
  className,
  ...props
}: MarketplaceTypeTabsProps): JSX.Element {
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  if (!discoveryEnabled || props.value === 'sources')
    return <MarketplaceTypeTabs {...props} className={className} />;
  // The button has its own column, so the tabs scroll in the space left and
  // never run under it; a divider under the button continues the row's line.
  return (
    <div
      data-testid="customize-type-tabs-row"
      className={`flex min-w-0 items-stretch${className ? ` ${className}` : ''}`}
    >
      <MarketplaceTypeTabs {...props} className="min-w-0 flex-1" />
      <div className="flex shrink-0 flex-col justify-between">
        <div className="pl-4">
          <CustomizeSharedWithMeButton />
        </div>
        <Divider aria-hidden />
      </div>
    </div>
  );
}
