import { BILLING_TOP_UP_MIN_USD } from '@canopy/protocol/billing';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import { formatCredits } from '../lib/billing-format';

/**
 * Every word an AI Credits prompt says, in one place: the purchase, its
 * checkout hand-off, the recovery notices, the advanced-model unlock and the
 * usage-limit model switch. Desktop and web render the same strings, so each
 * path names the same step the same way.
 *
 * The product term is "AI Credits", capitalized, in labels and prose alike.
 * Every action that starts a purchase says {@link AI_CREDITS_PURCHASE_LABEL};
 * a guest's says {@link AI_CREDITS_GUEST_PURCHASE_LABEL}
 * (docs/ux-writing/labels.md#ai-credits-purchases).
 *
 * {@link creditsPromptCopy} keys the purchase action and default message by
 * the reason and audience `resolveCreditsPrompt` (`@canopy/app-state`)
 * returns. The named constants below are the table's parts, and stay exported
 * for hosts that compose a line themselves.
 *
 * Titles carry no full stop; `Notice` and the hosts that join a title and
 * message add it.
 */

// ---------------------------------------------------------------------------
// Purchase and checkout hand-off
// ---------------------------------------------------------------------------

/** The purchase action on every surface, and the checkout's title. */
export const AI_CREDITS_PURCHASE_LABEL = 'Buy AI Credits';

/**
 * CAN-4766 — the purchase action a guest sees. A guest can't buy before
 * signing in, so no guest action carries the bare purchase label.
 */
export const AI_CREDITS_GUEST_PURCHASE_LABEL = 'Sign in to buy AI Credits';

/** The re-read after checkout, on every surface. */
export const AI_CREDITS_CHECK_AGAIN_LABEL = 'Check again';

/** Reopens the browser checkout while a purchase is in progress. */
export const AI_CREDITS_REOPEN_BILLING_LABEL = 'Reopen billing';

/**
 * While checkout is open in the browser, and after a Check again that found
 * nothing (`uncovered`) or could not read the balance (`checkFailed`).
 */
export const AI_CREDITS_HANDOFF_COPY = {
  waiting: {
    title: 'Finish checkout in your browser',
    message: 'Your credits show up here once the payment goes through.',
  },
  uncovered: {
    title: 'No credits yet',
    message: "If you've paid, they can take a minute to arrive.",
  },
  checkFailed: {
    title: "Couldn't check your balance",
    message: 'Try again in a moment.',
  },
} as const;

/** One copy entry as a single sentence pair, for hosts without a title slot. */
export function aiCreditsHandoffSentence(entry: {
  readonly title: string;
  readonly message: string;
}): string {
  return `${entry.title}. ${entry.message}`;
}

/** Paid, but the credits haven't arrived yet (docs/ux-writing/sign-in.md). */
export const AI_CREDITS_PROCESSING_COPY =
  "Payment received. Your AI Credits are still processing. You won't be charged again.";

/**
 * What the transcript says where a message stopped because nothing could pay
 * for it. The composer's banner is where the user chooses how to pay, so the
 * transcript only explains the stop and offers no action of its own.
 */
export const AI_CREDITS_STOP_COPY =
  'Chat stopped. Choose how to pay for this message to keep going.';

// ---------------------------------------------------------------------------
// Recovery (CAN-4764): out of credits, held messages, dead ends
// ---------------------------------------------------------------------------

/** A recovery notice's state (the title) and what follows it on the line. */
export interface CreditsRecoveryCopy {
  readonly title: string;
  readonly message: string;
}

/**
 * Copy for an org member whose org carries the credit-pool capability but has no
 * spendable headroom right now. They cannot buy credits themselves, so every
 * banner shows this instead of a purchase CTA.
 */
export const CONTACT_ORG_ADMIN_COPY =
  'Contact your org admin to increase your spend quota.';

/** The title while a queued message waits on credits. */
export const MESSAGE_QUEUED_TITLE = 'Message queued';

/**
 * The message while a queued message waits on credits, for someone who can
 * buy (a guest signs in first). The notice's own button carries the purchase,
 * and not every host shows a Try again control, so the line names neither.
 */
export const QUEUED_MESSAGE_RETAINED_COPY =
  'Your queued message is saved, so try it again after you buy more.';

/** The same, for someone who can't buy: an admin funds the pool. */
const QUEUED_MESSAGE_SAVED_COPY = 'Your queued message is saved.';

/** Saved queue status while the account needs credits. */
export const CREDIT_HELD_MESSAGE_WARNING_COPY = QUEUED_MESSAGE_RETAINED_COPY;

