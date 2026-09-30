// CallioNativeCalls and CallioBackground against a fake native call screen.
import 'dart:async';

import 'package:callio_agent/native_calls.dart';
import 'package:flutter_test/flutter_test.dart';

import 'agent_test.dart' show connected;
import 'fakes.dart';

class FakeNativeUi implements NativeCallUi {
  final List<String> log = [];
  final List<NativeIncoming> shown = [];
  List<NativeIncoming> activeCalls = [];
  final _actions = StreamController<NativeAction>.broadcast(sync: true);

  void tap(NativeActionType type, String uuid, [String? callId]) => _actions.add(NativeAction(type, uuid, callId));

  @override
  Future<void> showIncoming(NativeIncoming call, NativeCallStyle style) async {
    shown.add(call);
    log.add('incoming ${call.uuid}');
  }

  @override
  Future<void> showOutgoing(NativeIncoming call, NativeCallStyle style) async => log.add('outgoing ${call.uuid}');
  @override
  Future<void> setConnected(String uuid) async => log.add('connected $uuid');
  @override
  Future<void> end(String uuid) async {
    log.add('end $uuid');
    // The plugin reports the end it was told to do.
    _actions.add(NativeAction(NativeActionType.ended, uuid));
  }

  @override
  Future<List<NativeIncoming>> active() async => activeCalls;
  @override
  Stream<NativeAction> get actions => _actions.stream;
}

String uuid(int id) => uuidForCall('$id');

void main() {
  test('a ringing call shows the native screen; Accept answers it; answered → connected', () async {
    final (agent, transport, media) = await connected();
    final ui = FakeNativeUi();
    await CallioNativeCalls(agent, ui: ui, ringPolicy: NativeRingPolicy.always).attach();
    transport.server('call:incoming', callPayload(1));
    await settle();
    expect(ui.shown.single.uuid, uuid(1));
    expect(ui.shown.single.callId, '1');
    expect(ui.shown.single.name, 'Customer');

    ui.tap(NativeActionType.accept, uuid(1), '1');
    await settle();
    expect(transport.last('call:accept')!.map['callId'], 1);
    media.lastPeer.connected();
    await settle();
    expect(ui.log, contains('connected ${uuid(1)}'));
    ui.tap(NativeActionType.accept, uuid(1), '1');   // the OS echoing the connected call
    await settle();
    expect(transport.sent('call:accept'), hasLength(1));
  });

  test('Decline rejects; End hangs up; a call ended by Callio closes the screen without echoing', () async {
    final (agent, transport, _) = await connected();
    final ui = FakeNativeUi();
    await CallioNativeCalls(agent, ui: ui, ringPolicy: NativeRingPolicy.always).attach();

    transport.server('call:incoming', callPayload(2));
    await settle();
    ui.tap(NativeActionType.decline, uuid(2), '2');
    await settle();
    expect(transport.last('call:reject')!.map, {'callId': 2});

    transport.server('call:incoming', callPayload(3));
    await settle();
    ui.tap(NativeActionType.accept, uuid(3), '3');
    await settle();
    ui.tap(NativeActionType.ended, uuid(3), '3');
    await settle();
    expect(transport.last('call:terminate')!.map, {'callId': 3});

    transport.server('call:incoming', callPayload(4));
    await settle();
    transport.server('call:handled', {'callId': 4, 'action': 'accepted', 'userId': 9, 'agentName': 'Other', 'deviceId': 'x'});
    await settle();
    expect(ui.log, contains('end ${uuid(4)}'));
    expect(transport.sent('call:reject').map((e) => e.map['callId']), [2]);   // the echoed end sent nothing
  });

  test('whenInBackground: nothing native while the app is in front', () async {
    final (agent, transport, _) = await connected();
    final ui = FakeNativeUi();
    var front = true;
    await CallioNativeCalls(agent, ui: ui, appInForeground: () => front).attach();
    transport.server('call:incoming', callPayload(5));
    await settle();
    front = false;
    transport.server('call:incoming', callPayload(6));
    await settle();
    expect(ui.shown.map((c) => c.callId), ['6']);
  });

  test('an Accept before the call is known waits for it (push → app still connecting)', () async {
    final (agent, transport, _) = await connected();
    final ui = FakeNativeUi();
    await CallioNativeCalls(agent, ui: ui, ringPolicy: NativeRingPolicy.always).attach();
    final syncs = transport.sent('calls:sync').length;
    ui.tap(NativeActionType.accept, uuid(7), '7');
    await settle();
    expect(transport.sent('calls:sync').length, syncs + 1);
    transport.server('calls:list', {'ongoing': [callPayload(7)]});
    await settle();
    expect(transport.last('call:accept')!.map['callId'], 7);
    expect(ui.shown, isEmpty);   // the screen was already up
  });

  test('cold start: a call accepted on the native screen before attach is answered', () async {
    final (agent, transport, _) = await connected();
    final ui = FakeNativeUi()..activeCalls = [NativeIncoming(uuid: uuid(8), callId: '8', name: 'Customer', accepted: true)];
    await CallioNativeCalls(agent, ui: ui).attach();
    transport.server('calls:list', {'ongoing': [callPayload(8)]});
    await settle();
    expect(transport.last('call:accept')!.map['callId'], 8);
  });

  test('an Accept waits only pendingFor', () async {
    final (agent, transport, _) = await connected();
    final ui = FakeNativeUi();
    await CallioNativeCalls(agent, ui: ui, pendingFor: Duration.zero).attach();
    ui.tap(NativeActionType.accept, uuid(9), '9');
    await Future<void>.delayed(const Duration(milliseconds: 5));
    transport.server('call:incoming', callPayload(9));
    await settle();
    expect(transport.sent('call:accept'), isEmpty);
  });

  group('CallioBackground', () {
    test('handlePush shows and dismisses; other pushes are ignored', () async {
      final ui = FakeNativeUi();
      final push = await CallioBackground.handlePush(
        {'type': 'call.incoming', 'call_id': '12', 'call_uuid': 'u-12', 'customer_name': 'Rana', 'customer_address': '+961'},
        ui: ui,
      );
      expect(push?.type, CallioPushType.incoming);
      expect(ui.shown.single.uuid, 'u-12');
      expect(ui.shown.single.name, 'Rana');
      await CallioBackground.handlePush({'type': 'call.cancelled', 'call_id': '12', 'call_uuid': 'u-12'}, ui: ui);
      expect(ui.log.last, 'end u-12');
      expect(await CallioBackground.handlePush({'type': 'chat.message', 'id': '1'}, ui: ui), isNull);
    });

    test('a push without a callUuid gets the derived one; a nameless caller shows the address', () {
      final push = CallioPush.parse({'type': 'call.incoming', 'call_id': 42, 'customer_address': '+9611'})!;
      expect(push.uuid, '00000000-0000-0000-0000-000000000042');
      expect(push.displayName, '+9611');
    });

    test('declineCall connects, rejects and closes', () async {
      final transport = FakeTransport();
      final done = CallioBackground.declineCall(url: 'https://callio.test', deviceId: 'dev-1', token: 'jwt', callId: 13, transport: transport);
      await settle();
      transport.server('session:ready', session());
      expect(await done, isTrue);
      expect(transport.last('call:reject')!.map, {'callId': 13});
      expect(transport.closed, isTrue);
    });
  });
}
