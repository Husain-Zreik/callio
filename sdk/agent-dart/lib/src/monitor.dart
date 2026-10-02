// A supervisor listening to a call (docs/agent-protocol.md, Monitoring).
// Created by CallioAgent.monitor().
//
// One audio line: it sends the supervisor's microphone and receives the call
// — the customer and the agent, mixed by Callio. A direct call (no room to mix
// in) is listen-only: Callio offers one line per side and we answer. Callio
// decides who hears the supervisor, so a mode change needs no renegotiation:
//   listen   the supervisor hears the call; nobody hears the supervisor
//   whisper  the agent hears the supervisor; the customer doesn't
//   barge    both hear the supervisor
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import 'agent.dart';
import 'models.dart';

const Duration _connectTimeout = Duration(seconds: 15);

class CallioMonitor extends ChangeNotifier {
  CallioMonitor.internal(this._agent, this.callId);

  final CallioAgent _agent;
  final String callId;
  MonitorState _state = MonitorState.connecting;
  MonitorMode _mode = MonitorMode.listen;
  bool _muted = false;
  String? _endReason;
  rtc.RTCPeerConnection? _pc;
  rtc.MediaStream? _localStream;
  bool _ownsLocalStream = false;
  rtc.MediaStream? _stream;
  bool _remoteSet = false;
  bool _direct = false;
  final List<Map<String, dynamic>> _pendingRemote = [];
  Timer? _timer;
  final _ended = Completer<String>();

  MonitorState get state => _state;
  MonitorMode get mode => _mode;
  bool get muted => _muted;
  String? get endReason => _endReason;
  /// The call as the supervisor hears it: the customer and the agent, mixed.
  rtc.MediaStream? get stream => _stream;

  /// Completes with the reason: stopped, ended, call_ended, disconnected, failed, closed.
  Future<String> get ended => _ended.future;

  void setMode(MonitorMode mode) {
    if (_state == MonitorState.ended) return;
    _agent.send('call:monitor:mode', {'callId': callId, 'mode': mode.name});
  }

  /// Mute the supervisor's microphone (whisper / barge).
  void mute([bool muted = true]) {
    _muted = muted;
    for (final t in _localStream?.getAudioTracks() ?? const <rtc.MediaStreamTrack>[]) {
      t.enabled = !muted;
    }
    notifyListeners();
  }

  void stop() {
    if (_state == MonitorState.ended) return;
    _agent.send('call:monitor:stop', {'callId': callId});
    end('stopped');
  }

  // ── Internals (CallioAgent) ─────────────────────────────────────────────────

  Future<void> start({rtc.MediaStream? stream}) async {
    final pc = await _agent.media.createPeerConnection({'iceServers': _agent.iceServers});
    _pc = pc;
    // A direct call is listened to by answering Callio's offer, without the microphone.
    _direct = _agent.board.any((c) => c.callId == callId && c.isDirect);
    if (!_direct) {
      _ownsLocalStream = stream == null;
      final local = stream ?? await _agent.media.getMicrophone();
      _localStream = local;
      final tracks = local.getAudioTracks();
      final sendLine = rtc.RTCRtpTransceiverInit(direction: rtc.TransceiverDirection.SendRecv, streams: [local]);
      if (tracks.isEmpty) {
        await pc.addTransceiver(kind: rtc.RTCRtpMediaType.RTCRtpMediaTypeAudio, init: sendLine);
      } else {
        await pc.addTransceiver(track: tracks.first, kind: rtc.RTCRtpMediaType.RTCRtpMediaTypeAudio, init: sendLine);
      }
    }

    pc.onIceCandidate = (c) {
      if (!identical(pc, _pc) || c.candidate == null) return;
      _agent.send('connection:ice-candidate', {
        'callId': callId,
        'connectionType': 'MONITOR',
        'candidate': {'candidate': c.candidate, 'sdpMid': c.sdpMid, 'sdpMLineIndex': c.sdpMLineIndex},
      });
    };
    pc.onTrack = (event) {
      if (!identical(pc, _pc)) return;
      final stream = event.streams.isNotEmpty ? event.streams.first : null;
      if (stream == null) return;
      _stream = stream;
      notifyListeners();
    };
    pc.onConnectionState = (s) {
      if (!identical(pc, _pc)) return;
      if (s == rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _timer?.cancel();
        _setState(MonitorState.active);
      } else if (s == rtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        stop();
      }
    };
    _timer = Timer(_connectTimeout, () {
      if (_state == MonitorState.connecting) stop();
    });

    if (_direct) {
      _agent.send('call:monitor', {'callId': callId});
      return;
    }
    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _agent.send('call:monitor', {'callId': callId, 'sdpOffer': offer.sdp});
  }

  /// Callio's offer, for a monitor started without one (a direct call).
  Future<void> onOffer(Map<String, dynamic> payload) async {
    final pc = _pc;
    if (pc == null || _remoteSet) return;
    await pc.setRemoteDescription(rtc.RTCSessionDescription(payload['sdpOffer'] as String?, 'offer'));
    _remoteSet = true;
    for (final c in List.of(_pendingRemote)) {
      await _add(c);
    }
    _pendingRemote.clear();
    final answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    _agent.send('call:monitor:answer', {'callId': callId, 'sdpAnswer': answer.sdp});
  }

  Future<void> onStarted(Map<String, dynamic> payload) async {
    final pc = _pc;
    if (pc == null || _remoteSet || payload['sdpAnswer'] == null) return;
    await pc.setRemoteDescription(rtc.RTCSessionDescription(payload['sdpAnswer'] as String?, 'answer'));
    _remoteSet = true;
    for (final c in List.of(_pendingRemote)) {
      await _add(c);
    }
    _pendingRemote.clear();
  }

  Future<void> onServerCandidate(Object? candidate) async {
    if (candidate is! Map) return;
    final c = Map<String, dynamic>.from(candidate);
    if (_pc != null && _remoteSet) {
      await _add(c);
    } else {
      _pendingRemote.add(c);
    }
  }

  Future<void> _add(Map<String, dynamic> c) async {
    try {
      await _pc?.addCandidate(rtc.RTCIceCandidate(c['candidate'] as String?, c['sdpMid'] as String?, (c['sdpMLineIndex'] as num?)?.toInt()));
    } catch (_) {/* unusable candidate */}
  }

  void onMode(MonitorMode? mode) {
    if (mode == null || mode == _mode) return;
    _mode = mode;
    notifyListeners();
  }

  void _setState(MonitorState next) {
    if (_state == next || _state == MonitorState.ended) return;
    _state = next;
    notifyListeners();
  }

  void end(String reason) {
    if (_state == MonitorState.ended) return;
    _timer?.cancel();
    final pc = _pc;
    _pc = null;
    pc?.close();
    if (_ownsLocalStream) {
      for (final t in _localStream?.getTracks() ?? const <rtc.MediaStreamTrack>[]) {
        t.stop();
      }
    }
    _state = MonitorState.ended;
    _endReason = reason;
    notifyListeners();
    if (!_ended.isCompleted) _ended.complete(reason);
    _agent.forgetMonitor(this);
  }
}
