// CallioAgent against a scripted gateway: the protocol behaviour the JS SDK
// has (sdk/agent-js, test/e2e/sdk.test.mjs), in Dart.
import 'package:callio_agent/callio_agent.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

Future<(CallioAgent, FakeTransport, FakeMedia)> connected({String role = 'AGENT', String? expiresAt}) async {
  final transport = FakeTransport();
  final media = FakeMedia();
  final agent = CallioAgent(url: 'https://callio.test', deviceId: 'dev-1', token: 'jwt', media: media, transport: transport);
  transport.server('session:ready', session(role: role, expiresAt: expiresAt));
  await agent.ready;
  return (agent, transport, media);
}

void main() {
  group('connecting', () {
    test('session:ready identifies the agent, gives ICE servers and resyncs', () async {
      final (agent, transport, _) = await connected();
      await settle();
      expect(agent.status, ConnectionStatus.ready);
      expect(agent.me?.ref, 'agent-7');
      expect(agent.iceServers.single['urls'], 'stun:stun.example.org');
      expect(transport.lastAuth, {'token': 'jwt', 'device_id': 'dev-1', 'protocol': 1});
      expect(transport.sent('calls:sync'), hasLength(1));
    });

    test('a getToken provider is asked on connect', () async {
      final transport = FakeTransport();
      var asked = 0;
      CallioAgent(url: 'u', deviceId: 'd', getToken: () async => 'fresh-${++asked}', media: FakeMedia(), transport: transport);
      await settle();
      expect(transport.lastAuth?['token'], 'fresh-1');
    });

    test('a disconnect shows reconnecting; the next session:ready resyncs again', () async {
      final (agent, transport, _) = await connected();
      transport.server('disconnect', 'transport close');
      expect(agent.status, ConnectionStatus.reconnecting);
      transport.server('session:ready', session());
      expect(agent.status, ConnectionStatus.ready);
      expect(transport.sent('calls:sync'), hasLength(2));
    });

    test('refreshSession: new credentials without a resync', () async {
      final (agent, transport, _) = await connected();
      agent.refreshSession();
      expect(transport.last('session:refresh'), isNotNull);
      transport.server('session:ready', {...session(), 'iceServers': [{'urls': 'turn:new'}]});
      expect(agent.iceServers.single['urls'], 'turn:new');
      expect(transport.sent('calls:sync'), hasLength(1));
    });

    test('availability and team come from call:agent_availability', () async {
      final (agent, transport, _) = await connected();
      agent.setAvailability(Availability.available);
      expect(transport.last('agent:availability:set')!.map, {'availability': 'AVAILABLE'});
      transport.server('call:agent_availability', {'userId': 7, 'availability': 'AVAILABLE'});
      transport.server('call:agent_availability', {'userId': 8, 'availability': 'OFFLINE'});
      expect(agent.availability, Availability.available);
      expect(agent.team.map((m) => '${m.agentId}:${m.availability}'), ['7:Availability.available', '8:Availability.offline']);
      expect(() => agent.setAvailability(Availability.onCall), throwsArgumentError);
    });
  });

  group('an inbound call', () {
    test('only offers for this agent ring', () async {
      final (agent, transport, _) = await connected();
      final rung = <CallioCall>[];
      agent.onIncoming.listen(rung.add);
      transport.server('call:incoming', callPayload(1, agentId: 8));
      transport.server('call:incoming', callPayload(2));
      transport.server('call:incoming', callPayload(3, agentId: null, offered: [5, 7]));
      await settle();
      expect(rung.map((c) => c.id), ['2', '3']);
      expect(rung.last.isRingAll, isTrue);
      expect(rung.first.customer.address, '+9611234567');
      expect(rung.first.callUuid, '00000000-0000-0000-0000-000000000002');
    });

    test('accept: answers the offer, sends buffered candidates, applies Callio\'s, goes active', () async {
      final (agent, transport, media) = await connected();
      transport.server('call:incoming', callPayload(10));
      final call = agent.call(10)!;
      transport.server('connection:ice-candidate:server', {'callId': 10, 'connectionType': 'AGENT', 'candidate': {'candidate': 'srv-1', 'sdpMid': '0', 'sdpMLineIndex': 0}});
      await call.accept();
      final pc = media.lastPeer;
      expect(pc.remote?.sdp, 'server-offer-10');
      expect(pc.candidates.map((c) => c.candidate), ['srv-1']);
      expect(transport.last('call:accept')!.map, {'callId': 10, 'sdpAnswer': 'answer-0'});
      pc.gather('local-1');
      expect(transport.last('connection:ice-candidate')!.map['connectionType'], 'AGENT');
      expect(call.state, CallState.connecting);
      pc.connected();
      expect(call.state, CallState.active);
      expect(agent.activeCall, same(call));
      expect(media.configurations.single['iceServers'], agent.iceServers);
    });

    test('decline sends call:reject; hangup sends call:terminate', () async {
      final (agent, transport, _) = await connected();
      transport.server('call:incoming', callPayload(11));
      agent.call(11)!.decline();
      expect(transport.last('call:reject')!.map, {'callId': 11});
      transport.server('call:incoming', callPayload(12));
      final c12 = agent.call(12)!;
      await c12.accept();
      c12.hangup();
      expect(transport.last('call:terminate')!.map, {'callId': 12});
      expect((await c12.ended).reason, 'hangup');
      expect(agent.calls, isEmpty);
    });

    test('withdrawn, answered elsewhere and terminated end the call with their reason', () async {
      final (agent, transport, _) = await connected();
      for (final id in [20, 21, 22]) {
        transport.server('call:incoming', callPayload(id));
      }
      final ends = <String, CallEnd>{};
      agent.onCallEnded.listen((e) => ends[e.call.id] = e.end);
      transport.server('call:offer_withdrawn', {'callId': 20, 'reason': 'timeout'});
      transport.server('call:handled', {'callId': 21, 'action': 'accepted', 'userId': 9, 'agentName': 'Other', 'deviceId': 'x'});
      transport.server('call:terminated', {'callId': 22, 'reason': 'ended', 'terminationReason': 'CANCELLED', 'terminatedBy': 'CUSTOMER'});
      await settle();
      expect(ends['20']?.reason, 'withdrawn');
      expect(ends['20']?.withdrawnReason, 'timeout');
      expect(ends['21']?.reason, 'answered_elsewhere');
      expect(ends['22']?.terminationReason, 'CANCELLED');
      expect(ends['22']?.terminatedBy, 'CUSTOMER');
    });

    test('an accept by this agent on this device is not "answered elsewhere"', () async {
      final (agent, transport, _) = await connected();
      transport.server('call:incoming', callPayload(23));
      transport.server('call:handled', {'callId': 23, 'action': 'accepted', 'userId': 7, 'deviceId': 'dev-1'});
      expect(agent.call(23)?.state, CallState.ringing);
    });

    test('mute disables the microphone and tells Callio', () async {
      final (agent, transport, _) = await connected();
      transport.server('call:incoming', callPayload(24));
      final call = agent.call(24)!;
      await call.accept();
      call.mute(true);
      expect(call.localStream!.getAudioTracks().single.enabled, isFalse);
      expect(transport.last('call:agent:muted')!.map, {'callId': 24, 'muted': true});
    });

    test('transfer needs exactly one target', () async {
      final (agent, transport, _) = await connected();
      transport.server('call:incoming', callPayload(25));
      final call = agent.call(25)!;
      call.transfer(queueId: 3);
      expect(transport.last('call:transfer')!.map, {'callId': 25, 'queueId': 3});
      expect(() => call.transfer(), throwsArgumentError);
      expect(() => call.transfer(agentId: 1, queueId: 2), throwsArgumentError);
    });

    test('in-call signals arrive on call.signals', () async {
      final (agent, transport, _) = await connected();
      transport.server('call:incoming', callPayload(26));
      final signals = <CallSignal>[];
      agent.call(26)!.signals.listen(signals.add);
      transport.server('call:dtmf', {'callId': 26, 'digit': '5'});
      transport.server('call:customer:media:state', {'callId': 26, 'state': 'drop'});
      transport.server('call:supervisor:mode', {'callId': 26, 'mode': 'whisper'});
      await settle();
      expect((signals[0] as DtmfSignal).digit, '5');
      expect((signals[1] as CustomerMediaSignal).state, 'drop');
      expect((signals[2] as SupervisorModeSignal).mode, MonitorMode.whisper);
    });

    test('an ending call:error ends the call', () async {
      final (agent, transport, _) = await connected();
      transport.server('call:incoming', callPayload(27));
      final errors = <Object>[];
      agent.onError.listen(errors.add);
      transport.server('call:error', {'callId': 27, 'code': 'ACCEPT_FAILED', 'message': 'no'});
      await settle();
      expect(agent.call(27), isNull);
      expect((errors.single as CallioError).code, 'ACCEPT_FAILED');
    });
  });

  group('recovery and devices', () {
    test('media failure: one reconnect, then the call is given up (system_failed)', () async {
      final (agent, transport, media) = await connected();
      transport.server('call:incoming', callPayload(30));
      final call = agent.call(30)!;
      await call.accept();
      media.lastPeer.failed();
      await settle();
      expect(transport.last('call:reconnect')!.map['reconnectTrigger'], 'ice_failure');
      transport.server('call:reconnected', {'callId': 30, 'sdpAnswer': 'srv-answer'});
      await settle();
      expect(media.lastPeer.remote?.sdp, 'srv-answer');
      media.lastPeer.failed();
      await settle();
      expect(transport.last('call:terminate')!.map, {'callId': 30, 'reason': 'system_failed'});
      expect(call.endReason?.reason, 'media_failed');
    });

    test('resync: a ringing call rings, a call on another device is elsewhere, ours reconnects, stale ones end', () async {
      final (agent, transport, _) = await connected();
      transport.server('call:incoming', callPayload(40));   // held locally, gone from Callio's list
      final elsewhere = <CallioCall>[];
      agent.onElsewhere.listen(elsewhere.add);
      transport.server('calls:list', {
        'ongoing': [
          callPayload(41),
          callPayload(42, status: 'IN_PROGRESS', deviceId: 'phone-2', sdp: false),
          callPayload(43, status: 'IN_PROGRESS', deviceId: 'dev-1', sdp: false),
          callPayload(44, agentId: 9),
        ],
      });
      await settle();
      expect(agent.call(40), isNull);
      expect(agent.call(41)?.state, CallState.ringing);
      expect(agent.call(42)?.state, CallState.elsewhere);
      expect(elsewhere.single.id, '42');
      expect(agent.call(43)?.state, CallState.connecting);
      expect(transport.last('call:reconnect')!.map['callId'], 43);
      expect(agent.call(44), isNull);
    });

    test('switchHere moves a call from another device; superseded sends it back', () async {
      final (agent, transport, _) = await connected();
      transport.server('calls:list', {'ongoing': [callPayload(50, status: 'IN_PROGRESS', deviceId: 'phone-2', sdp: false)]});
      final call = agent.call(50)!;
      await call.switchHere();
      expect(transport.last('call:reconnect')!.map['reconnectTrigger'], 'other_device');
      expect(call.state, CallState.connecting);
      transport.server('call:connection_superseded', {'callId': 50});
      await settle();
      expect(call.state, CallState.elsewhere);
    });

    test('an outbound call: start offers, started answers, active once the customer answers', () async {
      final (agent, transport, media) = await connected();
      final call = await agent.startOutbound(60);
      expect(transport.last('call:start')!.map, {'callId': 60, 'sdpOffer': 'offer-0'});
      transport.server('call:started', {'callId': 60, 'sdpAnswer': 'srv-answer', 'status': 'INITIATED'});
      await settle();
      expect(media.lastPeer.remote?.sdp, 'srv-answer');
      media.lastPeer.connected();
      expect(call.state, CallState.dialing);
      transport.server('call:status', {'callId': 60, 'status': 'ACCEPTED'});
      expect(call.state, CallState.active);
      call.hangup();
      expect(transport.last('call:terminate'), isNotNull);
    });

    test('hanging up while dialing cancels', () async {
      final (agent, transport, _) = await connected();
      final call = await agent.startOutbound(61);
      call.hangup();
      expect(transport.last('call:cancel')!.map, {'callId': 61});
    });
  });

  group('supervisors', () {
    test('the board: sync, new calls, answer, IVR, end', () async {
      final (agent, transport, _) = await connected(role: 'SUPERVISOR');
      expect(agent.isSupervisor, isTrue);
      transport.server('calls:list', {'ongoing': [callPayload(70, agentId: 9, status: 'IN_PROGRESS')]});
      expect(agent.board.single.callId, '70');
      expect(agent.board.single.sdpOffer, isNull);
      transport.server('call:incoming:supervisor', callPayload(71, agentId: null, sdp: false));
      transport.server('call:ivr_state', {'callId': 71, 'nodeType': 'ivr_menu', 'nodeId': 'menu'});
      expect(agent.board.firstWhere((c) => c.callId == '71').ivr, {'nodeType': 'ivr_menu', 'nodeId': 'menu'});
      transport.server('call:status', {'callId': 71, 'status': 'ACCEPTED'});
      transport.server('call:handled', {'callId': 71, 'action': 'accepted', 'userId': 8, 'agentName': 'Eight'});
      final view = agent.board.firstWhere((c) => c.callId == '71');
      expect(view.status, 'IN_PROGRESS');
      expect(view.agentName, 'Eight');
      final ended = <BoardCallEnded>[];
      agent.onBoardCallEnded.listen(ended.add);
      transport.server('call:terminated', {'callId': 70, 'reason': 'transferred'});
      expect(agent.board, hasLength(2));
      transport.server('call:terminated', {'callId': 70, 'terminationReason': 'COMPLETED'});
      await settle();
      expect(agent.board.map((c) => c.callId), ['71']);
      expect(ended.single.terminationReason, 'COMPLETED');
    });

    test('an agent has no board', () async {
      final (agent, transport, _) = await connected();
      transport.server('call:incoming:supervisor', callPayload(72, agentId: 9));
      expect(agent.board, isEmpty);
      expect(() => agent.monitor(72), throwsStateError);
    });

    test('monitor: two lines, offer, answer, MONITOR candidates, mode, ends with the call', () async {
      final (agent, transport, media) = await connected(role: 'SUPERVISOR');
      transport.server('calls:list', {'ongoing': [callPayload(80, agentId: 9, status: 'IN_PROGRESS')]});
      final m = await agent.monitor(80);
      final pc = media.lastPeer;
      expect(pc.lines, hasLength(2));
      expect(transport.last('call:monitor')!.map, {'callId': '80', 'sdpOffer': 'offer-0'});
      transport.server('connection:ice-candidate:server', {'callId': 80, 'connectionType': 'MONITOR', 'candidate': {'candidate': 'm-1', 'sdpMid': '0', 'sdpMLineIndex': 0}});
      transport.server('call:monitor:started', {'callId': 80, 'sdpAnswer': 'monitor-answer'});
      await settle();
      expect(pc.remote?.sdp, 'monitor-answer');
      expect(pc.candidates.single.candidate, 'm-1');
      pc.track(FakeStream('agent-audio'), mid: '0');
      pc.track(FakeStream('customer-audio'), mid: '1');
      expect(m.agentStream?.id, 'agent-audio');
      expect(m.customerStream?.id, 'customer-audio');
      pc.connected();
      expect(m.state, MonitorState.active);
      m.setMode(MonitorMode.whisper);
      expect(transport.last('call:monitor:mode')!.map, {'callId': '80', 'mode': 'whisper'});
      transport.server('call:monitor:mode:changed', {'callId': 80, 'mode': 'whisper'});
      expect(m.mode, MonitorMode.whisper);
      transport.server('call:terminated', {'callId': 80, 'terminationReason': 'COMPLETED'});
      expect(await m.ended, 'call_ended');
      expect(agent.monitorOf(80), isNull);
    });

    test('a reconnect ends monitoring', () async {
      final (agent, transport, _) = await connected(role: 'SUPERVISOR');
      final m = await agent.monitor(81);
      transport.server('disconnect', 'transport close');
      transport.server('session:ready', session(role: 'SUPERVISOR'));
      expect(await m.ended, 'disconnected');
    });
  });
}