/** The out-of-credits recovery notice's title. */
export const OUT_OF_CREDITS_TITLE = "You're out of AI Credits";

/**
 * What happened to the user's message, so they know nothing was lost. The
 * notice's purchase button carries the action, so the line doesn't repeat
 * it. `canBuy: false` (an org member whose admin funds the pool, or billing
 * off) only says the message is safe: no line tells someone to buy who can't.
 */
export function retainedMessageCopy(
  origin: 'composer' | 'queue' | 'create' | 'first',
  { canBuy = true }: { readonly canBuy?: boolean } = {},
): string {
  if (origin === 'queue') {
    return canBuy ? QUEUED_MESSAGE_RETAINED_COPY : QUEUED_MESSAGE_SAVED_COPY;
  }
  if (origin === 'first') {
    // A new cloud worktree held its first message until setup could pay.
    return canBuy
      ? 'Your first message is saved, so try it again after you buy more.'
      : 'Your first message is saved.';
  }
  if (origin === 'create') {
    return canBuy
      ? 'Nothing was sent, so try again after you buy more.'
      : 'Nothing was sent.';
  }
  return canBuy
    ? 'Your message is saved, so send it again after you buy more.'
    : 'Your message is saved.';
}

/**
 * CAN-4769 — web chat is paid-only, so the recovery notice and the signed-out
 * entry name the two ways to keep going: buy credits, or bring a Claude or
 * ChatGPT subscription to the desktop app. Split so the host renders "desktop
 * app" as a link. Pick the lead by what comes before it:
 * - `lead` names buying itself, where nothing else on screen does.
 * - `leadWithoutPurchase` follows a sentence or button that offers another
 *   way on (a purchase button, which already names buying, or the
 *   contact-admin sentence), so the line never tells someone who can't buy
 *   to.
 * - `leadAfterStatement` follows a plain statement, such as "Your message is
 *   saved." with nothing to buy, where "Or" would have nothing to pair with.
 */
export const PAID_ACCESS_ALTERNATIVE_COPY = {
  lead: 'Buy AI Credits, or use the ',
  leadWithoutPurchase: 'Or use the ',
  leadAfterStatement: 'You can also use the ',
  link: 'desktop app',
  tail: ' with your Claude or ChatGPT subscription.',
} as const;

/** The organization's model policy allows nothing the user can run. */
export const POLICY_ONLY_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No model available',
  message: `Your organization's model policy doesn't allow any model you can run right now, so ask your organization admin to allow a model you can use.`,
};

/** The organization only allows models paid for with AI Credits. */
export function creditsOnlyDeadEndCopy(appName: string): CreditsRecoveryCopy {
  return {
    title: 'AI Credits required',
    message: `Your organization only allows models that require ${appName} AI Credits.`,
  };
}

/** Every model the organization allows needs a billing source. */
export const POLICY_BILLING_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No model available',
  message: `Your organization's allowed models all need a billing source you don't have yet.`,
};

/** No available model can be paid for. */
export const DISPATCH_DEAD_END_COPY: CreditsRecoveryCopy = {
  title: 'No billing source',
  message: 'No available model can be paid for right now.',
};

/** A turn already failed because AI Credits didn't cover it. */
export function failedTurnCopy(appName: string): CreditsRecoveryCopy {
  return {
    title: 'Message not sent',
    message: `Your ${appName} AI Credits didn't cover that message.`,
  };
}

/**
 * CAN-4766 — the action that connects a provider account, on every recovery
 * surface that offers it. It names only the current model's provider.
 */
export function connectProviderLabel(providerLabel: string): string {
  return `Connect ${providerLabel}`;
}

/** Before sending: no provider connected and no AI Credits to fall back on. */
export function notSignedInCopy({
  appName,
  providerLabel,
}: {
  readonly appName: string;
  readonly providerLabel: string;
}): CreditsRecoveryCopy {
  return {
    title: `Not connected to ${providerLabel}`,
    message: `You have no ${appName} AI Credits to cover this chat either.`,
  };
}

/** An organization pool with nothing in it yet, for someone who can fund it. */
export function emptyCreditPoolCopy(brandName: string): CreditsRecoveryCopy {
  return {
    title: 'No AI Credits yet',
    message: `Buy AI Credits to let your team use ${brandName}'s AI features.`,
  };
}

// ---------------------------------------------------------------------------
// Advanced-model unlock
// ---------------------------------------------------------------------------

/** An access value that still locks advanced models. */
export type LockedModelLibraryAccess = Exclude<ModelLibraryAccess, 'unlocked'>;

