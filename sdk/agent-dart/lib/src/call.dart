// One call as this agent device sees it: its state, its WebRTC leg to Callio
// and the actions an agent takes on it. Created by CallioAgent.
//
// state:  ringing → connecting → active → ended
//         dialing (outbound, before the customer answers)
//         elsewhere (this agent's call, media on another device: switchHere)
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import 'agent.dart';
import 'models.dart';

/// No media within this long after setting up the leg counts as a failure.
const Duration _connectTimeout = Duration(seconds: 15);

/// Media recovery: this many reconnect attempts, then the call is given up.
const int _maxReconnects = 1;

class CallioCall extends ChangeNotifier {
  CallioCall.internal(this._agent, Map<String, dynamic> payload, this._state) : data = CallData(payload);

  final CallioAgent _agent;
  final CallData data;
  CallState _state;
  CallEnd? _end;
  bool _muted = false;
  rtc.RTCPeerConnection? _pc;
  rtc.MediaStream? _localStream;
  bool _ownsLocalStream = false;
  rtc.MediaStream? _remoteStream;
  bool _bound = false;
  bool _remoteSet = false;
  final List<Map<String, dynamic>> _pendingLocal = [];
  final List<Map<String, dynamic>> _pendingRemote = [];
  int _reconnects = 0;
  bool _recovering = false;
  bool _awaitingReconnect = false;
  bool _mediaConnected = false;
  bool _customerAnswered = false;
  Timer? _connectTimer;
  final _signals = StreamController<CallSignal>.broadcast();
  final _ended = Completer<CallEnd>();

  // ── What the call is ────────────────────────────────────────────────────────
  String get id => data.callId;
  CallState get state => _state;
  CallEnd? get endReason => _end;
  bool get muted => _muted;
  CallDirection get direction => data.direction;
  Customer get customer => data.customer;
  String? get callUuid => data.callUuid;
  rtc.MediaStream? get localStream => _localStream;

  /// The customer's audio (native platforms play it automatically).
  rtc.MediaStream? get remoteStream => _remoteStream;

  /// Offered to every member of a RING_ALL queue at once.
  bool get isRingAll => data.assignmentType == 'QUEUED' && data.agentId == null;

  /// DTMF, customer media, network warnings, supervisor mode, agent-private.
  Stream<CallSignal> get signals => _signals.stream;

  /// Completes when the call ends on this device.
  Future<CallEnd> get ended => _ended.future;

  // ── Agent actions ───────────────────────────────────────────────────────────

  /// Answer an offered call. [stream]: the microphone (default: CallioMedia.getMicrophone).
  Future<void> accept({rtc.MediaStream? stream}) async {
    if (_state != CallState.ringing) throw StateError('Cannot accept a call that is ${_state.name}');
    final offer = data.sdpOffer;
    if (offer == null) throw StateError('The call has no offer yet');
    _setState(CallState.connecting);
    try {
      // Candidates Callio sent while the call rang belong to this leg: keep them.
      final pc = await _newPeer(keepRemoteCandidates: true);
      await _attachMicrophone(pc, stream);
      await pc.setRemoteDescription(rtc.RTCSessionDescription(offer, 'offer'));
      _remoteSet = true;
      await _flushRemote();
      final answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      _agent.send('call:accept', {'callId': data.raw['callId'], 'sdpAnswer': answer.sdp});
      _markBound();
    } catch (err) {
      end('accept_failed', {'error': err.toString()});
      rethrow;
    }
  }

  /// Decline an offered call (in a queue it passes to the next agent).
  void decline() {
    if (_state != CallState.ringing) return;
    _agent.send('call:reject', {'callId': data.raw['callId']});
    end('declined');
  }

  /// Hang up (an outbound call not yet answered is cancelled).
  void hangup() {
    if (_state == CallState.ended) return;
    _agent.send(_state == CallState.dialing ? 'call:cancel' : 'call:terminate', {'callId': data.raw['callId']});
    end('hangup');
  }

  /// Mute or unmute the microphone (supervisors see it).
  void mute([bool muted = true]) {
    _muted = muted;
    for (final track in _localStream?.getAudioTracks() ?? const <rtc.MediaStreamTrack>[]) {
      track.enabled = !muted;
    }
    _agent.send('call:agent:muted', {'callId': data.raw['callId'], 'muted': muted});
    notifyListeners();
  }

