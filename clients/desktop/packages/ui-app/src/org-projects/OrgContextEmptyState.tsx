'use client';

// ---------------------------------------------------------------------------
// The empty organization sidebar (CAN-2954, CAN-3386), rendered by both the
// desktop sidebar and the web portal's (CAN-3537).
//
// An empty Projects list is one `None found` row under the Projects header,
// the same row an empty Chats section lists (CAN-3550). The sidebar lists only
// set-up projects, so an empty list does not mean the organization has none:
// the Projects header's "+" stays on screen while the list is empty and opens
// the host's Add project dialog.
// ---------------------------------------------------------------------------

import type { JSX } from 'react';
import { SidebarNoneFoundRow } from '../code/shell/sidebar';

export function OrgContextEmptyState(): JSX.Element {
  return (
    <div data-testid="sidebar-context-empty-state">
      <SidebarNoneFoundRow labelTestId="sidebar-context-empty-state-label" />
    </div>
  );
}
