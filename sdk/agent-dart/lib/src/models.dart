// The shapes Callio's agent protocol carries (docs/agent-protocol.md).
// Payloads stay available raw (`raw`); typed getters cover what apps use.

/// What a call is to this device.
enum CallState {
  /// Offered to this agent: accept or decline.
  ringing,

  /// An outbound call this agent started; the customer isn't connected yet.
  dialing,

  /// Accepted / reconnecting: media is being set up.
  connecting,

  /// Media connected.
  active,

  /// This agent's call, with its media on another of their devices (switchHere).
  elsewhere,

  /// Over — see `CallioCall.endReason`.
  ended,
}

enum CallDirection { inbound, outbound }

enum Availability { available, onCall, offline }

enum MonitorMode { listen, whisper, barge }

enum MonitorState { connecting, active, ended }

/// The agent's connection to Callio.
enum ConnectionStatus { connecting, ready, reconnecting, closed }

Availability? availabilityFrom(Object? value) => switch (value) {
      'AVAILABLE' => Availability.available,
      'ON_CALL' => Availability.onCall,
      'OFFLINE' => Availability.offline,
      _ => null,
    };

String availabilityWire(Availability value) => switch (value) {
      Availability.available => 'AVAILABLE',
      Availability.onCall => 'ON_CALL',
      Availability.offline => 'OFFLINE',
    };

MonitorMode? monitorModeFrom(Object? value) => switch (value) {
      'listen' => MonitorMode.listen,
      'whisper' => MonitorMode.whisper,
      'barge' => MonitorMode.barge,
      _ => null,
    };

/// Ids arrive as numbers or strings; compare and key them as strings.
String idOf(Object? value) => value == null ? '' : (value is double && value == value.roundToDouble() ? value.toInt().toString() : value.toString());

class CallioIdentity {
  CallioIdentity(this.raw);
  final Map<String, dynamic> raw;
  String get id => idOf(raw['id']);
  String? get ref => raw['ref'] as String?;
  String? get name => raw['name'] as String?;
  String? get role => raw['role'] as String?;
  bool get isSupervisor => role == 'SUPERVISOR';
}

/// session:ready — who this agent is and the ICE servers to use.
class CallioSession {
  CallioSession(this.raw);
  final Map<String, dynamic> raw;
  CallioIdentity get agent => CallioIdentity(Map<String, dynamic>.from(raw['agent'] as Map? ?? {}));
  Map<String, dynamic> get tenant => Map<String, dynamic>.from(raw['tenant'] as Map? ?? {});
  String? get deviceId => raw['deviceId'] as String?;
  List<Map<String, dynamic>> get iceServers =>
      [for (final s in (raw['iceServers'] as List? ?? const [])) Map<String, dynamic>.from(s as Map)];

  /// When TURN credentials expire (the SDK refreshes before that); null for static ones.
  DateTime? get iceServersExpireAt => DateTime.tryParse(raw['iceServersExpireAt']?.toString() ?? '');
}

class Customer {
  Customer(this.raw);
  final Map<String, dynamic> raw;
  String? get address => raw['address'] as String?;

  /// E164, WHATSAPP_USER or SIP_URI.
  String? get addressType => raw['addressType'] as String?;
  String? get name => raw['name'] as String?;
}

/// The call payload shared by call:incoming, call:started and calls:list,
/// also used for board entries (without SDP).
class CallData {
  CallData(Map<String, dynamic> raw) : raw = Map<String, dynamic>.from(raw);
  final Map<String, dynamic> raw;

  String get callId => idOf(raw['callId']);

  /// Stable UUID-shaped id for native call UIs (CallKit, ConnectionService).
  String? get callUuid => raw['callUuid'] as String?;
  String? get channel => raw['channel'] as String?;
  String? get status => raw['status'] as String?;
  CallDirection get direction => raw['direction'] == 'OUTBOUND' ? CallDirection.outbound : CallDirection.inbound;
  Customer get customer => Customer(Map<String, dynamic>.from(raw['customer'] as Map? ?? {}));
  String? get agentId => raw['agentId'] == null ? null : idOf(raw['agentId']);
  String? get agentName => raw['agentName'] as String?;
  String? get queueId => raw['queueId'] == null ? null : idOf(raw['queueId']);
  String? get assignmentType => raw['assignmentType'] as String?;