  /// Transfer to an agent or into a queue (exactly one of them).
  void transfer({Object? agentId, Object? queueId}) {
    if ((agentId == null) == (queueId == null)) throw ArgumentError('transfer needs agentId or queueId');
    _agent.send('call:transfer', {
      'callId': data.raw['callId'],
      if (agentId != null) 'agentId': agentId,
      if (queueId != null) 'queueId': queueId,
    });
  }

  /// Talk privately to the monitoring supervisor (the customer can't hear).
  void setPrivate(bool active) => _agent.send('call:agent:private', {'callId': data.raw['callId'], 'active': active});

  /// Move a call that's active on another of your devices to this one.
  Future<void> switchHere({rtc.MediaStream? stream}) async {
    if (_state != CallState.elsewhere) throw StateError('Cannot switch a call that is ${_state.name}');
    await reconnect('other_device', stream: stream);
  }

  // ── Media ───────────────────────────────────────────────────────────────────

  /// A new leg. Callio's buffered candidates are for the previous leg and are
  /// dropped — except on accept, where they arrived for this one while ringing.
  Future<rtc.RTCPeerConnection> _newPeer({bool keepRemoteCandidates = false}) async {
    await _closePeer();
    final pc = await _agent.media.createPeerConnection({'iceServers': _agent.iceServers});
    _pc = pc;
    _bound = false;
    _remoteSet = false;
    _pendingLocal.clear();
    if (!keepRemoteCandidates) _pendingRemote.clear();

    pc.onIceCandidate = (candidate) {
      if (!identical(pc, _pc) || candidate.candidate == null) return;
      final c = {'candidate': candidate.candidate, 'sdpMid': candidate.sdpMid, 'sdpMLineIndex': candidate.sdpMLineIndex};
      if (_bound) {
        _sendCandidate(c);
      } else {
        _pendingLocal.add(c);
      }
    };
    pc.onTrack = (event) {
      if (!identical(pc, _pc)) return;
      _remoteStream = event.streams.isNotEmpty ? event.streams.first : _remoteStream;
      notifyListeners();
    };
    pc.onConnectionState = (s) {
      if (!identical(pc, _pc)) return;
      if (s == rtc.RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _connectTimer?.cancel();
        _reconnects = 0;
        _mediaConnected = true;
        if (_state == CallState.connecting || (_state == CallState.dialing && _customerAnswered)) _setState(CallState.active);
      } else if (s == rtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _mediaFailed('ice_failure');
      }
    };
    _connectTimer?.cancel();
    _connectTimer = Timer(_connectTimeout, () {
      if (identical(pc, _pc) && !_mediaConnected) _mediaFailed('ice_failure');
    });
    _mediaConnected = false;
    return pc;
  }

  Future<void> _attachMicrophone(rtc.RTCPeerConnection pc, rtc.MediaStream? stream) async {
    final current = _localStream;
    if (current == null || current.getAudioTracks().isEmpty) {
      _ownsLocalStream = stream == null;
      _localStream = stream ?? await _agent.media.getMicrophone();
    }
    final local = _localStream!;
    for (final track in local.getAudioTracks()) {
      track.enabled = !_muted;
      await pc.addTrack(track, local);
    }
  }

  void _markBound() {
    _bound = true;
    for (final c in List.of(_pendingLocal)) {
      _sendCandidate(c);
    }
    _pendingLocal.clear();
  }

  void _sendCandidate(Map<String, dynamic> candidate) =>
      _agent.send('connection:ice-candidate', {'callId': data.raw['callId'], 'candidate': candidate, 'connectionType': 'AGENT'});

  /// Callio's ICE candidate for this leg.
  Future<void> onServerCandidate(Object? candidate) async {
    final c = _candidateMap(candidate);
    if (c == null) return;
    if (_pc != null && _remoteSet) {
      await _addCandidate(c);
    } else {
      _pendingRemote.add(c);
    }
  }

  Future<void> _flushRemote() async {
    for (final c in List.of(_pendingRemote)) {
      await _addCandidate(c);
    }
    _pendingRemote.clear();
  }

