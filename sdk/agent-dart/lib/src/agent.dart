// An agent's connection to Callio's agent gateway (docs/agent-protocol.md):
// the socket, the agent's identity and ICE servers (session:ready),
// availability, queues, this agent's calls — kept right across reconnects by
// resyncing from calls:list on every (re)connect. Supervisors also get the
// tenant's live calls (board) and monitoring.
//
// It's a ChangeNotifier (status, availability, calls, queues, team, board) for
// Provider & co., plus streams for one-off events (incoming, callEnded, …).
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import 'call.dart';
import 'media.dart';
import 'models.dart';
import 'monitor.dart';
import 'transport.dart';

const int _protocol = 1;
const _terminal = {'TERMINATED', 'FAILED', 'CANCELLED'};
// Call errors after which the call can't go on here.
const _endingErrors = {'ACCEPT_FAILED', 'CALL_ALREADY_ENDED', 'AGENT_MEDIA_NOT_READY', 'CALL_INITIATION_FAILED', 'PROVIDER_TRIGGER_FAILED'};
// ICE/TURN credentials are refreshed at this share of their lifetime, never sooner than _minRefresh.
const double _refreshAt = 0.8;
const Duration _minRefresh = Duration(minutes: 1);

typedef TokenProvider = FutureOr<String> Function();

class CallEnded {
  CallEnded(this.call, this.end);
  final CallioCall call;
  final CallEnd end;
}

class CallStateChange {
  CallStateChange(this.call, this.state, this.previous);
  final CallioCall call;
  final CallState state;
  final CallState previous;
}

class BoardCallEnded {
  BoardCallEnded(this.call, this.terminationReason, this.terminatedBy);
  final CallData call;
  final String? terminationReason;
  final String? terminatedBy;
}

class CallioAgent extends ChangeNotifier {
  /// [deviceId]: a stable id for this installation (keep it in secure storage).
  /// [token] or [getToken]: the agent JWT — getToken is called on every
  /// (re)connect, since agent tokens are short-lived.
  CallioAgent({
    required this.url,
    required this.deviceId,
    String? token,
    TokenProvider? getToken,
    CallioMedia? media,
    CallioTransport? transport,
  })  : assert(token != null || getToken != null, 'token or getToken is required'),
        media = media ?? const FlutterWebrtcMedia(),
        _transport = transport ?? SocketIoTransport(url),
        _getToken = getToken ?? (() => token!) {
    _listen();
    _transport.connect(() async => {'token': await _getToken(), 'device_id': deviceId, 'protocol': _protocol});
  }

  /// Connects and completes once Callio has identified the agent (session:ready).
  static Future<CallioAgent> connect({
    required String url,
    required String deviceId,
    String? token,
    TokenProvider? getToken,
    CallioMedia? media,
    CallioTransport? transport,
  }) async {
    final agent = CallioAgent(url: url, deviceId: deviceId, token: token, getToken: getToken, media: media, transport: transport);
    await agent.ready;
    return agent;
  }

  final String url;
  final String deviceId;
  final CallioMedia media;
  final CallioTransport _transport;
  final TokenProvider _getToken;

  final _ready = Completer<CallioAgent>();
  ConnectionStatus _status = ConnectionStatus.connecting;
  CallioSession? _session;
  Availability? _availability;
  bool _refreshing = false;
  Timer? _refreshTimer;

  final Map<String, CallioCall> _calls = {};
  final Map<String, QueueSnapshot> _queues = {};
  final Map<String, TeamMember> _team = {};
  final Map<String, CallData> _board = {};
  final Map<String, CallioMonitor> _monitors = {};
  final Set<String> _resolved = {};

  final _incoming = StreamController<CallioCall>.broadcast();
  final _elsewhere = StreamController<CallioCall>.broadcast();
  final _callEnded = StreamController<CallEnded>.broadcast();
  final _callStates = StreamController<CallStateChange>.broadcast();
  final _errors = StreamController<Object>.broadcast();
  final _boardEnded = StreamController<BoardCallEnded>.broadcast();

  // ── State ─────────────────────────────────────────────────────────────────

