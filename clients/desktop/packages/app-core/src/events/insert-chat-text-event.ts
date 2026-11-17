/**
 * Requests that a chat composer append plain text. Selection emitters target a
 * specific tab so exactly one live composer accepts the text; untargeted
 * requests remain supported for backwards-compatible visible-composer flows.
 */
export const INSERT_CHAT_TEXT_EVENT = 'canopy:insert-chat-text';

export interface InsertChatTextDetail {
  text: string;
  targetTabId?: string;
  targetChatId?: string;
  /** Draft-staging insertion: persist the live draft before acknowledging it. */
  stagingId?: string;
  /** Synchronous acknowledgement used by callers that need a draft fallback. */
  markHandled?: () => void;
  /** A live editor refused acceptance; callers must not retry from a stale saved draft. */
  markFailed?: (error: unknown) => void;
}

export function isInsertChatTextDetail(
  value: unknown,
): value is InsertChatTextDetail {
  if (typeof value !== 'object' || value === null) return false;
  if (
    'markFailed' in value &&
    value.markFailed !== undefined &&
    typeof value.markFailed !== 'function'
  )
    return false;
  if (
    'stagingId' in value &&
    value.stagingId !== undefined &&
    typeof value.stagingId !== 'string'
  )
    return false;
  if (!('text' in value) || typeof value.text !== 'string') return false;
  if (
    'targetTabId' in value &&
    value.targetTabId !== undefined &&
    typeof value.targetTabId !== 'string'
  ) {
    return false;
  }
  if (
    'targetChatId' in value &&
    value.targetChatId !== undefined &&
    typeof value.targetChatId !== 'string'
  )
    return false;
  return (
    !('markHandled' in value) ||
    value.markHandled === undefined ||
    typeof value.markHandled === 'function'
  );
}

/**
 * Whether a web composer takes an insert request (CAN-6801). One that takes
 * only its own chat's requests (a cloud composer) takes those naming
 * `chatId`; any other takes a request naming its chat or none. `chatId` is
 * the chat the composer inserts for, which a host that keys its drafts by
 * something else can name on its own.
 */
export function insertChatTextIsFor(
  detail: InsertChatTextDetail,
  composer: {
    readonly chatId: string | undefined;
    readonly ownChatOnly: boolean;
  },
): boolean {
  if (composer.ownChatOnly)
    return (
      composer.chatId !== undefined && detail.targetChatId === composer.chatId
    );
  return (
    detail.targetChatId === undefined || detail.targetChatId === composer.chatId
  );
}

/**
 * Hands `text` to the composer of the chat `chatId` names (CAN-6801), as an
 * unsaved queued edit's Restore does. Answers whether a live composer took
 * it: when none did, the caller keeps the text where it is. Empty text has
 * nothing to restore and is never sent, so a cleared edit never brings back
 * a draft's old text.
 *
 * Desktop composers match the request by tab and web composers by chat; a
 * chat's tab id is its chat id, so both are set.
 */
export function requestChatComposerText(input: {
  readonly chatId: string;
  readonly text: string;
}): boolean {
  if (input.text.length === 0 || typeof document === 'undefined') return false;
  let handled = false;
  const detail: InsertChatTextDetail = {
    text: input.text,
    targetTabId: input.chatId,
    targetChatId: input.chatId,
    markHandled: (): void => {
      handled = true;
    },
  };
  document.dispatchEvent(new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail }));
  return handled;
}
