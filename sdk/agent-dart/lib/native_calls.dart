/// The platform's call screen for Callio calls — CallKit on iOS, the
/// full-screen incoming-call UI and ConnectionService on Android
/// (flutter_callkit_incoming) — and Callio's call pushes.
///
///   * CallioNativeCalls(agent).attach()     in the app: mirror calls ↔ native screen
///   * CallioBackground.handlePush(data)     in the push handler: show / dismiss
///   * CallioBackground.declineCall(...)     a Decline tapped while the app isn't running
library;

export 'src/native/background.dart' show CallioBackground;
export 'src/native/native_calls.dart' show CallioNativeCalls, NativeRingPolicy;
export 'src/native/native_ui.dart' show NativeCallUi, CallkitNativeUi, NativeAction, NativeActionType, NativeCallStyle, NativeIncoming;
export 'src/native/push.dart' show CallioPush, CallioPushType, uuidForCall;
