import 'package:mobile/data/repositories/remote_app_advisor_commands.dart';
import 'owned_command_registry.dart';
import 'remote_model_setup.dart';

/// Reuses the same provisional tab when setup or delivery needs an explicit retry.
final class RemoteAdvisorModelSetup {
  final Map<String, String> _chatIds = {};
  final Set<String> _created = {};

  Future<String> prepare({
    required String messageId,
    required String model,
    required String executionHarness,
    required String Function() mintChatId,
    required RemoteAppAdvisorCommands advisor,
    required OwnedCommandRegistry commands,
    required bool Function() isCurrent,
    String? workEntryId,
  }) async {
    final chatId = _chatIds.putIfAbsent(messageId, mintChatId);
    if (!_created.contains(chatId)) {
      await confirmRemoteComposerCommand(
        commands: commands,
        submit: () =>
            advisor.createTab(chatId: chatId, workEntryId: workEntryId),
        isCurrent: isCurrent,
      );
      _created.add(chatId);
    }
    await confirmRemoteComposerCommand(
      commands: commands,
      submit: () => advisor.setModel(
        chatId: chatId,
        model: model,
        executionHarness: executionHarness,
      ),
      isCurrent: isCurrent,
    );
    return chatId;
  }

  void forget(String messageId) => _created.remove(_chatIds.remove(messageId));

  void clear() {
    _chatIds.clear();
    _created.clear();
  }
}
