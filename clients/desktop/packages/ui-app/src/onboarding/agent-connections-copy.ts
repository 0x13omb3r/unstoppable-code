import { PROVIDER_ROW_DESCRIPTIONS as SHARED_PROVIDER_ROW_DESCRIPTIONS } from '@canopy/ui-shared/components';

/**
 * Copy for the agent connections on the first-run "Let's get started" page:
 * the intro above Claude, Codex and the account row, and each provider row's
 * signed-out description. The host passes its brand's app name.
 */
export function agentConnectionsIntro({
  appName,
}: {
  readonly appName: string;
}): string {
  return `Bring your own subscription or use your ${appName} account.`;
}

/**
 * A signed-out provider row's description. It says what connecting gets the
 * user, since the row's status dot already shows that it is not connected.
 * The provider-choice list shares the same words.
 */
export const PROVIDER_ROW_DESCRIPTIONS = SHARED_PROVIDER_ROW_DESCRIPTIONS;
