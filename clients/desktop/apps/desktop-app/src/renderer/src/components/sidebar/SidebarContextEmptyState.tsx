import type { JSX } from 'react';
import { OrgContextEmptyState } from '@canopy/ui-app';

/**
 * The desktop host of the shared empty organization sidebar (CAN-3537): the
 * presentation is `OrgContextEmptyState` from `@canopy/ui-app`, the same one
 * the web portal renders. Adding a project is the Projects header's "+", and
 * switching to Personal is the footer context picker's job, not this row's
 * (CAN-3550).
 */
export function SidebarContextEmptyState(): JSX.Element {
  return <OrgContextEmptyState />;
}
