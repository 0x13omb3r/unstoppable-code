import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_row.dart';
import 'package:mobile/data/models/agent_model_selection.dart';
import 'composer_controls.dart';

Future<void> showComposerAgentPicker(
  BuildContext context,
  ValueListenable<ComposerControlsData> live,
) => showModalBottomSheet<void>(
  context: context,
  showDragHandle: true,
  useSafeArea: true,
  isScrollControlled: true,
  builder: (_) => ValueListenableBuilder<ComposerControlsData>(
    valueListenable: live,
    builder: (context, data, _) {
      final selected = selectedAgentId(data.selectedModelId);
      void choose(String? agent) {
        final next = changeSelectedAgent(
          data.selectedModelId,
          agent,
          agent == null ? data.agentRemovalModelId : data.effectiveModelId,
        );
        if (next == null || data.onSelectModel == null) return;
        Navigator.of(context).pop();
        data.selectModel(next);
      }

      return ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * .7,
        ),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(8, 0, 8, 24),
          children: [
            CanopyModelRow(
              vendor: 'other',
              glyph: CanopyGlyph.agent,
              label: 'No agent',
              selected: selected == null,
              enabled:
                  data.agentRemovalModelId != null &&
                  data.onSelectModel != null,
              onTap: () {
                if (data.agentRemovalModelId != null) choose(null);
              },
            ),
            for (final agent in data.availableModels.where(
              (row) => row.kind == 'agent',
            ))
              Builder(
                builder: (context) {
                  final next = changeSelectedAgent(
                    data.selectedModelId,
                    agent.id,
                    data.effectiveModelId,
                  );
                  final enabled =
                      validAgentSelection(data.availableModels, next) &&
                      data.onSelectModel != null;
                  return CanopyModelRow(
                    key: ValueKey('agent-option-${agent.id}'),
                    vendor: 'other',
                    glyph: CanopyGlyph.agent,
                    label: agent.label,
                    selected: selected == agent.id,
                    enabled: enabled,
                    explanation: enabled
                        ? agent.description
                        : 'Choose a supported model first',
                    onTap: () {
                      if (enabled) choose(agent.id);
                    },
                  );
                },
              ),
          ],
        ),
      );
    },
  ),
);
