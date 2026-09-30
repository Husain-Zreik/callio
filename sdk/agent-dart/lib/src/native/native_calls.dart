// Ties the platform's call screen (NativeCallUi) to a CallioAgent's calls:
//
//   Callio → native   a ringing call shows the native screen (keyed by callUuid);
//                     when it ends anywhere the screen goes; answered → connected
//   native → Callio   Accept / Decline / End on the native screen act on the call
//
// Taps that come before the SDK knows the call (the app was woken by a push
// and is still connecting, or was cold-started by the Accept tap) are kept and
// applied as soon as the call arrives, for [pendingFor].
//
// The plugin reports back what the SDK itself did (ending a call it showed,
// marking it connected). Those echoes are harmless by construction: an action
// only applies to a call in the state it's meant for (accept a ringing call,
// hang up a live one), and screens this class closed itself are remembered.
import 'dart:async';

import '../agent.dart';
import '../call.dart';
import '../models.dart';
import 'native_ui.dart';
import 'push.dart';

/// When to show the native screen for a call that rings while a socket is live.
enum NativeRingPolicy {
  /// Always — the native screen is the ringing UI.
  always,

  /// Only when [CallioNativeCalls.appInForeground] says the app isn't in front
  /// (the app shows its own ringing UI in front).
  whenInBackground,
}

class CallioNativeCalls {
  CallioNativeCalls(
    this.agent, {
    NativeCallUi? ui,
    this.style = const NativeCallStyle(),
    this.ringPolicy = NativeRingPolicy.whenInBackground,
    this.appInForeground,
    this.pendingFor = const Duration(seconds: 45),
  }) : ui = ui ?? CallkitNativeUi();

  final CallioAgent agent;
  final NativeCallUi ui;
  final NativeCallStyle style;
  final NativeRingPolicy ringPolicy;

  /// For [NativeRingPolicy.whenInBackground]: is the app in front now?
  final bool Function()? appInForeground;

  /// How long a tap on the native screen waits for its call to arrive.
  final Duration pendingFor;

  final Map<String, String> _uuidByCall = {};     // callId → native uuid, for calls on the native screen
  final Map<String, _Pending> _pending = {};      // callId or uuid → an action waiting for its call
  final Set<String> _closedByUs = {};             // uuids this class ended (their echo is ignored)
  final List<StreamSubscription<Object?>> _subs = [];
  final Map<String, void Function()> _callListeners = {};
  final _errors = StreamController<Object>.broadcast();

  /// Failures applying a native action (e.g. accept failed); the call's own end reason tells the rest.
  Stream<Object> get onError => _errors.stream;

  /// Start mirroring. Also picks up a native Accept that launched the app.
  Future<void> attach() async {
    _subs.add(ui.actions.listen(_onNative));
    _subs.add(agent.onIncoming.listen(_onIncoming));
    _subs.add(agent.onCallEnded.listen((e) => _closeScreen(e.call)));
    for (final c in agent.ringingCalls) {
      _onIncoming(c);
    }
    // Cold start: the user accepted on the native screen, which launched the app.
    try {
      for (final shown in await ui.active()) {
        if (shown.accepted) _remember(NativeActionType.accept, shown.uuid, shown.callId.isEmpty ? null : shown.callId);
      }
    } catch (_) {/* the plugin isn't available (tests, desktop) */}
    agent.sync();
  }

  Future<void> detach() async {
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
    _callListeners.forEach((id, off) => agent.call(id)?.removeListener(off));
    _callListeners.clear();
  }

  /// Show an outbound call on the native call UI (optional; keeps the OS aware of the call).
  Future<void> reportOutgoing(CallioCall call) async {
    final uuid = call.callUuid ?? uuidForCall(call.id);
    _uuidByCall[call.id] = uuid;
    _watch(call, uuid);
    await ui.showOutgoing(NativeIncoming(uuid: uuid, callId: call.id, name: _name(call), handle: call.customer.address), style);
  }

  // ── Callio → native ─────────────────────────────────────────────────────────

