// Test doubles: a scripted gateway (FakeTransport) and WebRTC objects
// (FakeMedia) — enough to drive CallioAgent through the protocol without a
// network or a device.
import 'package:callio_agent/callio_agent.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class Emitted {
  Emitted(this.event, this.payload);
  final String event;
  final dynamic payload;
  Map<String, dynamic> get map => payload is Map ? Map<String, dynamic>.from(payload as Map) : {};
  @override
  String toString() => '$event $payload';
}

class FakeTransport implements CallioTransport {
  final Map<String, List<TransportHandler>> _handlers = {};
  final List<Emitted> emitted = [];
  Map<String, dynamic>? lastAuth;
  bool _connected = false;
  bool closed = false;

  @override
  void connect(Future<Map<String, dynamic>> Function() auth) {
    auth().then((a) => lastAuth = a);
    _connected = true;
  }

  @override
  void emit(String event, [Object? payload]) => emitted.add(Emitted(event, payload));

  @override
  void on(String event, TransportHandler handler) => (_handlers[event] ??= []).add(handler);

  @override
  bool get connected => _connected;

  @override
  void close() {
    closed = true;
    _connected = false;
  }

  /// The gateway sends an event.
  void server(String event, [Object? payload]) {
    for (final h in List.of(_handlers[event] ?? const <TransportHandler>[])) {
      h(payload);
    }
  }

  List<Emitted> sent(String event) => [for (final e in emitted) if (e.event == event) e];
  Emitted? last(String event) {
    final all = sent(event);
    return all.isEmpty ? null : all.last;
  }
}

class FakeTrack extends Fake implements MediaStreamTrack {
  FakeTrack(this._id);
  final String _id;
  bool _enabled = true;
  bool stopped = false;
  @override
  String? get id => _id;
  @override
  String? get kind => 'audio';
  @override
  bool get enabled => _enabled;
  @override
  set enabled(bool value) => _enabled = value;
  @override
  Future<void> stop() async => stopped = true;
}

class FakeStream extends Fake implements MediaStream {
  FakeStream(this._id, [List<FakeTrack>? tracks]) : tracks = tracks ?? [FakeTrack('$_id-audio')];
  final String _id;
  final List<FakeTrack> tracks;
  @override
  String get id => _id;
  @override
  List<MediaStreamTrack> getAudioTracks() => tracks;
  @override
  List<MediaStreamTrack> getTracks() => tracks;
}

class FakeTransceiver extends Fake implements RTCRtpTransceiver {
  FakeTransceiver(this._mid);
  final String _mid;
  @override
  String get mid => _mid;
}

class FakePeer extends Fake implements RTCPeerConnection {
  FakePeer(this.index);
  final int index;
  RTCSessionDescription? remote;
  RTCSessionDescription? local;
  final List<RTCIceCandidate> candidates = [];
  final List<MediaStreamTrack> added = [];
  final List<FakeTransceiver> lines = [];
  bool isClosed = false;

  @override
  Function(RTCIceCandidate candidate)? onIceCandidate;
  @override
  Function(RTCTrackEvent event)? onTrack;
  @override
  Function(RTCPeerConnectionState state)? onConnectionState;

  @override
  Future<void> setRemoteDescription(RTCSessionDescription description) async => remote = description;
  @override
  Future<void> setLocalDescription(RTCSessionDescription description) async => local = description;
  @override
  Future<RTCSessionDescription> createAnswer([Map<String, dynamic>? constraints]) async => RTCSessionDescription('answer-$index', 'answer');
  @override
  Future<RTCSessionDescription> createOffer([Map<String, dynamic>? constraints]) async => RTCSessionDescription('offer-$index', 'offer');
  @override
  Future<RTCRtpSender> addTrack(MediaStreamTrack track, [MediaStream? stream]) async {
    added.add(track);
    return FakeSender();
  }

  @override
  Future<RTCRtpTransceiver> addTransceiver({MediaStreamTrack? track, RTCRtpMediaType? kind, RTCRtpTransceiverInit? init}) async {
    final t = FakeTransceiver('${lines.length}');
    lines.add(t);
    return t;
  }

  @override
  Future<List<RTCRtpTransceiver>> getTransceivers() async => lines;
  @override
  Future<void> addCandidate(RTCIceCandidate candidate) async => candidates.add(candidate);
  @override
  Future<void> close() async => isClosed = true;

  // Test controls.
  void gather(String candidate) => onIceCandidate?.call(RTCIceCandidate(candidate, '0', 0));
  void connected() => onConnectionState?.call(RTCPeerConnectionState.RTCPeerConnectionStateConnected);
  void failed() => onConnectionState?.call(RTCPeerConnectionState.RTCPeerConnectionStateFailed);
  void track(FakeStream stream, {String? mid}) =>
      onTrack?.call(RTCTrackEvent(streams: [stream], track: stream.tracks.first, transceiver: mid == null ? null : FakeTransceiver(mid)));
}

class FakeSender extends Fake implements RTCRtpSender {}

class FakeMedia implements CallioMedia {
  final List<FakePeer> peers = [];
  final List<Map<String, dynamic>> configurations = [];
  int microphones = 0;

  FakePeer get lastPeer => peers.last;

  @override
  Future<RTCPeerConnection> createPeerConnection(Map<String, dynamic> configuration) async {
    configurations.add(configuration);
    final p = FakePeer(peers.length);
    peers.add(p);
    return p;
  }

  @override
  Future<MediaStream> getMicrophone() async => FakeStream('mic-${microphones++}');
}

/// session:ready for an agent.
Map<String, dynamic> session({String id = '7', String role = 'AGENT', String? expiresAt, String deviceId = 'dev-1'}) => {
      'protocol': 1,
      'agent': {'id': int.parse(id), 'ref': 'agent-$id', 'name': 'Agent $id', 'role': role},
      'tenant': {'id': 1, 'ref': 'demo'},
      'deviceId': deviceId,
      'iceServers': [
        {'urls': 'stun:stun.example.org'}
      ],
      'iceServersExpireAt': expiresAt,
    };

/// A call payload (call:incoming / calls:list).
Map<String, dynamic> callPayload(int id, {Object? agentId = 7, List<int>? offered, String status = 'RINGING', String? deviceId, bool sdp = true, String direction = 'INBOUND'}) => {
      'callId': id,
      'callUuid': '00000000-0000-0000-0000-${id.toString().padLeft(12, '0')}',
      'channel': 'WHATSAPP',
      'direction': direction,
      'status': status,
      'customer': {'address': '+9611234567', 'addressType': 'E164', 'name': 'Customer'},
      'agentId': agentId,
      'offeredAgentIds': offered ?? (agentId == null ? <Object>[] : <Object>[agentId]),
      'assignmentType': agentId == null ? 'QUEUED' : 'DIRECT',
      if (deviceId != null) 'deviceId': deviceId,
      if (sdp) 'sdpOffer': 'server-offer-$id',
    };

/// Let queued microtasks and async handlers run.
Future<void> settle() => Future<void>.delayed(Duration.zero).then((_) => Future<void>.delayed(Duration.zero));
