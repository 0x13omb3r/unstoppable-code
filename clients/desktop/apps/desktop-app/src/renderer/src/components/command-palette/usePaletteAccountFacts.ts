import { useEffect, useState } from 'react';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { normalizePersonalOrganizationId } from '@canopy/protocol/workspace-context';

/** Account facts the palette's Settings entries name and gate on. */
export interface PaletteAccountFacts {
  /** The signed-in account's personal organization; `null` for a guest. */
  readonly personalOrganizationId: string | null;
}

const NO_ACCOUNT_FACTS: PaletteAccountFacts = {
  personalOrganizationId: null,
};

/**
 * Reads the cloud account once per palette open, and only while `enabled`
 * (hosted settings are openable), so a palette without account and
 * organization entries makes no extra reads. An unreadable account leaves
 * the defaults: no Personal pages.
 */
export function usePaletteAccountFacts(enabled: boolean): PaletteAccountFacts {
  const [facts, setFacts] = useState<PaletteAccountFacts>(NO_ACCOUNT_FACTS);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.api
      .loadCanopyCloudAccount()
      .then((account) => {
        if (cancelled) return;
        setFacts({
          personalOrganizationId: isGuestAccount(account)
            ? null
            : normalizePersonalOrganizationId(account.personalOrganizationId),
        });
      })
      .catch(() => {
        // Keep the defaults; the palette still lists every other entry.
      });
    return (): void => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? facts : NO_ACCOUNT_FACTS;
}
