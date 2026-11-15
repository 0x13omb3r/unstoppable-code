import { CORE_CHAT_MESSAGE_SEND_ACCOUNT_BOUND_REVISION } from '@canopy/protocol/canopy-core';
import {
  followWebCoreDescription,
  resetWebCoreDescription,
  webCoreAdvertises,
  webCoreDescription,
} from './web-core-description';

/**
 * A cloud send is bound to the account it was pressed under (CAN-6828): the
 * web core refuses it when its connection serves another account, so a
 * message pressed before an account switch never posts as the next account,
 * even into a project both accounts reach.
 *
 * The account is the one the web core's `core.runtime.initialize` named for
 * this window's connection, as the shared connection description reads it
 * through the relay's `describe` (CAN-6841), never put together here. A send
 * is bound only while that web core advertises the send revision that takes
 * the binding; against an older one, nothing is bound and callers keep their
 * own account checks.
 */

const SEND = 'core.chat.message.send';

const pressed = new Map<string, string>();

/** The described connection's account, when it can take the binding. */
function connectionPrincipal(): string | null {
  const principalId = webCoreDescription()?.principalId ?? null;
  // Never bound without both the account and the revision that takes it.
  return principalId !== null &&
    principalId !== '' &&
    webCoreAdvertises(SEND, CORE_CHAT_MESSAGE_SEND_ACCOUNT_BOUND_REVISION)
    ? principalId
    : null;
}

/** Follows the cloud connection; idempotent. */
export function followWebCoreSendBinding(): void {
  followWebCoreDescription();
}

/**
 * The account a cloud send pressed now is bound to, or undefined when the
 * web core can't take the binding (offline, not yet described, or an older
 * web core).
 */
export function pressedWebCorePrincipal(): string | undefined {
  return connectionPrincipal() ?? undefined;
}

/** Binds the message `messageId` sends as to `principalId`. The first binding stays. */
export function bindWebCoreSend(messageId: string, principalId: string): void {
  if (!pressed.has(messageId)) pressed.set(messageId, principalId);
}

/** The account the message `messageId` was pressed under, if it was bound. */
export function webCoreSendBinding(messageId: string): string | undefined {
  return pressed.get(messageId);
}

/** Forgets a message's binding once its send settled. */
export function releaseWebCoreSend(messageId: string): void {
  pressed.delete(messageId);
}

/** Test seam: drops the followed connection and every binding. */
export function resetWebCoreSendBinding(): void {
  resetWebCoreDescription();
  pressed.clear();
}

// Followed from the start, so a send pressed right after the cloud comes
// online is already bound.
followWebCoreSendBinding();
