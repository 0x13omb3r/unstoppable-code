/** Independent settings reads preserve the local dialog's partial availability. */
export interface OrchestratorRetentionSettings {
  readonly archiveRetentionDays?: number | null;
  readonly autoArchiveDays?: number | null;
}

/** Host adapter over existing settings operations; this adds no backend route. */
export interface OrchestratorSettingsDraftClient {
  loadInstructions(): Promise<string>;
  loadRetention(): Promise<OrchestratorRetentionSettings>;
  saveInstructions(instructions: string): Promise<void>;
  saveRetention(
    patch: OrchestratorRetentionSettings,
  ): Promise<OrchestratorRetentionSettings>;
}
