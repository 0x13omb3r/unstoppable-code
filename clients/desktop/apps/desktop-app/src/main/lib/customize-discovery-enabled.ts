import { CUSTOMIZE_DISCOVERY_EXPERIMENT } from '@canopy/protocol/experiments';
import { logMainProcessWarn } from './main-process-logging';

// ---------------------------------------------------------------------------
// Whether New Customize (the `customize-discovery` Labs experiment) is on, as
// desktop main evaluates it (CAN-6817). The one Add for every harness work
// it gates on in main (keeping records in sync after updates, flagging copies
// changed outside the app, and Claude Code loading a recorded Codex-only
// plugin's skills) only runs while it is on.
//
// A snapshot that is not ready, or a service that cannot be read, counts as
// off: off is today's behaviour, which is the safe side for every caller.
// ---------------------------------------------------------------------------

export async function isCustomizeDiscoveryEnabledInMain(): Promise<boolean> {
  try {
    const { getLabsExperimentsService } =
      await import('../services/labs-experiments-runtime');
    const snapshot = getLabsExperimentsService().getSnapshot();
    return (
      snapshot.ready &&
      snapshot.experiments.some(
        (entry) =>
          entry.id === CUSTOMIZE_DISCOVERY_EXPERIMENT.id &&
          entry.enabled === true,
      )
    );
  } catch (error) {
    try {
      logMainProcessWarn(
        '[harness-installs]',
        `Could not read the New Customize setting: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Logging must never turn this read into a failure.
    }
    return false;
  }
}
