import 'dart:async';

import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/settings.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/protocol.dart';

typedef DeviceSettingsFailure = ({
  String message,
  bool reported,
  bool modelChange,
});

final class _Selection {
  _Selection(this.patch, this.save);
  final Map<String, dynamic> patch;
  final Future<int> Function(Map<String, dynamic> tab) save;
  final result = Completer<bool>();
  int? revision;
}

Map<String, dynamic> _merge(
  Map<String, dynamic> tab,
  Map<String, dynamic> patch,
) => {
  ...tab,
  ...patch,
  if (patch['modelConfig'] case final Map<String, dynamic> config)
    'modelConfig': {...?tab['modelConfig'] as Map<String, dynamic>?, ...config},
};

/// Shows choices immediately while serializing the existing desktop commands.
/// A receipt's revision releases its preview only once chat state catches up.
/// The queue belongs to one selected chat and connection, never a later target.
final class DeviceComposerSettingsController {
  DeviceComposerSettingsController({
    required this.current,
    required this.sessionGeneration,
    required this.refresh,
    required this.onChanged,
  });

  final DeviceChatState? Function() current;
  final int Function() sessionGeneration;
  final Future<void> Function() refresh;
  final void Function() onChanged;
  final _selections = <_Selection>[];
  Object? _scope;
  Object? _refreshScope;
  Object? _workingScope;
  int _selectionGeneration = 0;
  bool _draining = false, _disposed = false;
  bool _requiresRefresh = false;
  DeviceSettingsFailure? failure;

  Object get _currentScope => (
    current()?.ref.key,
    current()?.closed,
    sessionGeneration(),
    _selectionGeneration,
  );
  bool get saving =>
      _selections.isNotEmpty || (_draining && _workingScope == _currentScope);
  bool get refreshing => _refreshScope == _currentScope;

  void invalidate() {
    _selectionGeneration++;
    sync();
  }

  /// Reconcile only against authoritative revisions, never a matching old value.
  void sync() {
    final scope = _currentScope;
    if (_scope != scope) {
      _scope = scope;
      for (final selection in _selections) {
        if (!selection.result.isCompleted) selection.result.complete(false);
      }
      _selections.clear();
      failure = null;
      _requiresRefresh = false;
    }
    final revision = current()?.revision;
    _selections.removeWhere(
      (selection) =>
          selection.revision != null &&
          revision != null &&
          revision >= selection.revision!,
    );
  }

  Map<String, dynamic> get tab {
    sync();
    return _selections.fold(current()?.tab ?? {}, (tab, selection) {
      return _merge(tab, selection.patch);
    });
  }

  Future<bool> change(
    DeviceChatRef ref,
    Map<String, dynamic> patch,
    Future<int> Function(Map<String, dynamic> tab) save,
  ) async {
    sync();
    if (_requiresRefresh) {
      final scope = _scope;
      try {
        await refresh();
      } catch (_) {
        return false;
      }
      if (_disposed || scope != _currentScope) return false;
      _requiresRefresh = false;
    }
    if (_disposed || current()?.ref.key != ref.key) {
      return Future.value(false);
    }
    final selection = _Selection(patch, save);
    _selections.add(selection);
    failure = null;
    onChanged();
    if (!_draining) unawaited(_drain());
    return selection.result.future;
  }

  Future<void> _drain() async {
    _draining = true;
    try {
      while (!_disposed) {
        sync();
        final next = _selections
            .where((selection) => selection.revision == null)
            .firstOrNull;
        if (next == null ||
            _selections.any((selection) => selection.revision != null)) {
          if (_selections.isEmpty) break;
          // The receipt and the push can complete on adjacent stream turns.
          await Future<void>.value();
          sync();
          if (_selections.isEmpty) break;
          if (_selections.every((selection) => selection.revision == null)) {
            continue;
          }
          // A receipt can have side effects beyond our patch, such as a model
          // change clearing provider settings. Recover missed state before
          // constructing the next write from the canonical tab.
          final scope = _scope;
          _refreshScope = scope;
          try {
            await refresh();
          } catch (cause) {
            // A failed read for the previous chat must not strand new picks.
            if (!_disposed && scope != _currentScope) continue;
            if (!_disposed && scope == _currentScope) {
              _recordFailure(cause);
              for (final selection in _selections) {
                if (!selection.result.isCompleted) {
                  selection.result.complete(false);
                }
              }
              _selections.clear();
            }
            break;
          } finally {
            _refreshScope = null;
          }
          sync();
          if (_selections.any((selection) => selection.revision == null)) {
            continue;
          }
          break;
        }
        final scope = _scope;
        _workingScope = scope;
        var effective = current()?.tab ?? <String, dynamic>{};
        for (final selection in _selections) {
          effective = _merge(effective, selection.patch);
          if (identical(selection, next)) break;
        }
        try {
          final revision = await next.save(effective);
          if (!_disposed && scope == _currentScope) next.revision = revision;
          if (!next.result.isCompleted) {
            next.result.complete(!_disposed && scope == _currentScope);
          }
        } catch (cause) {
          if (!_disposed && scope == _currentScope) {
            if (cause is DeviceChatSettingsRejected ||
                cause is DesktopIpcNotSent) {
              final superseded = _selections
                  .skipWhile((selection) => !identical(selection, next))
                  .skip(1)
                  .any(
                    (selection) =>
                        next.patch.keys.every(selection.patch.containsKey),
                  );
              _selections.remove(next);
              if (!superseded) _recordFailure(cause, patch: next.patch);
            } else {
              // A timeout or lost reply can still commit on the computer.
              // Cancel dependent picks instead of writing from uncertain state.
              for (final selection in _selections) {
                if (!selection.result.isCompleted) {
                  selection.result.complete(false);
                }
              }
              _selections.clear();
              _requiresRefresh = true;
              _recordFailure(cause, patch: next.patch);
              try {
                await refresh();
                if (scope == _currentScope) _requiresRefresh = false;
              } catch (_) {
                /* Keep dependent writes blocked until a read succeeds. */
              }
            }
          }
          if (!next.result.isCompleted) next.result.complete(false);
        }
        if (!_disposed) {
          sync();
          onChanged();
        }
      }
    } finally {
      _draining = false;
      _workingScope = null;
      if (!_disposed) onChanged();
    }
  }

  void _recordFailure(Object cause, {Map<String, dynamic> patch = const {}}) {
    final reported =
        cause is DeviceChatSettingsRejected || cause is DesktopIpcNotSent;
    failure = (
      message: reported
          ? _describe(cause)
          : '${cause is DeviceLinkException ? cause.message : 'The computer did not confirm this change.'} Check the selection before trying again.',
      reported: reported,
      modelChange:
          patch.containsKey('model') || patch.containsKey('modelSelectionMode'),
    );
  }

  String _describe(Object cause) => cause is DeviceLinkException
      ? cause.message
      : "Couldn't save chat settings. Try again.";

  void dispose() {
    _disposed = true;
    for (final selection in _selections) {
      if (!selection.result.isCompleted) selection.result.complete(false);
    }
    _selections.clear();
  }
}