  Future<void> _addCandidate(Map<String, dynamic> c) async {
    try {
      await _pc?.addCandidate(rtc.RTCIceCandidate(c['candidate'] as String?, c['sdpMid'] as String?, (c['sdpMLineIndex'] as num?)?.toInt()));
    } catch (_) {/* a late or unusable candidate */}
  }

  Future<void> _mediaFailed(String trigger) async {
    if (_state == CallState.ended || _state == CallState.elsewhere || _recovering) return;
    if (_reconnects >= _maxReconnects) {
      _agent.send('call:terminate', {'callId': data.raw['callId'], 'reason': 'system_failed'});
      end('media_failed');
      return;
    }
    _reconnects++;
    try {
      await reconnect(trigger);
    } catch (err) {
      end('media_failed', {'error': err.toString()});
    }
  }

  /// A new leg for the same call (network change, app restart, another device).
  Future<void> reconnect(String trigger, {rtc.MediaStream? stream}) async {
    _recovering = true;
    try {
      _setState(CallState.connecting);
      final pc = await _newPeer();
      await _attachMicrophone(pc, stream);
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      _awaitingReconnect = true;
      _agent.send('call:reconnect', {'callId': data.raw['callId'], 'sdpOffer': offer.sdp, 'reconnectTrigger': trigger});
      _markBound();
    } finally {
      _recovering = false;
    }
  }

  Future<void> onReconnected(Map<String, dynamic> payload) async {
    final pc = _pc;
    if (!_awaitingReconnect || pc == null) return;
    _awaitingReconnect = false;
    await pc.setRemoteDescription(rtc.RTCSessionDescription(payload['sdpAnswer'] as String?, 'answer'));
    _remoteSet = true;
    await _flushRemote();
  }

  /// Outbound: the agent connects its leg first; Callio then dials the customer.
  Future<void> start({rtc.MediaStream? stream}) async {
    final pc = await _newPeer();
    await _attachMicrophone(pc, stream);
    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _agent.send('call:start', {'callId': data.raw['callId'], 'sdpOffer': offer.sdp});
    _markBound();
  }

  Future<void> onStarted(Map<String, dynamic> payload) async {
    update(payload);
    final answer = payload['sdpAnswer'] as String?;
    final pc = _pc;
    if (answer != null && pc != null && !_remoteSet) {
      await pc.setRemoteDescription(rtc.RTCSessionDescription(answer, 'answer'));
      _remoteSet = true;
      await _flushRemote();
    }
  }

  /// The customer answered an outbound call.
  void customerAnswered() {
    _customerAnswered = true;
    if (_state == CallState.dialing && _mediaConnected) _setState(CallState.active);
  }

  /// Another device of ours took the call's media.
  Future<void> superseded() async {
    await _closePeer();
    _setState(CallState.elsewhere);
  }

  // ── Bookkeeping (used by CallioAgent) ─────────────────────────────────────

  void update(Map<String, dynamic> payload) {
    data.merge(payload);
    notifyListeners();
  }

  void signal(CallSignal s) {
    if (!_signals.isClosed) _signals.add(s);
  }

  void _setState(CallState next) {
    if (_state == next || _state == CallState.ended) return;
    final previous = _state;
    _state = next;
    notifyListeners();
    _agent.callStateChanged(this, next, previous);
  }

  Future<void> _closePeer() async {
    _connectTimer?.cancel();
    final pc = _pc;
    _pc = null;
    if (pc != null) {
      try {
        await pc.close();
      } catch (_) {/* already closed */}
    }
  }

  void closeMedia() => _closePeer();

  void end(String reason, [Map<String, dynamic>? details]) {
    if (_state == CallState.ended) return;
    _closePeer();
    if (_ownsLocalStream) {
      for (final t in _localStream?.getTracks() ?? const <rtc.MediaStreamTrack>[]) {
        t.stop();
      }
    }
    _end = CallEnd(reason, details);
    _state = CallState.ended;
    notifyListeners();
    if (!_ended.isCompleted) _ended.complete(_end);
    _signals.close();
    _agent.forget(this, _end!);
  }
}

Map<String, dynamic>? _candidateMap(Object? candidate) {
  if (candidate is Map) return Map<String, dynamic>.from(candidate);
  if (candidate is String) return {'candidate': candidate, 'sdpMid': null, 'sdpMLineIndex': 0};
  return null;
}
