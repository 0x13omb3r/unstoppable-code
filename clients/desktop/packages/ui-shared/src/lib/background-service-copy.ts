export interface BackgroundServiceNoticeCopy {
  readonly title: string;
  readonly message: string;
}

export const BACKGROUND_SERVICE_RESTART_LABEL = 'Restart app';
export const BACKGROUND_SERVICE_RESTARTING_LABEL = 'Restarting…';

/**
 * The copy for the card the host shows while the local background service
 * can't be reached (CAN-5541), by the state of the latest Try again: `failed`
 * once one ended without reaching it. Static copy only: no path, error
 * message or authority id, so replay and autocapture stay safe.
 */
export function backgroundServiceNoticeCopy(
  retry: 'idle' | 'running' | 'failed',
  recovery?: 'restart_app',
  restartUnavailable = false,
): BackgroundServiceNoticeCopy {
  // The W5 startup handoff is one-shot; only a new launch can recover it.
  if (recovery === 'restart_app')
    return {
      title: "Couldn't start the background service",
      message: restartUnavailable
        ? 'Quit and reopen the app to start the background service. Save any unsaved changes first.'
        : 'Restart the app to start the background service. Workspace records stay read-only until then.',
    };
  return retry === 'failed'
    ? {
        title: "Still couldn't reach the background service",
        message: 'Files and folders may not load. Try again in a moment.',
      }
    : {
        title: "Couldn't reach the background service",
        message: 'Files and folders may not load.',
      };
}
