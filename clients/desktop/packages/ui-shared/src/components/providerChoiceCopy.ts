import {
  AI_CREDITS_CHECK_AGAIN_LABEL,
  AI_CREDITS_GUEST_PURCHASE_LABEL,
  AI_CREDITS_PURCHASE_LABEL,
  CONTACT_ORG_ADMIN_COPY,
} from './creditsPromptCopy';

/**
 * Every word the provider-choice surfaces say: the recovery notices' single
 * button, the Switch provider dialog and its rows, and the locked-model
 * hints. Credits are one provider among peers, so nothing here sells; the
 * only purchase action is the credits row's, in the purchase labels' words
 * (docs/ux-writing/labels.md#ai-credits-purchases).
 */

/**
 * The sources a chat can bill a turn to. Mirrors `ProviderSourceId` in
 * `@canopy/app-state/provider-choice`, which this display package can't
 * import; keep the two in step.
 */
export type ProviderChoiceSourceKey =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'gateway'
  | 'credits';

/**
 * Mirrors `ProviderChoiceAction` in `@canopy/app-state/provider-choice`. A
 * resolved row's `action` is assignable to it.
 */
export type ProviderChoiceActionKey =
  | 'use'
  | 'connect'
  | 'set-up'
  | 'buy'
  | 'sign-in-to-buy'
  | 'check-again'
  | 'ask-admin'
  | 'none';

/** The notice button when the chat has a current source. */
export const SWITCH_PROVIDER_LABEL = 'Switch provider';

/** The notice button when the chat has none, and every locked-model entry. */
export const CHOOSE_PROVIDER_LABEL = 'Choose provider';

/**
 * The notice's menu button when one other source is usable now. Its menu
 * offers "Continue with {provider}" and Choose provider, since a source that
 * still needs connecting or buying may be the one the user wants.
 */
export const CONTINUE_MENU_LABEL = 'Continue';

/** The Switch provider dialog's title, naming the model in `run-model` mode. */
export function switchProviderDialogTitle(modelLabel?: string): string {
  const label = modelLabel?.trim();
  return label ? `Choose a provider for ${label}` : 'Choose a provider';
}

/**
 * The notice button when exactly one other source can keep the chat going.
 * The credits source reads "credits"; the credits row itself keeps the brand
 * app name the host passes.
 */
export function continueWithLabel(
  source: ProviderChoiceSourceKey,
  providerName: string,
): string {
  return source === 'credits'
    ? 'Continue with credits'
    : `Continue with ${providerName}`;
}

/**
 * The Switch provider dialog's error when choosing a row didn't move the
 * chat (a refused model change, or routing that couldn't be saved). The
 * credits source reads "credits", as in {@link continueWithLabel}.
 */
export function providerSwitchFailedMessage(
  source: ProviderChoiceSourceKey,
  providerName: string,
): string {
  const name = source === 'credits' ? 'credits' : providerName;
  return `Couldn't switch to ${name}. Try again.`;
}

/** The usage-limit notice's Resume action. */
export function resumeAtLabel(timeLabel?: string): string {
  return timeLabel ? `Resume at ${timeLabel}` : 'Resume at reset';
}

/** The usage-limit notice's message. */
export function usageLimitMessage(resetsLabel?: string): string {
  return resetsLabel
    ? `Your limit resets at ${resetsLabel}. You can wait, or keep going with another provider.`
    : 'You can wait for your limit to reset, or keep going with another provider.';
}

/** A row's status and detail lines. */
export const PROVIDER_CHOICE_ROW_COPY = {
  /** The current row's badge, after its name. */
  current: 'Current',
  ready: 'Ready',
  checking: 'Checking…',
  notConnected: 'Not connected',
  limited: (resetsLabel?: string): string =>
    resetsLabel ? `Limit reached, resets at ${resetsLabel}` : 'Limit reached',
  continuesOn: (modelLabel: string): string => `Continues on ${modelLabel}`,
  modelNotOffered: (modelLabel: string): string =>
    `Doesn't offer ${modelLabel}`,
  desktopOnly: 'Available in the desktop app',
  crossHarness: 'Not available for this chat yet',
  policy: 'Turned off by your organization',
  noRunnableModel: 'No model available',
  askAdmin: CONTACT_ORG_ADMIN_COPY,
} as const;

/** The label of each row action that is a plain button. */
export const PROVIDER_CHOICE_ACTION_LABELS: Readonly<
  Record<Exclude<ProviderChoiceActionKey, 'ask-admin' | 'none'>, string>
> = {
  use: 'Use',
  connect: 'Connect',
  'set-up': 'Set up',
  buy: AI_CREDITS_PURCHASE_LABEL,
  'sign-in-to-buy': AI_CREDITS_GUEST_PURCHASE_LABEL,
  'check-again': AI_CREDITS_CHECK_AGAIN_LABEL,
};

/** The AI gateway row's name before a gateway is set up. */
export const GATEWAY_ROW_NAME = 'AI gateway';

/** The AI gateway row's description before a gateway is set up. */
export const GATEWAY_ROW_DESCRIPTION =
  'Use your own gateway, such as OpenRouter or LiteLLM.';

/** The credits row's description; the row itself carries the brand name. */
export const CREDITS_ROW_DESCRIPTION = 'Pay as you go with credits.';

/** How a locked-model hint names each source that can run the model. */
const RUNS_ON_NAMES: Readonly<Record<ProviderChoiceSourceKey, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  gateway: 'your AI gateway',
  credits: 'credits',
};

/**
 * A locked model's hint, naming what can run it: "Runs on credits or your
 * AI gateway". Empty input reads as credits, the one source every locked
 * library model runs on.
 */
export function runsOnHint(
  sources: readonly ProviderChoiceSourceKey[],
): string {
  const names = (sources.length > 0 ? sources : ['credits' as const]).map(
    (source) => RUNS_ON_NAMES[source],
  );
  if (names.length === 1) return `Runs on ${names[0]}`;
  const head = names.slice(0, -1).join(', ');
  return `Runs on ${head} or ${names[names.length - 1]}`;
}

/**
 * A signed-out provider row's description: what connecting gets the user.
 * The credits row's description is the host's, since it names the brand.
 */
export const PROVIDER_ROW_DESCRIPTIONS: Readonly<
  Record<Exclude<ProviderChoiceSourceKey, 'credits'>, string>
> = {
  claude: 'Use your existing Claude subscription.',
  codex: 'Use your existing ChatGPT subscription.',
  cursor: 'Use your existing Cursor subscription.',
  copilot: 'Use your existing GitHub Copilot subscription.',
  gateway: 'Use your own AI gateway and its models.',
};