  Future<CallioAgent> get ready => _ready.future;
  ConnectionStatus get status => _status;
  CallioSession? get session => _session;
  CallioIdentity? get me => _session?.agent;
  bool get isSupervisor => me?.isSupervisor ?? false;
  Availability? get availability => _availability;
  List<Map<String, dynamic>> get iceServers => _session?.iceServers ?? const [];

  /// This agent's calls.
  List<CallioCall> get calls => List.unmodifiable(_calls.values);
  CallioCall? call(Object callId) => _calls[idOf(callId)];
  List<CallioCall> get ringingCalls => [for (final c in _calls.values) if (c.state == CallState.ringing) c];

  /// The call being set up, on, or dialing — or null.
  CallioCall? get activeCall {
    for (final c in _calls.values) {
      if (c.state == CallState.connecting || c.state == CallState.active || c.state == CallState.dialing) return c;
    }
    return null;
  }

  List<QueueSnapshot> get queues => List.unmodifiable(_queues.values);

  /// Availability of the tenant's agents, as it changes.
  List<TeamMember> get team => List.unmodifiable(_team.values);

  /// Supervisors: the tenant's live calls.
  List<CallData> get board => List.unmodifiable(_board.values);
  CallioMonitor? monitorOf(Object callId) => _monitors[idOf(callId)];

  // ── Events ────────────────────────────────────────────────────────────────

  /// A call offered to this agent — ring.
  Stream<CallioCall> get onIncoming => _incoming.stream;

  /// This agent's call, active on another of their devices.
  Stream<CallioCall> get onElsewhere => _elsewhere.stream;
  Stream<CallEnded> get onCallEnded => _callEnded.stream;
  Stream<CallStateChange> get onCallState => _callStates.stream;

  /// CallioError (call:error) or a connection error.
  Stream<Object> get onError => _errors.stream;
  Stream<BoardCallEnded> get onBoardCallEnded => _boardEnded.stream;

  // ── Actions ───────────────────────────────────────────────────────────────

  /// Go AVAILABLE or OFFLINE (ON_CALL is Callio's). Supervisors may set another agent's.
  void setAvailability(Availability value, {Object? agentId}) {
    if (value == Availability.onCall) throw ArgumentError('ON_CALL is set by Callio');
    send('agent:availability:set', {'availability': availabilityWire(value), if (agentId != null) 'agentId': agentId});
  }

  /// Re-read this agent's calls (supervisors: the tenant's) and the queue snapshots.
  void sync() => send('calls:sync');

  /// Start an outbound call the consumer created (POST /v1/tenants/{t}/calls).
  Future<CallioCall> startOutbound(Object callId, {rtc.MediaStream? stream}) async {
    final call = CallioCall.internal(this, {'callId': callId, 'direction': 'OUTBOUND'}, CallState.dialing);
    _calls[idOf(callId)] = call;
    notifyListeners();
    await call.start(stream: stream);
    return call;
  }

  /// Supervisors: listen to a call, then setMode(whisper | barge).
  Future<CallioMonitor> monitor(Object callId, {rtc.MediaStream? stream}) async {
    if (!isSupervisor) throw StateError('Only supervisors can monitor calls');
    final id = idOf(callId);
    final existing = _monitors[id];
    if (existing != null && existing.state != MonitorState.ended) return existing;
    final m = CallioMonitor.internal(this, id);
    _monitors[id] = m;
    notifyListeners();
    try {
      await m.start(stream: stream);
    } catch (_) {
      m.end('failed');
      rethrow;
    }
    return m;
  }

  /// Supervisors: move any call to an agent or into a queue.
  void transferCall(Object callId, {Object? agentId, Object? queueId}) {
    if ((agentId == null) == (queueId == null)) throw ArgumentError('transfer needs agentId or queueId');
    send('call:transfer', {'callId': callId, if (agentId != null) 'agentId': agentId, if (queueId != null) 'queueId': queueId});
  }

  /// New ICE/TURN credentials now (also done automatically before they expire).
  void refreshSession() {
    _refreshing = true;
    send('session:refresh');
  }