  /// A direct call: rtpengine alone carries it (a personal line's 1:1 call).
  /// It reconnects by answering Callio's offer; supervisors can only listen.
  bool get isDirect => raw['mediaTopology'] == 'DIRECT';
  List<String> get offeredAgentIds => [for (final id in (raw['offeredAgentIds'] as List? ?? const [])) idOf(id)];
  String? get deviceId => raw['deviceId'] as String?;
  String? get sdpOffer => raw['sdpOffer'] as String?;
  DateTime? get ringingAt => DateTime.tryParse(raw['ringingAt']?.toString() ?? '');
  DateTime? get answeredAt => DateTime.tryParse(raw['answeredAt']?.toString() ?? '');
  Map<String, dynamic>? get transferredFrom => raw['transferredFrom'] is Map ? Map<String, dynamic>.from(raw['transferredFrom'] as Map) : null;

  /// Board entries: the live IVR position, or null.
  Map<String, dynamic>? get ivr => raw['ivr'] is Map ? Map<String, dynamic>.from(raw['ivr'] as Map) : null;

  /// Merge fields that are present (null values in `patch` don't erase).
  void merge(Map<String, dynamic> patch) {
    patch.forEach((k, v) {
      if (v != null || k == 'ivr') raw[k] = v;
    });
  }
}

class QueueSnapshot {
  QueueSnapshot(this.raw);
  final Map<String, dynamic> raw;
  String get queueId => idOf(raw['queueId']);
  String? get queueName => raw['queueName'] as String?;
  String? get strategy => raw['strategy'] as String?;
}

class TeamMember {
  TeamMember({required this.agentId, required this.availability, this.reason, this.updatedAt});
  final String agentId;
  final Availability? availability;
  final String? reason;
  final String? updatedAt;
}

/// call:error — see docs/agent-protocol.md, Errors.
class CallioError implements Exception {
  CallioError({this.callId, required this.code, required this.message});
  final String? callId;
  final String code;
  final String message;
  @override
  String toString() => 'CallioError($code${callId == null ? '' : ', call $callId'}): $message';
}

/// Why a call ended on this device.
class CallEnd {
  CallEnd(this.reason, [Map<String, dynamic>? details]) : details = details ?? const {};

  /// hangup, declined, withdrawn, answered_elsewhere, terminated, gone,
  /// accept_failed, media_failed, error.
  final String reason;
  final Map<String, dynamic> details;
  String? get terminationReason => details['terminationReason'] as String?;
  String? get terminatedBy => details['terminatedBy'] as String?;
  String? get withdrawnReason => details['withdrawnReason'] as String?;
  @override
  String toString() => 'CallEnd($reason${details.isEmpty ? '' : ' $details'})';
}

/// In-call signals from Callio.
sealed class CallSignal {
  const CallSignal();
}

/// A key the customer pressed.
class DtmfSignal extends CallSignal {
  const DtmfSignal(this.digit);
  final String digit;
}

/// The customer's audio: 'active' or 'drop'.
class CustomerMediaSignal extends CallSignal {
  const CustomerMediaSignal(this.state);
  final String state;
}

/// The customer's audio has been gone long enough that Callio will end the call.
class NetworkTerminatingSignal extends CallSignal {
  const NetworkTerminatingSignal();
}

/// A supervisor's monitoring mode on this call.
class SupervisorModeSignal extends CallSignal {
  const SupervisorModeSignal(this.mode);
  final MonitorMode? mode;
}

/// The agent-private (talk to supervisor only) state changed.
class PrivateChangedSignal extends CallSignal {
  const PrivateChangedSignal(this.active);
  final bool active;
}
