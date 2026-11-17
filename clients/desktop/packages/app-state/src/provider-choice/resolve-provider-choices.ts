import {
  resolveCreditsPrompt,
  type CreditsPrompt,
  type CreditsPromptAction,
} from '../billing/credits/resolve-credits-prompt';
import {
  PROVIDER_SOURCE_ORDER,
  type AnyProviderSourceFacts,
  type CreditsSourceFacts,
  type ProviderChoiceAction,
  type ProviderChoiceInput,
  type ProviderChoiceModel,
  type ProviderChoiceOutcome,
  type ProviderChoicePrimary,
  type ProviderChoiceRow,
  type ProviderChoices,
  type ProviderChoiceTarget,
  type ProviderConnection,
  type ProviderSourceFacts,
} from './types';

const READY: ProviderConnection = { kind: 'ready' };
const NOT_CONNECTED: ProviderConnection = { kind: 'not-connected' };

/**
 * What choosing a source does to the chat's model, before its connection is
 * considered. Unsupported and blocked sources are unavailable whatever the
 * model; otherwise the source runs the target's model, offers its default
 * (`continue-chat` only), or cannot help.
 */
function modelOutcome<TModel extends ProviderChoiceModel>(
  facts: AnyProviderSourceFacts<TModel>,
  target: ProviderChoiceTarget<TModel>,
): ProviderChoiceOutcome<TModel> {
  if (facts.unsupported !== undefined) {
    return { kind: 'unavailable', reason: facts.unsupported };
  }
  if (facts.blockedReason !== undefined) {
    return {
      kind: 'unavailable',
      reason: 'blocked',
      detail: facts.blockedReason,
    };
  }
  if (facts.runsTargetModel) return { kind: 'same-model' };
  if (target.kind === 'run-model') {
    return { kind: 'unavailable', reason: 'model-not-offered' };
  }
  // Never a switch to an empty target: no default means nothing to offer.
  return facts.defaultModel !== undefined
    ? { kind: 'switch-model', target: facts.defaultModel }
    : { kind: 'unavailable', reason: 'no-runnable-model' };
}

/**
 * The current row's outcome: it already bills the chat, so only a
 * `run-model` pick for a model it does not offer changes anything.
 */
function currentOutcome<TModel extends ProviderChoiceModel>(
  facts: AnyProviderSourceFacts<TModel>,
  target: ProviderChoiceTarget<TModel>,
): ProviderChoiceOutcome<TModel> {
  return target.kind === 'run-model' && !facts.runsTargetModel
    ? { kind: 'unavailable', reason: 'model-not-offered' }
    : { kind: 'same-model' };
}

function accountRow<TModel extends ProviderChoiceModel>(
  facts: ProviderSourceFacts<TModel>,
  target: ProviderChoiceTarget<TModel>,
  isCurrent: boolean,
): ProviderChoiceRow<TModel> {
  const { connection } = facts;
  if (isCurrent) {
    // The current row stays listed for its status line and offers nothing.
    return {
      source: facts.source,
      isCurrent,
      connection,
      outcome: currentOutcome(facts, target),
      action: 'none',
    };
  }
  const outcome = modelOutcome(facts, target);
  // A gateway lists its models only once set up, so before that "no runnable
  // model" still offers Set up, the step that would find one. Subscription
  // rows know their default without signing in, so signing in would not
  // find one: they keep "no runnable model".
  const notConnectedYet =
    facts.source === 'gateway' &&
    connection.kind === 'not-connected' &&
    facts.connectable &&
    outcome.kind === 'unavailable' &&
    outcome.reason === 'no-runnable-model';
  if (outcome.kind === 'unavailable' && !notConnectedYet) {
    return {
      source: facts.source,
      isCurrent,
      connection,
      outcome,
      action: 'none',
    };
  }
  switch (connection.kind) {
    case 'ready':
      return {
        source: facts.source,
        isCurrent,
        connection,
        outcome,
        action: 'use',
      };
    case 'limited':
      return {
        source: facts.source,
        isCurrent,
        connection,
        outcome: {
          kind: 'unavailable',
          reason: 'limited',
          resetsAt: connection.resetsAt,
        },
        action: 'none',
      };
    case 'not-connected': {
      const connectAction: ProviderChoiceAction =
        facts.source === 'gateway' ? 'set-up' : 'connect';
      return {
        source: facts.source,
        isCurrent,
        connection,
        outcome,
        action: facts.connectable ? connectAction : 'none',
      };
    }
    case 'checking':
      return {
        source: facts.source,
        isCurrent,
        connection,
        outcome,
        action: 'none',
      };
  }
}

function creditsAction(prompt: CreditsPrompt): ProviderChoiceAction {
  const map: Record<CreditsPromptAction, ProviderChoiceAction> = {
    buy: 'buy',
    'sign-in': 'sign-in-to-buy',
    'check-again': 'check-again',
    'contact-admin': 'ask-admin',
    'reopen-billing': 'none',
    'retry-queued': 'none',
    none: 'none',
  };
  return map[prompt.primary];
}

