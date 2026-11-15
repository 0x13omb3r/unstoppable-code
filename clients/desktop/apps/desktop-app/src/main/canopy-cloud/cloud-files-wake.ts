import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import { CanopyClientError } from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import type { CloudChatFilesWakeResult } from '@canopy/desktop-shared/types';
import { z } from 'zod';
import {
  cloudChatIdOfKey,
  validIds,
  withLeasedWebCoreClient,
} from './cloud-chat-attachments';
import {
  connectWebCoreForFilesWake,
  type WebCoreBindingOptions,
} from './web-core-connection';

/**
 * Waking a cloud chat's sandbox for its Files panel (CAN-6724).
 *
 * The renderer relay strips `wake` and never carries the same-origin wake
 * proof, so a renderer can't wake (and bill) a sandbox. Opening Files on a
 * sleeping chat asks main instead, naming the chat. Main wakes only a chat
 * the asking window follows (its `core.chat.events` stream is open on the
 * window's relay session), one wake per chat at a time, with one waking
 * `worker.filesystem.directory.list` on a connection of its own: the only
 * request desktop sends with the wake proof. The web core then checks the
 * chat's owner and the spend gate, as for the web's own wake.
 */

const WAKE_TIMEOUT_MS = 120_000;

const targetSchema = z.strictObject({
  key: z.string().min(1).max(1024),
  workspaceId: z.string().min(1).max(512),
  worktreeId: z.string().min(1).max(512),
});

/** Wakes one chat's sandbox, or throws the web core's refusal. */
export type CloudFilesWaker = (chatId: string) => Promise<void>;

export interface CloudFilesWakeOptions {
  /** `canopyDesktopCloudChats`, evaluated in main. */
  readonly isEnabled: () => boolean;
  readonly wake: CloudFilesWaker;
}

/** The renderer-facing reason for a failed wake. */
function wakeFailure(
  error: unknown,
): Exclude<CloudChatFilesWakeResult, { ok: true }>['reason'] {
  const payload =
    error instanceof CanopyClientError || error instanceof CanopyTransportError
      ? error.payload
      : null;
  if (payload === null) return 'offline';
  if (payload.kind === 'unauthenticated') return 'unauthenticated';
  if (payload.kind === 'capability_unavailable') return 'disabled';
  if (
    payload.kind === 'unavailable' ||
    payload.kind === 'deadline_exceeded' ||
    payload.kind === 'cancelled'
  )
    return 'offline';
  return 'refused';
}

/**
 * One wake per call, for a chat the asking window follows (`follows`, from
 * that window's relay session). A second call for the same chat while one
 * runs shares it rather than starting another.
 */
export function createCloudFilesWake(
  options: CloudFilesWakeOptions,
): (
  target: unknown,
  follows: (chatId: string) => boolean,
) => Promise<CloudChatFilesWakeResult> {
  const inFlight = new Map<string, Promise<CloudChatFilesWakeResult>>();
  return (target, follows) => {
    if (!options.isEnabled())
      return Promise.resolve({ ok: false, reason: 'disabled' });
    const parsed = targetSchema.safeParse(target);
    const chatId = parsed.success ? cloudChatIdOfKey(parsed.data.key) : null;
    if (!parsed.success || chatId === null || !validIds(parsed.data))
      return Promise.resolve({ ok: false, reason: 'rejected' });
    // A cloud chat's task is the chat: its key and task name the same one.
    if (parsed.data.worktreeId !== chatId)
      return Promise.resolve({ ok: false, reason: 'rejected' });
    if (!follows(chatId))
      return Promise.resolve({ ok: false, reason: 'not_open' });
    const running = inFlight.get(chatId);
    if (running !== undefined) return running;
    const wake = options.wake(chatId).then(
      (): CloudChatFilesWakeResult => ({ ok: true }),
      (error: unknown): CloudChatFilesWakeResult => ({
        ok: false,
        reason: wakeFailure(error),
      }),
    );
    inFlight.set(chatId, wake);
    void wake.finally(() => {
      if (inFlight.get(chatId) === wake) inFlight.delete(chatId);
    });
    return wake;
  };
}

/**
 * Wakes on a connection of its own, the only one that carries the wake
 * proof: the chat's roots, then its first root's listing with `wake`.
 */
export function createWebCoreFilesWaker(
  binding: WebCoreBindingOptions,
  clientVersion: string,
): CloudFilesWaker {
  return (chatId) =>
    withLeasedWebCoreClient(
      binding,
      {
        clientName: 'canopy-desktop-cloud-chat-files-wake',
        clientVersion,
        label: 'Desktop cloud chat Files wake',
        definitions: {
          queries: WORKER_FILESYSTEM_QUERY_DEFINITIONS,
          instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
        },
        signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
        connect: connectWebCoreForFilesWake,
      },
      async (client) => {
        const scope = { chatId };
        const listed = await client.query('worker.filesystem.roots.list', {
          scope,
        });
        const [root] = listed.roots;
        if (root === undefined)
          throw new CanopyClientError({
            kind: 'failed_precondition',
            message: 'The chat has no files to wake.',
            retry: { kind: 'never' },
          });
        await client.query('worker.filesystem.directory.list', {
          scope,
          fileRootId: root.fileRootId,
          relativePath: '',
          wake: true,
        });
      },
    );
}
