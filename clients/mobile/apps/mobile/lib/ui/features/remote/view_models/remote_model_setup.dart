import 'dart:async';

import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'owned_command_registry.dart';

/// A submission id is not acceptance: setup must finish before its first send.
Future<void> confirmRemoteComposerCommand({
  required OwnedCommandRegistry commands,
  required Future<String> Function() submit,
  required bool Function() isCurrent,
  OwnedCommandFailed? onFailed,
}) async {
  void requireCurrent() {
    if (!isCurrent()) {
      throw const RemoteControlException('Remote Control is disconnected.');
    }
  }

  requireCurrent();
  final commandId = await submit();
  requireCurrent();
  if (commandId.isEmpty) {
    throw const RemoteControlException('The setting change was not confirmed.');
  }
  commands.register(commandId, throwIfFailed: true, onFailed: onFailed);
  if (!commands.hasCompleted(commandId)) {
    try {
      await commands.waitForResult(
        commandId,
        timeout: const Duration(seconds: 30),
      );
    } on TimeoutException {
      throw const RemoteControlException(
        'The setting change was not confirmed.',
      );
    }
  }
  requireCurrent();
}
