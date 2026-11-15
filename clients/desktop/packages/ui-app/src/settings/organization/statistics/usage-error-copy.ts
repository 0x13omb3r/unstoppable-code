import type { KnownSettingsError } from '../../errors';

/** Logger scope for the organization Statistics page. */
export const STATISTICS_ERROR_SCOPE = 'settings.organization.statistics';

/**
 * Failures of the organization usage reads (Statistics, member profile usage,
 * plan pricing) that have their own copy: a 403 when the viewer's role is
 * below the organization's usage-stats setting.
 */
export const USAGE_KNOWN_LOAD_ERRORS: readonly KnownSettingsError[] = [
  {
    status: 403,
    copy: 'Usage statistics aren’t available to your role in this organization.',
  },
];
