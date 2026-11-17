import { useCallback, useEffect, useState } from 'react';
import { TRY_AGAIN_LABEL, TRYING_AGAIN_LABEL } from '@canopy/ui-shared';
import {
  BACKGROUND_SERVICE_RESTART_LABEL,
  BACKGROUND_SERVICE_RESTARTING_LABEL,
  backgroundServiceNoticeCopy,
} from '@canopy/ui-shared/lib';
import type {
  BackgroundServiceApi,
  BackgroundServiceStatus,
} from '@canopy/desktop-shared/lib/background-service-status';
import { pinToast, unpinToast } from '@/stores/toastStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

function getApi(): BackgroundServiceApi | undefined {
  return typeof window !== 'undefined'
    ? window.api?.backgroundService
    : undefined;
}

const TOAST_ID = 'background-service';

/**
 * A warning card in the toast stack while this computer's background service
 * can't be reached, with Try again or Restart app for a degraded startup
 * handoff. It stays until the service is reached again or the person closes
 * it; a closed card stays closed until the service has been reached and lost
 * again. Renders nothing itself, and never
 * calls the blocked channels in a window that shows another computer.
 */
export function BackgroundServiceUnavailableNotice(): null {
  const local = useRemoteControlStore(
    (store) => store.context.mode === 'local',
  );
  const [status, setStatus] = useState<BackgroundServiceStatus | null>(null);
  const [closed, setClosed] = useState(false);
  const [restartUnavailable, setRestartUnavailable] = useState(false);

  // Pushes, the first read and retry answers can land in any order.
  const accept = useCallback((next: BackgroundServiceStatus): void => {
    setStatus((previous) =>
      previous && previous.sequence >= next.sequence ? previous : next,
    );
  }, []);

  useEffect(() => {
    const api = local ? getApi() : undefined;
    if (!api) return undefined;
    const unsubscribe = api.onStatusChanged(accept);
    // Off the critical path: the notice is never needed for first paint.
    api.getStatus().then(accept, () => undefined);
    return unsubscribe;
  }, [local, accept]);

  const unavailable = local && status?.state === 'unavailable';
  // Reached again: a later loss shows its card even if this one was closed.
  if (!unavailable && closed) setClosed(false);
  const retry = unavailable && !closed ? status.retry : null;
  const recovery = unavailable ? status.recovery : undefined;

  useEffect(() => {
    if (retry === null) {
      unpinToast(TOAST_ID);
      return;
    }
    const copy = backgroundServiceNoticeCopy(
      retry,
      recovery,
      restartUnavailable,
    );
    pinToast({
      id: TOAST_ID,
      type: 'warning',
      message: copy.message,
      testId: 'background-service-notice',
      meta: {
        title: copy.title,
        action:
          recovery === 'restart_app'
            ? {
                label: BACKGROUND_SERVICE_RESTART_LABEL,
                busyLabel: BACKGROUND_SERVICE_RESTARTING_LABEL,
                testId: 'background-service-notice-restart',
                keepOpen: true,
                onClick: (): Promise<void> =>
                  window.api.restartApp().then(
                    (scheduled) => {
                      if (!scheduled) setRestartUnavailable(true);
                    },
                    () => setRestartUnavailable(true),
                  ),
              }
            : {
                label: TRY_AGAIN_LABEL,
                busyLabel: TRYING_AGAIN_LABEL,
                testId: 'background-service-notice-retry',
                // Keep the failure visible until the service is reached.
                keepOpen: true,
                onClick: (): Promise<void> | undefined =>
                  getApi()
                    ?.retry()
                    .then(accept, () => undefined),
              },
      },
      onDismiss: () => setClosed(true),
    });
  }, [retry, recovery, restartUnavailable, accept]);

  useEffect(() => (): void => unpinToast(TOAST_ID), []);

  return null;
}
