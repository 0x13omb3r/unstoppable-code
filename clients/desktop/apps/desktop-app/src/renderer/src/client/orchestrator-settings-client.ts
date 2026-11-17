import type { OrchestratorSettingsDraftClient } from '@canopy/app-core';
import { APP_ADVISOR_SETTINGS_SAVED_EVENT } from '@/lib/appAdvisorSettingsEvents';

/** Keeps the established independent reads and acknowledged-save broadcast. */
export function createOrchestratorSettingsDraftClient(): OrchestratorSettingsDraftClient {
  return {
    loadInstructions: () => window.api.appAdvisor.loadClaudeMd(),
    loadRetention: () => window.api.appAdvisor.settingsLoad(),
    saveInstructions: (instructions) =>
      window.api.appAdvisor.saveClaudeMd(instructions),
    saveRetention: async (patch) => {
      const saved = await window.api.appAdvisor.settingsSave(patch);
      window.dispatchEvent(
        new CustomEvent(APP_ADVISOR_SETTINGS_SAVED_EVENT, { detail: saved }),
      );
      return saved;
    },
  };
}
