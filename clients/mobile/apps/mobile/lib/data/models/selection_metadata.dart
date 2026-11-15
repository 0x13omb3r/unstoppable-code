import 'agent_model_selection.dart' show selectedAgentId;
import 'chat_message.dart';

const List<String> kThinkingLevelOrder = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

List<String> providerFallbackThinkingLevels(String? providerHint) =>
    switch (providerHint) {
      'unknown' || 'cursor' || 'copilot' || 'opencode' => const [],
      'codex' => const ['off', 'medium', 'high', 'xhigh'],
      _ => const ['off', 'medium', 'high', 'xhigh', 'max'],
    };

final class ModelSelectionMetadata {
  const ModelSelectionMetadata({
    required this.selection,
    required this.agentRow,
    required this.concreteModelId,
    required this.modelRow,
    required this.metadataRow,
    required this.executionHarness,
    required this.thinkingLevels,
  });
  final String? selection;
  final ModelOption? agentRow;
  final String? concreteModelId;
  final ModelOption? modelRow;
  final ModelOption? metadataRow;
  final String? executionHarness;
  final List<String> thinkingLevels;
}

/// Describes existing state without requiring current admission or availability.
ModelSelectionMetadata resolveModelSelectionMetadata({
  required List<ModelOption> catalog,
  required String? selection,
  String? executionHarness,
  String? providerHint,
  String? defaultModelId,
}) {
  final agentId = selectedAgentId(selection);
  final explicit = agentId != null && selection!.contains('@');
  final agentRow = catalog
      .where((row) => row.kind == 'agent' && row.id == agentId)
      .firstOrNull;
  final concreteId = explicit
      ? selection.substring(selection.indexOf('@') + 1)
      : agentId != null
      ? agentRow?.agentSelection?.preferredModel
      : selection ??
            defaultModelId ??
            catalog
                .where((row) => row.kind == 'model' && row.isDefault)
                .firstOrNull
                ?.id;
  final modelRow = catalog
      .where((row) => row.kind == 'model' && row.id == concreteId)
      .firstOrNull;
  final source = modelRow ?? (agentId != null && !explicit ? agentRow : null);
  final support = agentRow?.agentSelection?.supportedModels[concreteId];
  final baseHarness = source?.harness ?? source?.provider;
  final harness =
      executionHarness ??
      (support == null || support.contains(baseHarness)
          ? baseHarness
          : support.firstOrNull);
  final needsProjection =
      harness != baseHarness ||
      (source?.harnessProviders.containsKey(harness) ?? false) ||
      (source?.harnessThinkingLevels.containsKey(harness) ?? false) ||
      (source?.harnessFastModes.containsKey(harness) ?? false) ||
      (source?.harnessContextWindows.containsKey(harness) ?? false);
  final metadata = needsProjection
      ? source?.forExecution(selection: source.id, executionHarness: harness)
      : source;
  final declared =
      metadata?.supportedThinkingLevels ?? metadata?.thinkingLevels;
  final levels = declared == null
      ? providerFallbackThinkingLevels(harness ?? providerHint)
      : [
          for (final level in kThinkingLevelOrder)
            if (declared.contains(level)) level,
        ];
  return ModelSelectionMetadata(
    selection: selection,
    agentRow: agentRow,
    concreteModelId: concreteId,
    modelRow: modelRow,
    metadataRow: metadata,
    executionHarness: harness,
    thinkingLevels: levels,
  );
}