function creditsRow<TModel extends ProviderChoiceModel>(
  facts: CreditsSourceFacts<TModel>,
  input: ProviderChoiceInput<TModel>,
  isCurrent: boolean,
): ProviderChoiceRow<TModel> {
  const spendable = facts.balance === 'spendable';
  const connection = spendable ? READY : NOT_CONNECTED;
  // The purchase decision is resolveCreditsPrompt's, unchanged: guest,
  // buyer, organization member and pending rules live there alone.
  const creditsPrompt = resolveCreditsPrompt({
    billingEnabled: facts.billingEnabled,
    viewer: facts.viewer,
    owner: facts.owner,
    purchaseMode: facts.purchaseMode,
    pending: facts.pending,
    ...(facts.pendingFeedback !== undefined
      ? { pendingFeedback: facts.pendingFeedback }
      : {}),
    ...(facts.purchaseOnUnknownOwner !== undefined
      ? { purchaseOnUnknownOwner: facts.purchaseOnUnknownOwner }
      : {}),
    condition: input.condition,
  });
  const outcome: ProviderChoiceOutcome<TModel> = isCurrent
    ? currentOutcome(facts, input.target)
    : modelOutcome(facts, input.target);
  if (isCurrent && spendable) {
    return {
      source: 'credits',
      isCurrent,
      connection,
      outcome,
      action: 'none',
      creditsPrompt,
    };
  }
  // The current source with an empty balance still offers its purchase:
  // buying is how this chat keeps going on the same model.
  if (outcome.kind === 'unavailable') {
    return {
      source: 'credits',
      isCurrent,
      connection,
      outcome,
      action: 'none',
      creditsPrompt,
    };
  }
  return {
    source: 'credits',
    isCurrent,
    connection,
    outcome,
    action: spendable ? 'use' : creditsAction(creditsPrompt),
    creditsPrompt,
  };
}

function isConnected(row: ProviderChoiceRow<ProviderChoiceModel>): boolean {
  return row.connection.kind === 'ready' || row.connection.kind === 'limited';
}

function isUsableNow(row: ProviderChoiceRow<ProviderChoiceModel>): boolean {
  return (
    !row.isCurrent &&
    row.action === 'use' &&
    (row.outcome.kind === 'same-model' || row.outcome.kind === 'switch-model')
  );
}

/**
 * The one decision every provider-choice surface makes: which sources a chat
 * can move to, what each does to its model, which action each row offers,
 * and the single button a recovery notice shows. Pure; each host supplies
 * the facts it already reads and renders the rows in its own placement.
 *
 * - Rows: one per source with facts. Connected rows first, then
 *   {@link PROVIDER_SOURCE_ORDER}. Credits is never pinned or emphasized.
 * - The `current` row stays listed (for "Limit reached, resets at …") with
 *   action `none`.
 * - A gateway that isn't set up yet, so has no known model, still offers
 *   Set up.
 * - Credits: a spendable balance is `use`; otherwise the action is
 *   `resolveCreditsPrompt`'s (buy, sign in to buy, check again, ask an admin).
 * - Primary, `continue-chat` only: "Continue with X" when exactly one row
 *   other than `current` can be used now, on its model or its default.
 *   Rows that need connecting, setting up or buying never count, and a
 *   `checking` row never counts, so the label can settle from Switch to
 *   Continue once but not back after a click. Otherwise Switch provider, or
 *   Choose provider when the chat has no current source. `run-model`
 *   entry points always open the list (Choose provider).
 */
export function resolveProviderChoices<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
>(input: ProviderChoiceInput<TModel>): ProviderChoices<TModel> {
  const rows = input.sources.map((facts) => {
    const isCurrent = facts.source === input.current;
    return facts.source === 'credits'
      ? creditsRow(facts, input, isCurrent)
      : accountRow(facts, input.target, isCurrent);
  });
  const orderIndex = (row: ProviderChoiceRow<TModel>): number =>
    PROVIDER_SOURCE_ORDER.indexOf(row.source);
  const ordered = [...rows].sort((a, b) => {
    const connected = Number(isConnected(b)) - Number(isConnected(a));
    return connected !== 0 ? connected : orderIndex(a) - orderIndex(b);
  });

  let primary: ProviderChoicePrimary;
  if (input.target.kind === 'run-model') {
    primary = { kind: 'choose-provider' };
  } else {
    const usable = ordered.filter(isUsableNow);
    const [only] = usable;
    if (usable.length === 1 && only !== undefined) {
      primary = { kind: 'continue-with', source: only.source };
    } else {
      primary =
        input.current === null
          ? { kind: 'choose-provider' }
          : { kind: 'switch-provider' };
    }
  }
  return { rows: ordered, primary };
}
