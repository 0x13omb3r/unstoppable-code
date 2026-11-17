import type { ProviderChoicePrimary } from '@canopy/app-state/provider-choice';
import {
  CHOOSE_PROVIDER_LABEL,
  SWITCH_PROVIDER_LABEL,
  continueWithLabel,
} from '@canopy/ui-shared/components';

/**
 * The recovery notice button's label for a resolved primary: "Continue with
 * {provider}", "Switch provider" or "Choose provider". `providerName` names
 * the `continue-with` source; the credits source reads "credits" whatever
 * name is passed.
 */
export function providerChoicePrimaryLabel(
  primary: ProviderChoicePrimary,
  providerName: string,
): string {
  switch (primary.kind) {
    case 'continue-with':
      return continueWithLabel(primary.source, providerName);
    case 'switch-provider':
      return SWITCH_PROVIDER_LABEL;
    case 'choose-provider':
      return CHOOSE_PROVIDER_LABEL;
  }
}
