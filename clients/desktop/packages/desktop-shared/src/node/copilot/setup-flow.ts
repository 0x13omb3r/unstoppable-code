import {
  startDeviceFlow,
  pollDeviceFlow,
  type DeviceFlowOptions,
  type DeviceFlowGrant,
} from './device-flow';
import type { CopilotConnectionStatus } from '../../types/copilot-connection';

/** Trusted setup ingress. No durable write is permitted before the authority's entitlement probe. */
export async function authorizeCopilotSetup(options: {
  flow: DeviceFlowOptions;
  signal: AbortSignal;
  base: CopilotConnectionStatus;
  progress(status: CopilotConnectionStatus): void;
  install(
    progress: (
      phase: 'downloading' | 'verifying' | 'installing',
      percent?: number,
    ) => void,
  ): Promise<unknown>;
  identity(
    access: string,
    signal: AbortSignal,
  ): Promise<{ login: string; id: string }>;
}): Promise<
  DeviceFlowGrant & {
    version: 1;
    clientId: string;
    host: string;
    login: string;
    id: string;
  }
> {
  const { signal, base, flow } = options;
  const progress = (status: CopilotConnectionStatus): void =>
    options.progress(status);
  await options.install((phase, percent) =>
    progress({ ...base, phase, percent }),
  );
  signal.throwIfAborted();
  const start = await startDeviceFlow(flow, signal);
  progress({
    ...base,
    installed: true,
    phase: 'authorizing',
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    expiresAt: start.expiresAt,
  });
  let outcome;
  try {
    outcome = await pollDeviceFlow(flow, start, signal);
  } catch (error) {
    if ((flow.now ?? Date.now)() >= Date.parse(start.expiresAt))
      throw new Error('The GitHub code expired. Connect again.');
    throw error;
  }
  if (outcome.status === 'declined')
    throw new Error('GitHub sign-in was declined.');
  if (outcome.status === 'expired')
    throw new Error('The GitHub code expired. Connect again.');
  progress({ ...base, installed: true, phase: 'checking' });
  const identity = await options.identity(outcome.grant.accessToken, signal);
  signal.throwIfAborted();
  return {
    version: 1,
    clientId: flow.clientId,
    host: 'https://github.com',
    ...identity,
    ...outcome.grant,
  };
}
