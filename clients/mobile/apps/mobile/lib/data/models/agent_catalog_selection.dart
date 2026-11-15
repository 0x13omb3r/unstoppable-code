/// Absent is an older host; empty is a checked, unsupported combination.
final class AgentCatalogSelection {
  const AgentCatalogSelection({
    this.preferredModel,
    required this.supportedModels,
  });
  final String? preferredModel;
  final Map<String, List<String>> supportedModels;
  static const harnesses = {
    'claude',
    'codex',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
  };
  static bool concrete(Object? value) =>
      value is String &&
      value.trim().isNotEmpty &&
      value != 'auto' &&
      value != 'default' &&
      !value.startsWith('agent_model_') &&
      !value.startsWith(r'$');

  static AgentCatalogSelection read(Object? value) {
    const empty = AgentCatalogSelection(supportedModels: {});
    if (value is! Map ||
        value['supportedModels'] is! List ||
        (value.containsKey('preferredModel') &&
            !concrete(value['preferredModel']))) {
      return empty;
    }
    final supported = <String, List<String>>{};
    for (final row in value['supportedModels'] as List) {
      if (row is! Map ||
          !concrete(row['modelId']) ||
          row['harnesses'] is! List) {
        return empty;
      }
      final choices = row['harnesses'] as List;
      if (choices.isEmpty ||
          choices.any((v) => v is! String || !harnesses.contains(v))) {
        return empty;
      }
      supported[row['modelId'] as String] = List<String>.unmodifiable(choices);
    }
    return AgentCatalogSelection(
      preferredModel: value['preferredModel'] as String?,
      supportedModels: Map.unmodifiable(supported),
    );
  }
}
