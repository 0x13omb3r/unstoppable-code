import type { CanopyClient, CreditsHandoffClient } from '@canopy/app-core';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';

let registeredClient: CanopyClient | null = null;

/**
 * Records the renderer's `CanopyClient` for hosted account and organization
 * settings (CAN-4386). `ipc-canopy-client.ts` registers its singleton when it
 * loads, so Settings surfaces and the AI Credits purchase flows can reach
 * the IPC settings client and payment hand-off without importing the whole
 * client module graph.
 */
export function registerHostedSettingsCanopyClient(client: CanopyClient): void {
  registeredClient = client;
}

/**
 * The registered client's settings client when it reports the
 * `accountOrganizationSettings` capability, else `null`.
 */
export function registeredHostedSettingsClient(): AccountOrganizationSettingsClient | null {
  if (registeredClient?.capabilities.accountOrganizationSettings !== true)
    return null;
  return registeredClient.settings ?? null;
}

/**
 * The registered client's AI Credits hand-off, else `null`. Purchase flows
 * outside React (`openBillingPage`) open the payment hand-off through it.
 */
export function registeredCreditsHandoffClient(): CreditsHandoffClient | null {
  return registeredClient?.creditsHandoff ?? null;
}
