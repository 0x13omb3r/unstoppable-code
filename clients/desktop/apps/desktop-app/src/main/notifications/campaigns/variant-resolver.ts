import type {
  ActivationCampaignId,
  CampaignSuppressionReason,
  ProfileRoleId,
} from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../../lib/preferences-store';
import { DEFAULT_VARIANT_KEY } from './campaign-config';

/**
 * Copy-variant resolution for activation campaigns (CAN-2438).
 *
 * A `null` key is a real outcome, not an error path: campaign 2 deliberately
 * has no neutral branch, so a user it cannot address is skipped rather than
 * sent generic copy. The accompanying reason keeps that distinguishable in the
 * funnel — "never answered the role question" and "answered with a role we do
 * not branch on" call for different product responses.
 */
export type VariantResolution =
  | { variantKey: string }
  | { variantKey: null; reason: CampaignSuppressionReason };

/**
 * Approved role mapping. `designer`, `founder`, `data-analytics`, `student`,
 * and `other` are deliberately absent: they map cleanly to neither branch, and
 * guessing would put the wrong pitch in front of them.
 */
const ROLE_VARIANTS: Partial<Record<ProfileRoleId, string>> = {
  'software-engineer': 'developer',
  'engineering-leader': 'developer',
  'product-manager': 'business',
  'marketing-sales': 'business',
  marketing: 'business',
  sales: 'business',
  operations: 'business',
  support: 'business',
  'operations-support': 'business',
};

async function resolveRoleVariant(): Promise<VariantResolution> {
  const preferences = await readPreferencesFile();
  const role = preferences.profileRole;
  if (role === undefined) {
    return { variantKey: null, reason: 'role-unknown' };
  }
  const variantKey = ROLE_VARIANTS[role];
  if (variantKey === undefined) {
    return { variantKey: null, reason: 'role-not-mapped' };
  }
  return { variantKey };
}

export async function resolveCampaignVariantKey(
  campaignId: ActivationCampaignId,
): Promise<VariantResolution> {
  try {
    switch (campaignId) {
      case 'activation-role-branch':
        return await resolveRoleVariant();
      // Campaign 1 used to offer a free-month trial; there are no trials, so
      // it always sends its default copy.
      case 'activation-first-task':
      case 'activation-marketplace':
      case 'activation-mobile':
        return { variantKey: DEFAULT_VARIANT_KEY };
    }
  } catch {
    // Never let a resolver failure become a send with the wrong copy.
    return { variantKey: null, reason: 'variant-unavailable' };
  }
}
