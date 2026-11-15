import type { PlatformSecretProtectionServices } from '@canopy/core-runtime';
import {
  createNativeArtifactAuthorizer,
  type NativeArtifactPreparationOptions,
} from './authorization';
import { compiledNativeArtifactCatalog } from './catalog';
import { createSecretProtectionServices } from './index';
import { createNativeProtectionLifetime } from './lifetime';
import {
  resolveSecretProtectionPolicy,
  resolveWindowsSecretProtectionPolicy,
  type SecretProtectionOptions,
} from './policy';

export interface NativeSecretProtectionOwner {
  readonly services: Promise<PlatformSecretProtectionServices | null>;
  closeAdmission(): void;
  drain(signal: AbortSignal): Promise<boolean>;
}

/** Trusted host composition only. Identity errors precede artifact containment. */
export function createNativeSecretProtectionOwner(
  options: SecretProtectionOptions & NativeArtifactPreparationOptions,
): NativeSecretProtectionOwner {
  if (options.os === 'win32') resolveWindowsSecretProtectionPolicy(options);
  else resolveSecretProtectionPolicy(options);
  const work = createNativeProtectionLifetime();
  const authorizer = createNativeArtifactAuthorizer(options);
  let cleanup: Promise<void> | undefined;
  const closeAdmission = (): void => {
    work.closeAdmission();
    authorizer.invalidate();
  };
  const services = work
    .track(async (): Promise<PlatformSecretProtectionServices | null> => {
      const catalog = compiledNativeArtifactCatalog();
      if (
        !catalog ||
        catalog.member.state !== 'present' ||
        catalog.brandId !== options.brandId ||
        catalog.build !== options.build
      )
        return null;
      await authorizer.reap();
      if (work.signal.aborted) return null;
      const preparedNative = await authorizer.prepare();
      if (!preparedNative || work.signal.aborted) return null;
      const raw = createSecretProtectionServices(
        { ...options, preparedNative },
        work,
      );
      async function dispatch<T>(
        caller: AbortSignal,
        call: (signal: AbortSignal) => Promise<T>,
      ): Promise<T> {
        work.admit();
        const signal = AbortSignal.any([caller, work.signal]);
        return work.track(() => call(signal));
      }
      return {
        backend: raw.backend,
        status: (options) =>
          dispatch(options.signal, (signal) => raw.status({ signal })),
        readKeySlot: (slot, options) =>
          dispatch(options.signal, async (signal) => {
            const result = await raw.readKeySlot(slot, { ...options, signal });
            if (signal.aborted) {
              // An abandoned probe's consumer may settle before its discard tail.
              if (result.kind === 'present') result.material.fill(0);
              signal.throwIfAborted();
            }
            return result;
          }),
        writeKeySlot: (slot, material, options) =>
          dispatch(options.signal, (signal) =>
            raw.writeKeySlot(slot, material, { ...options, signal }),
          ),
        deleteKeySlot: (slot, options) =>
          dispatch(options.signal, (signal) =>
            raw.deleteKeySlot(slot, { ...options, signal }),
          ),
      };
    })
    .catch(() => null);
  return {
    services,
    closeAdmission,
    drain(signal): Promise<boolean> {
      closeAdmission();
      cleanup ??= work.track(async () => {
        try {
          await authorizer.dispose();
        } catch {
          work.refuseConfirmation();
        }
      });
      // Disposal and preparation remain tracked even if the deadline wins.
      void cleanup.catch(() => undefined);
      return work.drain(signal);
    },
  };
}
