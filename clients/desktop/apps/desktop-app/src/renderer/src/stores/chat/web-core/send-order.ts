/**
 * Sends to one cloud chat post in the order they were pressed (CAN-6828).
 *
 * Each chat keeps one queue of places, in press order. A place is taken when
 * a send is pressed, before anything waits: by the chat store when its send
 * is called, or by New task when its button is clicked, ahead of the create
 * its message waits for. The place travels with the send, so a later
 * dispatch of the same message keeps it. A cloud send is never parked in the
 * renderer's own queue: the web core queues it.
 *
 * A place settles once its message posted or was dropped, and a send posts
 * only after every place before it in its chat settled. So that nothing
 * wedges the queue, a place always has one holder that settles it: the send
 * call that took it, until the web core backend claims it on the send's
 * arrival. The backend settles a claimed place whatever the send's outcome,
 * and the send call drops a place it still holds when it returns.
 */

/** A cloud chat, as the chat store names it. */
export interface CloudSendTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** A send's place in its chat's order. */
export interface CloudSendPress {
  readonly target: CloudSendTarget;
  readonly sequence: number;
}

type Holder = 'press' | 'dispatch';

interface Place {
  holder: Holder;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

let sequence = 0;
const queues = new Map<string, Map<number, Place>>();
const pressesByMessage = new Map<string, CloudSendPress>();

const chatOf = (target: CloudSendTarget): string =>
  `${target.projectId}/${target.worktreeId}/${target.chatId}`;

function placeOf(press: CloudSendPress): Place | undefined {
  return queues.get(chatOf(press.target))?.get(press.sequence);
}

/**
 * The next number in press order, for a send that took no place: it orders
 * after every send pressed before it reached the backend.
 */
export function nextCloudSendSequence(): number {
  sequence += 1;
  return sequence;
}

/** Takes the next place in the chat's order, for a send pressed now. */
export function pressCloudSend(target: CloudSendTarget): CloudSendPress {
  sequence += 1;
  const press: CloudSendPress = {
    target: {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
    },
    sequence,
  };
  let settle = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const chat = chatOf(target);
  const queue = queues.get(chat) ?? new Map<number, Place>();
  queue.set(sequence, { holder: 'press', settled, settle });
  queues.set(chat, queue);
  return press;
}

/** Whether the place is still in its chat's order. */
export function isCloudSendPressed(press: CloudSendPress): boolean {
  return placeOf(press) !== undefined;
}

/** The place's message posted or was dropped: later sends may post. */
export function settleCloudSend(press: CloudSendPress): void {
  const chat = chatOf(press.target);
  const queue = queues.get(chat);
  const place = queue?.get(press.sequence);
  if (queue === undefined || place === undefined) return;
  queue.delete(press.sequence);
  if (queue.size === 0) queues.delete(chat);
  place.settle();
}

/** Drops a place its send call still holds: the send gave up before dispatch. */
export function releaseUnclaimedCloudSend(press: CloudSendPress): void {
  if (placeOf(press)?.holder === 'press') settleCloudSend(press);
}

/** Hands the place to the dispatch of the message `messageId`. */
export function attachCloudSendPress(
  messageId: string,
  press: CloudSendPress,
): void {
  if (placeOf(press) !== undefined) pressesByMessage.set(messageId, press);
}

/**
 * Claims the place handed to the message `messageId`'s dispatch, if any.
 * The caller settles it once the send posted or failed.
 */
export function claimCloudSend(messageId: string): CloudSendPress | undefined {
  const press = pressesByMessage.get(messageId);
  pressesByMessage.delete(messageId);
  if (press === undefined) return undefined;
  const place = placeOf(press);
  if (place === undefined) return undefined;
  place.holder = 'dispatch';
  return press;
}

/** Settles once every place before `press` in its chat settled. */
export function whenCloudSendMayPost(press: CloudSendPress): Promise<void> {
  const queue = queues.get(chatOf(press.target));
  if (queue === undefined) return Promise.resolve();
  const earlier: Promise<void>[] = [];
  for (const [placed, place] of queue) {
    if (placed >= press.sequence) break;
    earlier.push(place.settled);
  }
  return Promise.all(earlier).then(() => undefined);
}

/** Test seam: forgets every queue. Their sends are already settled or gone. */
export function resetCloudSendOrder(): void {
  for (const queue of queues.values())
    for (const place of queue.values()) place.settle();
  queues.clear();
  pressesByMessage.clear();
}