  /// Disconnect; calls' media is closed.
  void close() {
    _refreshTimer?.cancel();
    for (final c in _calls.values) {
      c.closeMedia();
    }
    for (final m in List.of(_monitors.values)) {
      m.end('closed');
    }
    _transport.close();
    _status = ConnectionStatus.closed;
    notifyListeners();
  }

  // ── Internals (Call / Monitor) ────────────────────────────────────────────

  void send(String event, [Object? payload]) => _transport.emit(event, payload);

  void callStateChanged(CallioCall call, CallState state, CallState previous) {
    _callStates.add(CallStateChange(call, state, previous));
    notifyListeners();
  }

  void forget(CallioCall call, CallEnd end) {
    _calls.remove(call.id);
    _resolved.add(call.id);
    _callEnded.add(CallEnded(call, end));
    notifyListeners();
  }

  void forgetMonitor(CallioMonitor m) {
    if (identical(_monitors[m.callId], m)) _monitors.remove(m.callId);
    notifyListeners();
  }

  void _scheduleRefresh() {
    _refreshTimer?.cancel();
    final expiresAt = _session?.iceServersExpireAt;
    if (expiresAt == null) return;   // static credentials: nothing to refresh
    final left = expiresAt.difference(DateTime.now());
    var delay = Duration(milliseconds: (left.inMilliseconds * _refreshAt).round());
    if (delay < _minRefresh) delay = _minRefresh;
    _refreshTimer = Timer(delay, refreshSession);
  }

  bool _isMine(CallData d) {
    final mine = me?.id;
    if (mine == null) return false;
    if (d.agentId != null) return d.agentId == mine;
    return d.offeredAgentIds.contains(mine);
  }

  void _offer(Map<String, dynamic> payload) {
    final id = idOf(payload['callId']);
    if (_resolved.contains(id)) return;
    final existing = _calls[id];
    if (existing != null) {
      existing.update(payload);   // e.g. the SDP arriving after a resync saw the call
      return;
    }
    final call = CallioCall.internal(this, payload, CallState.ringing);
    _calls[id] = call;
    notifyListeners();
    _incoming.add(call);
  }

  // calls:list is the truth after any (re)connect.
  void _reconcile(List<Map<String, dynamic>> ongoing) {
    if (isSupervisor) {
      _board.clear();
      for (final entry in ongoing) {
        if (_terminal.contains(entry['status'])) continue;
        _board[idOf(entry['callId'])] = CallData(Map.of(entry)..remove('sdpOffer'));
      }
    }
    final seen = <String>{};
    for (final entry in ongoing) {
      final d = CallData(entry);
      if (!_isMine(d)) continue;
      final id = d.callId;
      seen.add(id);
      final local = _calls[id];
      if (local != null) {
        local.update(entry);
        continue;
      }
      if (_resolved.contains(id) || _terminal.contains(d.status)) continue;
      final onOtherDevice = d.deviceId != null && d.deviceId != deviceId;
      if (d.status == 'RINGING' && d.direction == CallDirection.inbound && d.deviceId == null && d.sdpOffer != null) {
        _offer(entry);
      } else if (onOtherDevice) {
        final call = CallioCall.internal(this, entry, CallState.elsewhere);
        _calls[id] = call;
        _elsewhere.add(call);
      } else if (d.deviceId == deviceId) {
        // Ours, on this device, but its media is gone (app restart): reconnect.
        final call = CallioCall.internal(this, entry, CallState.connecting);
        _calls[id] = call;
        call.reconnect('page_reload').catchError((Object err) => call.end('media_failed', {'error': err.toString()}));
      }
    }
    // Calls we held that Callio no longer lists are over.
    for (final call in List.of(_calls.values)) {
      if (!seen.contains(call.id) && call.state != CallState.dialing) call.end('gone');
    }
    notifyListeners();
  }

  void _boardUpsert(Map<String, dynamic> payload) {
    if (!isSupervisor || payload['callId'] == null) return;
    final id = idOf(payload['callId']);
    final patch = Map.of(payload)
      ..remove('sdpOffer')
      ..remove('sdpAnswer');
    (_board[id] ??= CallData({'callId': payload['callId']})).merge(patch);
    notifyListeners();
  }

