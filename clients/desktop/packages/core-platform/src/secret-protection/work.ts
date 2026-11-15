/** Includes native promises and adapter cleanup, not just public call settlement. */
export interface NativeProtectionWork {
  track<T>(work: () => Promise<T>): Promise<T>;
}

export const untrackedProtectionWork: NativeProtectionWork = {
  track: (work) => work(),
};
