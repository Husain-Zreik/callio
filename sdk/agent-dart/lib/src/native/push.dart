// Callio's call pushes (docs/agent-protocol.md, Push), as the app receives
// them: FCM data messages (Android; values are strings) and APNs VoIP
// payloads (iOS, PushKit). Pushes never carry SDP — the app connects, and the
// SDK answers from calls:list.

enum CallioPushType {
  /// A call is ringing for this agent: show the native call screen.
  incoming,

  /// The call was answered elsewhere, withdrawn or ended: dismiss it.
  cancelled,

  /// iOS only: the visible banner sent next to the VoIP push.
  alert,
}

class CallioPush {
  CallioPush({required this.type, required this.callId, this.callUuid, this.tenantId, this.channel, this.customerName, this.customerAddress, required this.raw});

  final CallioPushType type;
  final String callId;

  /// The native call UI id (CallKit / ConnectionService), stable per call.
  final String? callUuid;
  final String? tenantId;
  final String? channel;
  final String? customerName;
  final String? customerAddress;
  final Map<String, dynamic> raw;

  /// What to show as the caller.
  String get displayName => (customerName?.isNotEmpty ?? false) ? customerName! : (customerAddress ?? 'Incoming call');

  /// The native UI id: Callio's callUuid, or the same UUID shape derived from the call id.
  String get uuid => callUuid ?? uuidForCall(callId);

  /// A Callio call push, or null for anything else (chat messages, …).
  static CallioPush? parse(Map<dynamic, dynamic> data) {
    final d = {for (final e in data.entries) '${e.key}': e.value};
    final type = switch (d['type']?.toString()) {
      'call.incoming' => CallioPushType.incoming,
      'call.cancelled' => CallioPushType.cancelled,
      'call.incoming.alert' => CallioPushType.alert,
      _ => null,
    };
    final callId = d['call_id']?.toString() ?? d['callId']?.toString();
    if (type == null || callId == null || callId.isEmpty) return null;
    String? s(List<String> keys) {
      for (final k in keys) {
        final v = d[k];
        if (v != null && '$v'.isNotEmpty) return '$v';
      }
      return null;
    }

    return CallioPush(
      type: type,
      callId: callId,
      callUuid: s(['call_uuid', 'id']),
      tenantId: s(['tenant_id']),
      channel: s(['channel']),
      customerName: s(['customer_name', 'nameCaller']),
      customerAddress: s(['customer_address', 'handle']),
      raw: Map<String, dynamic>.from(d),
    );
  }
}

/// Callio's callUuid shape for a call id — only a fallback when a payload
/// has no callUuid; Callio sends it with every call and push.
String uuidForCall(String callId) => '00000000-0000-0000-0000-${callId.padLeft(12, '0')}';