  void _boardEnd(Map<String, dynamic> p) {
    final id = idOf(p['callId']);
    _monitors[id]?.end('call_ended');
    final view = _board.remove(id);
    if (view == null) return;
    _boardEnded.add(BoardCallEnded(view, (p['terminationReason'] ?? p['reason']) as String?, p['terminatedBy'] as String?));
    notifyListeners();
  }

  void _listen() {
    final t = _transport;
    Map<String, dynamic> m(dynamic p) => p is Map ? Map<String, dynamic>.from(p) : <String, dynamic>{};
    CallioCall? forCall(Map<String, dynamic> p) => _calls[idOf(p['callId'])];
    CallioMonitor? forMonitor(Map<String, dynamic> p) => _monitors[idOf(p['callId'])];
    bool onBoard(Map<String, dynamic> p) => _board.containsKey(idOf(p['callId']));

    t.on('session:ready', (raw) {
      _session = CallioSession(m(raw));
      _scheduleRefresh();
      if (_refreshing) {
        // A credentials refresh on the same connection: nothing else changed.
        _refreshing = false;
        notifyListeners();
        return;
      }
      // A (re)connect: monitoring doesn't survive the old socket.
      for (final mon in List.of(_monitors.values)) {
        mon.end('disconnected');
      }
      _status = ConnectionStatus.ready;
      if (!_ready.isCompleted) _ready.complete(this);
      notifyListeners();
      sync();
    });
    t.on('connect_error', (err) {
      if (_session == null && !_ready.isCompleted) _ready.completeError(err ?? 'connect_error');
      _errors.add(err ?? 'connect_error');
    });
    t.on('disconnect', (_) {
      _refreshing = false;
      if (_status != ConnectionStatus.closed) _status = ConnectionStatus.reconnecting;
      notifyListeners();
    });

    t.on('calls:list', (raw) {
      final ongoing = [for (final e in (m(raw)['ongoing'] as List? ?? const [])) m(e)];
      _reconcile(ongoing);
    });
    t.on('call:incoming', (raw) {
      final p = m(raw);
      if (_isMine(CallData(p))) _offer(p);
    });
    t.on('call:offer_withdrawn', (raw) {
      final p = m(raw);
      final call = forCall(p);
      if (call?.state == CallState.ringing) call!.end('withdrawn', {'withdrawnReason': p['reason']});
    });
    t.on('call:handled', (raw) {
      final p = m(raw);
      if (p['action'] == 'accepted' && onBoard(p)) _boardUpsert({'callId': p['callId'], 'agentId': p['userId'], 'agentName': p['agentName']});
      final call = forCall(p);
      if (call == null || call.state != CallState.ringing || p['action'] != 'accepted') return;
      final byMeHere = idOf(p['userId']) == me?.id && p['deviceId'] == deviceId;
      if (!byMeHere) call.end('answered_elsewhere', {'by': p['userId'], 'agentName': p['agentName']});
    });
    t.on('call:terminated', (raw) {
      final p = m(raw);
      forCall(p)?.end('terminated', {'terminationReason': p['terminationReason'] ?? p['reason'], 'terminatedBy': p['terminatedBy']});
      // 'transferred' ends the previous agent's leg, not the call.
      if (p['reason'] != 'transferred') _boardEnd(p);
    });
    t.on('call:status', (raw) {
      final p = m(raw);
      // The board speaks Callio's statuses: a provider's ACCEPTED is IN_PROGRESS.
      if (onBoard(p)) {
        _boardUpsert({'callId': p['callId'], 'status': p['status'] == 'ACCEPTED' ? 'IN_PROGRESS' : p['status'], 'ringingAt': p['ringingAt'], 'answeredAt': p['answeredAt']});
      }
      final call = forCall(p);
      if (call == null) return;
      call.update({'status': p['status'], 'ringingAt': p['ringingAt'], 'answeredAt': p['answeredAt']});
      if (call.direction == CallDirection.outbound && (p['status'] == 'ACCEPTED' || p['status'] == 'IN_PROGRESS')) call.customerAnswered();
    });

    t.on('call:started', (raw) {
      final p = m(raw);
      forCall(p)?.onStarted(p);
    });
    t.on('call:reconnected', (raw) {
      final p = m(raw);
      forCall(p)?.onReconnected(p);
    });
    t.on('call:connection_superseded', (raw) => forCall(m(raw))?.superseded());
    t.on('connection:ice-candidate:server', (raw) {
      final p = m(raw);
      final type = p['connectionType'];
      if (type == 'MONITOR') {
        forMonitor(p)?.onServerCandidate(p['candidate']);
        return;
      }
      if (type != null && type != 'AGENT') return;
      forCall(p)?.onServerCandidate(p['candidate']);
    });

    t.on('call:customer:media:state', (raw) {
      final p = m(raw);
      forCall(p)?.signal(CustomerMediaSignal('${p['state']}'));
    });
    t.on('call:network:terminating', (raw) => forCall(m(raw))?.signal(const NetworkTerminatingSignal()));
    t.on('call:dtmf', (raw) {
      final p = m(raw);
      forCall(p)?.signal(DtmfSignal('${p['digit']}'));
    });
    t.on('call:supervisor:mode', (raw) {
      final p = m(raw);
      forCall(p)?.signal(SupervisorModeSignal(monitorModeFrom(p['mode'])));
      forMonitor(p)?.onMode(monitorModeFrom(p['mode']));
    });
    t.on('call:agent:private:changed', (raw) {
      final p = m(raw);
      forCall(p)?.signal(PrivateChangedSignal(p['active'] == true));
    });

    // Supervisors: the board and monitoring.
    t.on('call:incoming:supervisor', (raw) => _boardUpsert(m(raw)));
    t.on('call:initiated', (raw) => _boardUpsert(m(raw)));
    t.on('call:transferred', (raw) {
      final p = m(raw);
      _boardUpsert({'callId': p['callId'], 'agentId': p['agentId'] ?? p['userId'], 'agentName': p['agentName'], 'queueId': p['targetQueueId'] ?? p['queueId']});
    });
    t.on('call:ivr_state', (raw) {
      final p = m(raw);
      _boardUpsert({'callId': p['callId'], 'ivr': {'nodeType': p['nodeType'], 'nodeId': p['nodeId']}});
    });
    for (final done in ['call:ivr_transferred', 'call:ivr_terminated', 'call:ivr_session_closed']) {
      t.on(done, (raw) {
        final p = m(raw);
        if (onBoard(p)) _boardUpsert({'callId': p['callId'], 'ivr': null});
      });
    }
    t.on('call:monitor:started', (raw) {
      final p = m(raw);
      forMonitor(p)?.onStarted(p);
    });
    t.on('call:monitor:mode:changed', (raw) {
      final p = m(raw);
      forMonitor(p)?.onMode(monitorModeFrom(p['mode']));
    });
    t.on('call:monitor:ended', (raw) => forMonitor(m(raw))?.end('ended'));

    t.on('call:agent_availability', (raw) {
      final p = m(raw);
      final member = TeamMember(agentId: idOf(p['userId']), availability: availabilityFrom(p['availability']),
          reason: p['reason'] as String?, updatedAt: p['updatedAt']?.toString());
      _team[member.agentId] = member;
      if (member.agentId == me?.id) _availability = member.availability;
      notifyListeners();
    });
    t.on('call:agent_queue', (raw) {
      final snapshot = QueueSnapshot(m(raw));
      _queues[snapshot.queueId] = snapshot;
      notifyListeners();
    });
    t.on('call:error', (raw) {
      final p = m(raw);
      final error = CallioError(callId: p['callId'] == null ? null : idOf(p['callId']), code: '${p['code']}', message: '${p['message']}');
      _errors.add(error);
      if (error.code == 'MONITOR_FAILED') forMonitor(p)?.end('failed');
      if (error.callId != null && _endingErrors.contains(error.code)) forCall(p)?.end('error', {'code': error.code, 'message': error.message});
    });
  }

  @override
  void dispose() {
    close();
    _incoming.close();
    _elsewhere.close();
    _callEnded.close();
    _callStates.close();
    _errors.close();
    _boardEnded.close();
    super.dispose();
  }
}