  void _onIncoming(CallioCall call) {
    final uuid = call.callUuid ?? uuidForCall(call.id);
    final pending = _takePending(call.id, uuid);
    if (pending != null) {
      // The user already answered on the native screen: the screen is up.
      _uuidByCall[call.id] = uuid;
      _watch(call, uuid);
      _apply(pending.type, call, uuid);
      return;
    }
    final show = ringPolicy == NativeRingPolicy.always || !(appInForeground?.call() ?? false);
    if (!show) return;
    _uuidByCall[call.id] = uuid;
    _watch(call, uuid);
    ui.showIncoming(NativeIncoming(uuid: uuid, callId: call.id, name: _name(call), handle: call.customer.address), style)
        .catchError((Object err) => _errors.add(err));
  }

  // The call answered → the native call is connected (its timer runs, the OS
  // treats it as a call in progress).
  void _watch(CallioCall call, String uuid) {
    var connected = false;
    void listener() {
      if (!connected && call.state == CallState.active) {
        connected = true;
        ui.setConnected(uuid).catchError((Object err) => _errors.add(err));
      }
    }

    _callListeners[call.id] = listener;
    call.addListener(listener);
  }

  void _closeScreen(CallioCall call) {
    final off = _callListeners.remove(call.id);
    if (off != null) call.removeListener(off);
    final uuid = _uuidByCall.remove(call.id);
    if (uuid == null) return;
    _closedByUs.add(uuid);
    ui.end(uuid).catchError((Object err) => _errors.add(err));
  }

  // ── native → Callio ─────────────────────────────────────────────────────────

  void _onNative(NativeAction action) {
    if (_closedByUs.remove(action.uuid) && action.type != NativeActionType.accept) return;   // our own end, echoed
    final call = _callFor(action);
    if (call == null) {
      if (action.type == NativeActionType.accept || action.type == NativeActionType.decline) {
        _remember(action.type, action.uuid, action.callId);
        agent.sync();
      }
      return;
    }
    _apply(action.type, call, action.uuid);
  }

  void _apply(NativeActionType type, CallioCall call, String uuid) {
    switch (type) {
      case NativeActionType.accept:
        if (call.state != CallState.ringing) return;   // e.g. the OS echoing setConnected
        call.accept().catchError((Object err) {
          _errors.add(err);
        });
      case NativeActionType.decline:
        if (call.state == CallState.ringing) {
          call.decline();
        } else if (call.state != CallState.ended && call.state != CallState.elsewhere) {
          call.hangup();
        }
      case NativeActionType.ended:
        if (call.state == CallState.ringing) {
          call.decline();
        } else if (call.state != CallState.ended && call.state != CallState.elsewhere) {
          call.hangup();
        }
      case NativeActionType.timeout:
        break;   // Callio times the ring out itself (queue ring timeout / max wait)
    }
  }

  CallioCall? _callFor(NativeAction action) {
    if (action.callId != null) {
      final c = agent.call(action.callId!);
      if (c != null) return c;
    }
    for (final e in _uuidByCall.entries) {
      if (e.value == action.uuid) return agent.call(e.key);
    }
    for (final c in agent.calls) {
      if ((c.callUuid ?? uuidForCall(c.id)) == action.uuid) return c;
    }
    return null;
  }

  void _remember(NativeActionType type, String uuid, String? callId) {
    final p = _Pending(type, DateTime.now().add(pendingFor));
    _pending[uuid] = p;
    if (callId != null) _pending[callId] = p;
    // A call that is already known (e.g. rang before attach) gets it now.
    final call = (callId == null ? null : agent.call(callId)) ?? _callFor(NativeAction(type, uuid, callId));
    if (call != null && call.state == CallState.ringing) _onIncomingKnown(call, uuid);
  }

  void _onIncomingKnown(CallioCall call, String uuid) {
    final pending = _takePending(call.id, uuid);
    if (pending == null) return;
    _uuidByCall[call.id] = uuid;
    _watch(call, uuid);
    _apply(pending.type, call, uuid);
  }

  _Pending? _takePending(String callId, String uuid) {
    final now = DateTime.now();
    final p = _pending.remove(callId) ?? _pending.remove(uuid);
    _pending.removeWhere((_, v) => identical(v, p) || v.until.isBefore(now));
    return p != null && p.until.isAfter(now) ? p : null;
  }

  static String _name(CallioCall call) {
    final name = call.customer.name;
    return (name != null && name.isNotEmpty) ? name : (call.customer.address ?? 'Incoming call');
  }
}

class _Pending {
  _Pending(this.type, this.until);
  final NativeActionType type;
  final DateTime until;
}