/**
 * A locked model row's hint, by access value: the remedy, read as the row's
 * description and in its hover details. Sentence case with no full stop, like
 * the row's other text. The row's visible cue is the shorter
 * {@link MODEL_LIBRARY_UNLOCK_LABELS}.
 */
export const MODEL_LIBRARY_UNLOCK_HINTS: Readonly<
  Record<LockedModelLibraryAccess, string>
> = {
  needs_sign_in: 'Unlock by signing in',
  needs_sign_in_then_purchase: 'Unlock by signing in and buying AI Credits',
  needs_purchase: 'Unlock by buying AI Credits',
};

const PURCHASE_SCOPE_BODY = `Buy AI Credits (minimum $${BILLING_TOP_UP_MIN_USD}) to unlock Sonnet, Opus, Fable and more.`;

/**
 * Recovery copy. "Advanced models", never "every model": provider, policy, and
 * funding restrictions still apply after a purchase. Nothing here promises the
 * unlock is permanent, because a lost chargeback can revoke it.
 *
 * The purchase minimum comes from the checkout's own `BILLING_TOP_UP_MIN_USD`.
 * The model families named in `purchaseBody` are editorial and maintained by
 * hand, not generated from the catalog: review them when purchase eligibility
 * changes.
 */
export const MODEL_LIBRARY_UNLOCK_COPY = {
  title: 'Unlock advanced models',
  purchaseBody: `${PURCHASE_SCOPE_BODY} We'll switch to your selected model once the purchase is complete.`,
  // Billing links and proxy recovery can open checkout without a pending model.
  purchaseBodyWithoutSelection: PURCHASE_SCOPE_BODY,
  guestBody: 'Sign in, then buy AI Credits.',
  purchaseAction: AI_CREDITS_PURCHASE_LABEL,
  signInAction: 'Sign in',
  /** The row label when a purchase follows sign-in. */
  signInThenPurchaseLabel: AI_CREDITS_GUEST_PURCHASE_LABEL,
  dismissAction: 'Not now',
  confirmed: 'Advanced models are unlocked.',
  selectionFailed: 'Your model could not be selected. Try selecting it again.',
  retrySelection: 'Try again',
  waitingInBrowser: `${AI_CREDITS_HANDOFF_COPY.waiting.title}. We'll check when the payment goes through.`,
  pendingTitle: AI_CREDITS_HANDOFF_COPY.waiting.title,
  timedOutTitle: 'Automatic payment checks have stopped',
  timedOutBody: `Your purchase may still be in progress. ${AI_CREDITS_CHECK_AGAIN_LABEL} once it's complete.`,
  newPurchaseHelp: "Starting a new purchase won't cancel the previous one.",
  dismissHelp:
    "Dismissing this notice stops tracking this purchase. It won't cancel your purchase.",
  checkNowAction: AI_CREDITS_CHECK_AGAIN_LABEL,
  checkingAction: 'Checking…',
  newPurchaseAction: 'Start a new purchase',
  dismissPaymentAction: 'Dismiss payment notice',
  proxyRefusalTitle: 'This model needs an AI Credit purchase',
  proxyRefusalBody:
    'Buy AI Credits to unlock advanced models, then send your message again.',
  /**
   * The in-chat confirmation after a confirmed unlock (CAN-5027). The number
   * is the refreshed available balance, never the amount purchased or
   * charged; without a usable balance the notice says `confirmed` instead.
   */
  confirmedCredits: (credits: number): string =>
    `Your ${formatCredits(credits)} AI Credits are now available.`,
  /** Only while the chat's current model is the one the unlock was for. */
  confirmedModelSelected: (modelLabel: string): string =>
    `${modelLabel} is selected for this chat.`,
  dismissConfirmation: 'Dismiss unlock confirmation',
} as const;

/**
 * A locked model row's visible cue, by access value, in the trailing slot
 * where an unlocked row's `AI Credits` tag sits (docs/design/interaction.md,
 * Picker cues). Each names the action activating the row starts, in the
 * purchase labels' words (docs/ux-writing/labels.md#ai-credits-purchases),
 * so a locked row never reads like a usable one. The longer
 * {@link MODEL_LIBRARY_UNLOCK_HINTS} stay in the row's details: "Unlock by
 * buying AI Credits" would crowd the model name in the default 304px picker.
 */
export const MODEL_LIBRARY_UNLOCK_LABELS: Readonly<
  Record<LockedModelLibraryAccess, string>
