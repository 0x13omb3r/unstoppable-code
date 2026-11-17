// Moving a chat onto the default credits model from the provider list's
// credits row (CAN-4900, CAN-6860).
//
// A chat on a model with no gateway route cannot bill to AI Credits, so the
// credits row offers to move it onto the default credits model instead. The
// model switch must land before routing is saved: routing is never written
// against a model that can't carry it, and a rejected switch leaves routing
// untouched.

import type { ChatModel } from '@canopy/desktop-shared/types';

export interface CreditsModelSwitchTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export type CreditsModelSwitchResult = 'switched' | 'switch-failed';

export interface ContinueOnCreditsModelDeps {
  target: CreditsModelSwitchTarget;
  creditsModel: ChatModel;
  /** Resolves true when the store accepted the model for `target`. */
  setModelAndWait: (
    model: ChatModel,
    target: CreditsModelSwitchTarget,
  ) => Promise<boolean>;
  /** Starts session-scoped AI Credits routing; false when nothing was saved. */
  enableSessionCreditsRouting: (target: CreditsModelSwitchTarget) => boolean;
}

export async function continueOnCreditsModel(
  deps: ContinueOnCreditsModelDeps,
): Promise<CreditsModelSwitchResult> {
  const { target, creditsModel, setModelAndWait, enableSessionCreditsRouting } =
    deps;
  let accepted: boolean;
  try {
    // No harness or billing framework: the ordinary model change resolves the
    // harness, and the routing written below decides billing.
    accepted = await setModelAndWait(creditsModel, target);
  } catch {
    return 'switch-failed';
  }
  if (!accepted) {
    return 'switch-failed';
  }
  return enableSessionCreditsRouting(target) ? 'switched' : 'switch-failed';
}
