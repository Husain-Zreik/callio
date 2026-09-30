// The platform's call screen: CallKit on iOS, the plugin's full-screen
// incoming-call UI + ConnectionService on Android (flutter_callkit_incoming).
// CallioNativeCalls talks to this interface; tests pass a fake.
import 'dart:async';

import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';

enum NativeActionType { accept, decline, ended, timeout }

/// Something the user did on the native call screen.
class NativeAction {
  NativeAction(this.type, this.uuid, [this.callId]);
  final NativeActionType type;
  final String uuid;

  /// From the screen's extra data, when the SDK showed it.
  final String? callId;
  @override
  String toString() => 'NativeAction(${type.name}, $uuid, $callId)';
}

/// How the native call screen looks. Colors are '#rrggbb'.
class NativeCallStyle {
  const NativeCallStyle({
    this.appName = 'Calls',
    this.ringDuration = const Duration(seconds: 60),
    this.androidChannelName = 'Incoming calls',
    this.backgroundColor,
    this.actionColor,
    this.textAccept,
    this.textDecline,
    this.iosIconName,
  });

  final String appName;
  final Duration ringDuration;
  final String androidChannelName;
  final String? backgroundColor;
  final String? actionColor;
  final String? textAccept;
  final String? textDecline;
  final String? iosIconName;
}

class NativeIncoming {
  NativeIncoming({required this.uuid, required this.callId, required this.name, this.handle, this.accepted = false});
  final String uuid;
  final String callId;
  final String name;
  final String? handle;
  final bool accepted;
}

abstract class NativeCallUi {
  Future<void> showIncoming(NativeIncoming call, NativeCallStyle style);
  Future<void> showOutgoing(NativeIncoming call, NativeCallStyle style);
  Future<void> setConnected(String uuid);
  Future<void> end(String uuid);

  /// Calls the native UI knows about (Android: the last one). `accepted` is set
  /// when the user accepted it — e.g. the tap that launched the app.
  Future<List<NativeIncoming>> active();
  Stream<NativeAction> get actions;
}

class CallkitNativeUi implements NativeCallUi {
  CallkitNativeUi();

  Stream<NativeAction>? _actions;

  static CallKitParams params(NativeIncoming call, NativeCallStyle style) => CallKitParams(
        id: call.uuid,
        nameCaller: call.name,
        appName: style.appName,
        handle: call.handle ?? call.name,
        type: 0, // audio
        duration: style.ringDuration.inMilliseconds,
        extra: {'callId': call.callId},
        android: AndroidParams(
          textAccept: style.textAccept,
          textDecline: style.textDecline,
          isCustomNotification: true,
          isShowFullLockedScreen: true,
          isShowCallID: false,
          ringtonePath: 'system_ringtone_default',
          backgroundColor: style.backgroundColor,
          actionColor: style.actionColor,
          incomingCallNotificationChannelName: style.androidChannelName,
          missedCallNotificationChannelName: 'Missed calls',
        ),
        ios: IOSParams(
          iconName: style.iosIconName,
          handleType: 'generic',
          supportsVideo: false,
          supportsDTMF: false,
          supportsHolding: false,
          supportsGrouping: false,
          supportsUngrouping: false,
          maximumCallGroups: 1,
          maximumCallsPerCallGroup: 1,
          audioSessionMode: 'voiceChat',
          audioSessionActive: true,
          audioSessionPreferredSampleRate: 48000.0,
          audioSessionPreferredIOBufferDuration: 0.005,
          includesCallsInRecents: true,
        ),
      );

  @override
  Future<void> showIncoming(NativeIncoming call, NativeCallStyle style) => FlutterCallkitIncoming.showCallkitIncoming(params(call, style));

  @override
  Future<void> showOutgoing(NativeIncoming call, NativeCallStyle style) => FlutterCallkitIncoming.startCall(params(call, style));

  @override
  Future<void> setConnected(String uuid) => FlutterCallkitIncoming.setCallConnected(uuid);

  @override
  Future<void> end(String uuid) => FlutterCallkitIncoming.endCall(uuid);

  @override
  Future<List<NativeIncoming>> active() async {
    final calls = await FlutterCallkitIncoming.activeCalls();
    return [
      for (final c in calls)
        NativeIncoming(uuid: c.id, callId: '${c.extra?['callId'] ?? ''}', name: c.nameCaller ?? '', handle: c.handle, accepted: c.isAccepted),
    ];
  }

  @override
  Stream<NativeAction> get actions => _actions ??= FlutterCallkitIncoming.onEvent
      .map<NativeAction?>((event) => switch (event) {
            CallEventActionCallAccept(:final callKitParams) => _action(NativeActionType.accept, callKitParams),
            CallEventActionCallDecline(:final callKitParams) => _action(NativeActionType.decline, callKitParams),
            CallEventActionCallEnded(:final callKitParams) => _action(NativeActionType.ended, callKitParams),
            CallEventActionCallTimeout(:final id) => NativeAction(NativeActionType.timeout, id),
            _ => null,
          })
      .where((a) => a != null)
      .cast<NativeAction>()
      .asBroadcastStream();

  static NativeAction _action(NativeActionType type, CallKitParams p) =>
      NativeAction(type, p.id, p.extra?['callId'] == null ? null : '${p.extra!['callId']}');
}