> = {
  needs_sign_in: MODEL_LIBRARY_UNLOCK_COPY.signInAction,
  needs_sign_in_then_purchase:
    MODEL_LIBRARY_UNLOCK_COPY.signInThenPurchaseLabel,
  needs_purchase: MODEL_LIBRARY_UNLOCK_COPY.purchaseAction,
};

/**
 * The purchase dialog title: names the model being unlocked, or falls back to
 * the generic title when no display label is known.
 */
export function modelLibraryUnlockTitle(modelLabel?: string): string {
  const label = modelLabel?.trim();
  return label ? `Unlock ${label}` : MODEL_LIBRARY_UNLOCK_COPY.title;
}

/**
 * The recovery dialog's line while checkout is open in the browser. Says that
 * Close does not cancel, and names the model only when the host knows it; an
 * unknown model gets the generic unlock rather than a raw ID.
 */
export function modelLibraryWaitingInBrowserBody(modelLabel?: string): string {
  return modelLabel === undefined
    ? `${AI_CREDITS_HANDOFF_COPY.waiting.title}. Closing this dialog won't cancel your purchase. We'll unlock advanced models once the payment goes through.`
    : `${AI_CREDITS_HANDOFF_COPY.waiting.title}. Closing this dialog won't cancel your purchase. We'll switch to ${modelLabel} in the chat where you started the purchase once the payment goes through.`;
}

/** The composer notice's line while the purchase is pending. */
export function modelLibraryPendingBody(modelLabel?: string): string {
  return modelLabel === undefined
    ? "We'll unlock advanced models once the payment goes through."
    : `We'll switch to ${modelLabel} once the payment goes through.`;
}

// ---------------------------------------------------------------------------
// Usage limit: continue on a model that can run on AI Credits
// ---------------------------------------------------------------------------

/** The action that moves the chat onto the credits model. */
export function usageLimitModelSwitchActionLabel(
  targetModelLabel: string,
): string {
  return `Continue on ${targetModelLabel}`;
}

export interface UsageLimitModelSwitchMessageInput {
  /** The chat's current model, which can't run on AI Credits. */
  readonly modelLabel: string;
  /** The credits model to offer; omitted when it can't run on AI Credits either. */
  readonly targetModelLabel?: string;
  /** A preformatted balance, for example `1,234`. */
  readonly creditsLeft?: string;
  /** When the quota resets, for example `8:14 PM`. */
  readonly resetsLabel?: string;
  /** When a scheduled resume runs, for example `Tue 9:00 AM`. */
  readonly scheduledForLabel?: string;
}

function notRoutableSentence(modelLabel: string): string {
  return `${modelLabel} can't run on AI Credits.`;
}

function waitClause(resetsLabel: string | undefined): string {
  return resetsLabel
    ? `wait until ${resetsLabel}`
    : 'wait for your quota to reset';
}

/** The notice message when credits could continue the chat on another model. */
export function usageLimitModelSwitchMessage({
  modelLabel,
  targetModelLabel,
  creditsLeft,
  resetsLabel,
  scheduledForLabel,
}: UsageLimitModelSwitchMessageInput): string {
  const gate = notRoutableSentence(modelLabel);
  const credits = creditsLeft
    ? `with your AI Credits (${creditsLeft} left)`
    : 'with your AI Credits';
  if (scheduledForLabel) {
    const resumes = `This chat resumes automatically at ${scheduledForLabel}.`;
    const next = targetModelLabel
      ? `Continue on ${targetModelLabel} ${credits} to keep going now.`
      : 'Choose a model that can run on AI Credits to keep going now.';
    return `${resumes} ${gate} ${next}`;
  }
  const next = targetModelLabel
    ? `Continue on ${targetModelLabel} ${credits}, or ${waitClause(resetsLabel)}.`
    : `Choose a model that can, or ${waitClause(resetsLabel)}.`;
  return `${gate} ${next}`;
}

export interface UsageLimitModelSwitchPurchaseMessageInput {
  readonly modelLabel: string;
  readonly targetModelLabel?: string;
  readonly resetsLabel?: string;
  readonly scheduledForLabel?: string;
}

/** The notice message when the user has no AI Credits to continue with yet. */
export function usageLimitModelSwitchPurchaseMessage({
  modelLabel,
  targetModelLabel,
  resetsLabel,
  scheduledForLabel,
}: UsageLimitModelSwitchPurchaseMessageInput): string {
  const buy = targetModelLabel
    ? `Buy AI Credits to continue on ${targetModelLabel}`
    : 'Buy AI Credits and choose a model that can';
  if (scheduledForLabel) {
    const buyNow = targetModelLabel
      ? buy
      : 'Buy AI Credits and choose a model that can run on them';
    return `This chat resumes automatically at ${scheduledForLabel}. ${notRoutableSentence(modelLabel)} ${buyNow} to keep going now.`;
  }
  const wait = resetsLabel
    ? `wait for your quota to reset around ${resetsLabel}`
    : 'wait for your quota to reset';
  return `${notRoutableSentence(modelLabel)} ${buy}, or ${wait}.`;
}

