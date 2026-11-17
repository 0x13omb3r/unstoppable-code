import {
  encodeCanopyError,
  type CanopyErrorPayload,
  type CanopyJsonRpcId,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';

/**
 * Error responses a binding made up for a request whose own reply it lost
 * (CAN-6940). The core never answered them, so a client reads one as a lost
 * call rather than as the operation's answer. Held by identity in this
 * process: no peer can send one.
 */
const lostReplies = new WeakSet<object>();

/** The response a binding delivers for request `id` when its reply is lost. */
export function canopyLostReply(
  id: CanopyJsonRpcId,
  error: CanopyErrorPayload,
): CanopyJsonRpcMessage {
  const message: CanopyJsonRpcMessage = {
    jsonrpc: '2.0',
    id,
    error: encodeCanopyError(error),
  };
  lostReplies.add(message);
  return message;
}

/** Whether `message` is a binding's stand-in for a reply it lost. */
export function isCanopyLostReply(message: object): boolean {
  return lostReplies.has(message);
}
