/**
 * What a window that shows another computer reads when the two computers run
 * different remote-control protocols and one of them needs an update
 * (CAN-5899). The controller builds it from the host's `core.update` status;
 * it never travels between computers, so it is not part of the session
 * protocol. The shared notice turns it into copy, so every host that can
 * update a paired computer words it the same way.
 */

/** Which computer has to update: the older protocol of the two. */
export type RemoteHostUpdateTarget = 'host' | 'this-computer';

export const REMOTE_HOST_UPDATE_PHASES = [
  /** The older computer can update; nothing has started. */
  'ready',
  'checking',
  'downloading',
  /** This computer's update finished downloading and waits for a restart. */
  'downloaded',
  /** The host restarts to update once its running work finishes. */
  'waiting',
  /** The host is installing the update and restarting. */
  'restarting',
  /** The host restarted to update and did not come back in time. */
  'not-back',
  /** The connection dropped without a restart and is coming back. */
  'reconnecting',
  /** The older computer's release channel has nothing newer. */
  'up-to-date',
  'failed',
  /** The older computer can't be updated from here; `reason` says why. */
  'unavailable',
] as const;
export type RemoteHostUpdatePhase = (typeof REMOTE_HOST_UPDATE_PHASES)[number];

export const REMOTE_HOST_UPDATE_REASONS = [
  /** The person at the host turned off updates from other computers. */
  'remote-updates-off',
  /** The host runs a source or unpackaged build. */
  'development-build',
  /** The host updates by hand; `detail` holds its steps when it sent any. */
  'manual-update',
  /** Updating a Windows host from another computer isn't available yet. */
  'windows-host',
  /** The host restarted and came back on its old version. */
  'restarted-without-updating',
  /** Someone at the host withdrew the restart this computer asked for. */
  'cancelled-at-host',
  /** Someone at the host picked a specific version to install. */
  'targeted-update-pending',
] as const;
export type RemoteHostUpdateReason =
  (typeof REMOTE_HOST_UPDATE_REASONS)[number];

export interface RemoteHostUpdateStatus {
  readonly target: RemoteHostUpdateTarget;
  /** Each version as its own computer shows it, such as `internal-123`. */
  readonly hostVersion: string;
  readonly localVersion: string;
  /** Release flavors (`stable`, `rc`, `internal`); null when unknown. */
  readonly hostFlavor: string | null;
  readonly localFlavor: string | null;
  readonly phase: RemoteHostUpdatePhase;
  readonly reason: RemoteHostUpdateReason | null;
  /** Download progress from 0 to 1, while downloading. */
  readonly progress: number | null;
  /** Text from the updating computer itself: an error or manual steps. */
  readonly detail: string | null;
  /** The pending restart waits for chats that are running on the host. */
  readonly waitingForChats: boolean;
  /** Another computer asked for the pending restart; null otherwise. */
  readonly requestedBy: string | null;
  /** This computer asked for the pending restart and may withdraw it. */
  readonly canCancel: boolean;
}