export interface UsageLimitModelSwitchFailureDetailInput {
  readonly targetModelLabel: string;
  readonly resetsLabel?: string;
}

/** The detail line after the switch to the credits model failed. */
export function usageLimitModelSwitchFailureDetail({
  targetModelLabel,
  resetsLabel,
}: UsageLimitModelSwitchFailureDetailInput): string {
  const failed = `Couldn't switch to ${targetModelLabel}.`;
  return resetsLabel
    ? `${failed} Try again or wait until ${resetsLabel}.`
    : `${failed} Try again.`;
}

// ---------------------------------------------------------------------------
// The table: reason × audience
// ---------------------------------------------------------------------------

/**
 * Why a prompt asks about AI Credits. Mirrors `CreditsPromptReason` in
 * `@canopy/app-state`, which this display package can't import; a resolved
 * prompt's `reason` is assignable to it, so a new reason fails the hosts'
 * typecheck until it has copy here.
 */
export type CreditsCopyReason =
  | 'out_of_credits'
  | 'quota_limit'
  | 'no_billing_source'
  | 'model_locked'
  | 'queued_held'
  | 'top_up';

/** Who a prompt is for. Mirrors `CreditsPromptAudience` in `@canopy/app-state`. */
export type CreditsCopyAudience = 'buyer' | 'guest' | 'org-member' | 'unknown';

/** What one reason says to one audience. */
export interface CreditsPromptCopy {
  /**
   * The action that starts a purchase, or `null` when this audience can't
   * start one here. Shown only when the resolved prompt offers it.
   */
  readonly action: string | null;
  /**
   * The message when the host has none of its own. Absent where every host
   * writes its own line (a usage limit names its provider and reset).
   */
  readonly message?: string;
}

const BUYER: CreditsPromptCopy = { action: AI_CREDITS_PURCHASE_LABEL };
const GUEST: CreditsPromptCopy = { action: AI_CREDITS_GUEST_PURCHASE_LABEL };
/** The contact-admin line is the notice's own, beside any message. */
const ORG_MEMBER: CreditsPromptCopy = { action: null };

const CREDITS_PROMPT_COPY: Readonly<
  Record<
    CreditsCopyReason,
    Readonly<Record<CreditsCopyAudience, CreditsPromptCopy>>
  >
> = {
  out_of_credits: {
    buyer: BUYER,
    guest: GUEST,
    'org-member': ORG_MEMBER,
    unknown: BUYER,
  },
  quota_limit: {
    buyer: BUYER,
    guest: GUEST,
    'org-member': ORG_MEMBER,
    unknown: BUYER,
  },
  no_billing_source: {
    buyer: BUYER,
    guest: GUEST,
    'org-member': ORG_MEMBER,
    unknown: BUYER,
  },
  model_locked: {
    buyer: { ...BUYER, message: MODEL_LIBRARY_UNLOCK_COPY.purchaseBody },
    guest: { ...GUEST, message: MODEL_LIBRARY_UNLOCK_COPY.guestBody },
    // A personal purchase would not unlock the organization's work.
    'org-member': { action: null, message: CONTACT_ORG_ADMIN_COPY },
    unknown: { ...BUYER, message: MODEL_LIBRARY_UNLOCK_COPY.purchaseBody },
  },
  queued_held: {
    buyer: { ...BUYER, message: QUEUED_MESSAGE_RETAINED_COPY },
    guest: { ...GUEST, message: QUEUED_MESSAGE_RETAINED_COPY },
    'org-member': { action: null, message: QUEUED_MESSAGE_SAVED_COPY },
    unknown: { ...BUYER, message: QUEUED_MESSAGE_RETAINED_COPY },
  },
  top_up: {
    buyer: BUYER,
    guest: GUEST,
    'org-member': ORG_MEMBER,
    unknown: BUYER,
  },
};

/** What a prompt for `reason` says to `audience`; see the module comment. */
export function creditsPromptCopy(
  reason: CreditsCopyReason,
  audience: CreditsCopyAudience,
): CreditsPromptCopy {
  return CREDITS_PROMPT_COPY[reason][audience];
}
