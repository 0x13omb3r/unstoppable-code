import {
  captureWindowsClosureContext,
  observeWindowsClosure,
} from '../supervision/windows-closure';
import type { NativeProtectionWork } from './work';

/** One witness edge per owner; outstanding work has no cumulative call limit. */
export function createNativeProtectionLifetime(): NativeProtectionWork & {
  readonly signal: AbortSignal;
  admit(): void;
  closeAdmission(): void;
  refuseConfirmation(): void;
  drain(signal: AbortSignal): Promise<boolean>;
} {
  const context = captureWindowsClosureContext();
  const edge = observeWindowsClosure('native-protection');
  const lifetime = new AbortController();
  let pending = 0;
  let quiet = (): void => undefined;
  let failed = false;
  let closed = false;
  let draining: Promise<boolean> | undefined;
  const refuseConfirmation = (): void => {
    failed = true;
    edge?.unsafe();
  };
  const checkContext = (): void => {
    if (!context()) refuseConfirmation();
  };
  const closeAdmission = (): void => {
    checkContext();
    lifetime.abort();
  };
  return {
    signal: lifetime.signal,
    admit(): void {
      checkContext();
      lifetime.signal.throwIfAborted();
    },
    async track<T>(work: () => Promise<T>): Promise<T> {
      checkContext();
      if (closed) {
        failed = true;
        edge?.unsafe();
        throw new Error('Native protection owner drained.');
      }
      pending++;
      try {
        return await work();
      } finally {
        if (--pending === 0) quiet();
      }
    },
    closeAdmission,
    refuseConfirmation,
    drain(signal): Promise<boolean> {
      checkContext();
      closeAdmission();
      draining ??= new Promise<boolean>((resolve) => {
        const expired = (): void => {
          failed = true;
          edge?.unsafe();
          resolve(false);
        };
        const finish = (): void => {
          if (pending !== 0) return;
          signal.removeEventListener('abort', expired);
          if (!failed && !closed) {
            closed = true;
            edge?.close();
          }
          resolve(!failed);
        };
        quiet = finish;
        signal.addEventListener('abort', expired, { once: true });
        if (signal.aborted) expired();
        finish();
      });
      return draining.then((confirmed) => confirmed && !failed);
    },
  };
}
