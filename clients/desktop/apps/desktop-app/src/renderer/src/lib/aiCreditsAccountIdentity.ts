import type {
  CreditsAccountIdentity,
  CreditsAccountIdentityReader,
} from '@canopy/app-state/billing/credits';
import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';

/** What a saved-account read says about who is buying. */
export function creditsAccountIdentity(
  account: CanopyCloudAccountPublicState,
): CreditsAccountIdentity {
  if (account.read !== undefined && account.read !== 'ok') {
    return { kind: 'unreadable' };
  }
  const key = cloudAccountIdentityKey(account);
  return key === null ? { kind: 'signed-out' } : { kind: 'account', key };
}

/**
 * The AI Credits purchase state's account port, over the cloud account
 * bridge. Looked up at each use; `null` when this build cannot read the
 * account. Not `async`: a synchronous bridge throw reaches the caller, which
 * decides whether it is a failed read.
 */
export function desktopCreditsAccountIdentityReader(): CreditsAccountIdentityReader | null {
  const loadAccount = window.api?.loadCanopyCloudAccount;
  if (typeof loadAccount !== 'function') return null;
  return (): Promise<CreditsAccountIdentity> =>
    loadAccount().then(creditsAccountIdentity);
}
