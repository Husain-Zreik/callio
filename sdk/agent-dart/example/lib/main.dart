// A minimal agent app on callio_agent: connect with an agent token, go
// available, answer / decline / mute / hang up, with the phone's native call
// screen when the app isn't in front.
//
//   flutter run --dart-define=CALLIO_URL=https://callio.pcg-ms.com --dart-define=CALLIO_TOKEN=eyJ...
//
// (or paste the token on the first screen).
import 'dart:async';

import 'package:callio_agent/callio_agent.dart';
import 'package:callio_agent/native_calls.dart';
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';

const _url = String.fromEnvironment('CALLIO_URL', defaultValue: 'https://callio.pcg-ms.com');
const _token = String.fromEnvironment('CALLIO_TOKEN');
const _deviceId = String.fromEnvironment('CALLIO_DEVICE_ID', defaultValue: 'android-example');

void main() => runApp(const ExampleApp());

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Callio agent',
        theme: ThemeData(colorSchemeSeed: Colors.teal, useMaterial3: true),
        darkTheme: ThemeData(colorSchemeSeed: Colors.teal, brightness: Brightness.dark, useMaterial3: true),
        home: const HomePage(),
      );
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with WidgetsBindingObserver {
  final _url$ = TextEditingController(text: _url);
  final _token$ = TextEditingController(text: _token);
  CallioAgent? _agent;
  CallioNativeCalls? _native;
  final List<String> _log = [];
  final List<StreamSubscription<Object?>> _subs = [];
  String? _error;
  bool _connecting = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _askPermissions();
    if (_token.isNotEmpty) _connect();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _disconnect();
    super.dispose();
  }

  Future<void> _askPermissions() async {
    try {
      await FlutterCallkitIncoming.requestNotificationPermission({
        'title': 'Notifications',
        'rationaleMessagePermission': 'Incoming calls are shown as notifications.',
        'postNotificationMessageRequired': 'Allow notifications to see incoming calls.',
      });
      if (!await FlutterCallkitIncoming.canUseFullScreenIntent()) {
        await FlutterCallkitIncoming.requestFullIntentPermission();
      }
    } catch (e) {
      _note('permissions: $e');
    }
  }

  void _note(String line) {
    final t = TimeOfDay.now().format(context);
    setState(() => _log.insert(0, '$t  $line'));
  }

  Future<void> _connect() async {
    setState(() {
      _connecting = true;
      _error = null;
    });
    try {
      final agent = await CallioAgent.connect(url: _url$.text.trim(), deviceId: _deviceId, token: _token$.text.trim())
          .timeout(const Duration(seconds: 15));
      agent.addListener(_changed);
      _subs
        ..add(agent.onIncoming.listen((c) => _note('ringing: call ${c.id} from ${_who(c)}')))
        ..add(agent.onCallEnded.listen((e) => _note('ended: call ${e.call.id} (${e.end.reason}'
            '${e.end.terminationReason == null ? '' : ', ${e.end.terminationReason}'})')))
        ..add(agent.onCallState.listen((s) => _note('call ${s.call.id}: ${s.previous.name} → ${s.state.name}')))
        ..add(agent.onError.listen((e) => _note('error: $e')));
      final native = CallioNativeCalls(
        agent,
        style: const NativeCallStyle(appName: 'Callio agent'),
        appInForeground: () => WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed,
      );
      _subs.add(native.onError.listen((e) => _note('native: $e')));
      await native.attach();
      setState(() {
        _agent = agent;
        _native = native;
      });
      _note('connected as ${agent.me?.name ?? agent.me?.ref} (${agent.me?.role})');
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      setState(() => _connecting = false);
    }
  }

  void _disconnect() {
    for (final s in _subs) {
      s.cancel();
    }
    _subs.clear();
    _native?.detach();
    _agent?.removeListener(_changed);
    _agent?.close();
    _agent = null;
    _native = null;
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  static String _who(CallioCall c) => c.customer.name?.isNotEmpty == true ? c.customer.name! : (c.customer.address ?? 'unknown');

  @override
  Widget build(BuildContext context) {
    final agent = _agent;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Callio agent'),
        actions: [
          if (agent != null)
            IconButton(
              tooltip: 'Disconnect',
              icon: const Icon(Icons.logout),
              onPressed: () => setState(_disconnect),
            ),
        ],
      ),
      body: SafeArea(child: agent == null ? _connectForm() : _agentView(agent)),
    );
  }

  Widget _connectForm() => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(controller: _url$, decoration: const InputDecoration(labelText: 'Callio URL')),
          const SizedBox(height: 12),
          TextField(
            controller: _token$,
            decoration: const InputDecoration(labelText: 'Agent token (npm run agent:token)'),
            maxLines: 3,
          ),
          const SizedBox(height: 16),
          FilledButton(onPressed: _connecting ? null : _connect, child: Text(_connecting ? 'Connecting…' : 'Connect')),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ],
        ],
      );

  Widget _agentView(CallioAgent agent) {
    final ringing = agent.ringingCalls;
    final active = agent.activeCall;
    final available = agent.availability == Availability.available;
    return Column(
      children: [
        ListTile(
          leading: Icon(Icons.circle, size: 14, color: switch (agent.status) {
            ConnectionStatus.ready => Colors.green,
            ConnectionStatus.closed => Colors.red,
            _ => Colors.orange,
          }),
          title: Text(agent.me?.name ?? agent.me?.ref ?? ''),
          subtitle: Text('${agent.status.name} · ${agent.availability?.name ?? '…'}'),
          trailing: Switch(
            value: available || agent.availability == Availability.onCall,
            onChanged: agent.availability == Availability.onCall
                ? null
                : (on) => agent.setAvailability(on ? Availability.available : Availability.offline),
          ),
        ),
        const Divider(height: 1),
        for (final call in ringing) _RingingCard(call: call),
        if (active != null) _ActiveCard(call: active),
        if (ringing.isEmpty && active == null)
          Padding(
            padding: const EdgeInsets.all(24),
            child: Text(available ? 'Waiting for calls' : 'Go available to receive calls',
                style: Theme.of(context).textTheme.titleMedium),
          ),
        const Divider(height: 1),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(12),
            children: [for (final l in _log) Text(l, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))],
          ),
        ),
      ],
    );
  }
}

class _RingingCard extends StatelessWidget {
  const _RingingCard({required this.call});
  final CallioCall call;

  @override
  Widget build(BuildContext context) => Card(
        margin: const EdgeInsets.all(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              Text('Incoming call', style: Theme.of(context).textTheme.labelLarge),
              Text(_HomePageState._who(call), style: Theme.of(context).textTheme.headlineSmall),
              Text('${call.data.channel} · call ${call.id}'),
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  FilledButton.icon(
                    style: FilledButton.styleFrom(backgroundColor: Colors.red),
                    onPressed: call.decline,
                    icon: const Icon(Icons.call_end),
                    label: const Text('Decline'),
                  ),
                  FilledButton.icon(
                    style: FilledButton.styleFrom(backgroundColor: Colors.green),
                    onPressed: () => call.accept(),
                    icon: const Icon(Icons.call),
                    label: const Text('Accept'),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
}

class _ActiveCard extends StatefulWidget {
  const _ActiveCard({required this.call});
  final CallioCall call;

  @override
  State<_ActiveCard> createState() => _ActiveCardState();
}

class _ActiveCardState extends State<_ActiveCard> {
  final _since = Stopwatch();
  Timer? _tick;
  String? _lastSignal;
  StreamSubscription<CallSignal>? _signals;

  @override
  void initState() {
    super.initState();
    _subscribe();
  }

  @override
  void didUpdateWidget(_ActiveCard old) {
    super.didUpdateWidget(old);
    if (!identical(old.call, widget.call)) {
      _signals?.cancel();
      _subscribe();
    }
  }

  void _subscribe() {
    widget.call.addListener(_changed);
    _signals = widget.call.signals.listen((s) => setState(() => _lastSignal = switch (s) {
          DtmfSignal(:final digit) => 'DTMF $digit',
          NetworkTerminatingSignal() => 'customer network lost',
          CustomerMediaSignal(:final state) => 'customer media: $state',
          _ => s.runtimeType.toString(),
        }));
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
    _changed();
  }

  void _changed() {
    if (widget.call.state == CallState.active && !_since.isRunning) _since.start();
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.call.removeListener(_changed);
    _signals?.cancel();
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final call = widget.call;
    final s = _since.elapsed.inSeconds;
    return Card(
      margin: const EdgeInsets.all(12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text(call.state.name.toUpperCase(), style: Theme.of(context).textTheme.labelLarge),
            Text(_HomePageState._who(call), style: Theme.of(context).textTheme.headlineSmall),
            Text('${call.data.channel} · call ${call.id} · ${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}'),
            if (_lastSignal != null) Text(_lastSignal!, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                OutlinedButton.icon(
                  onPressed: () => call.mute(!call.muted),
                  icon: Icon(call.muted ? Icons.mic_off : Icons.mic),
                  label: Text(call.muted ? 'Unmute' : 'Mute'),
                ),
                FilledButton.icon(
                  style: FilledButton.styleFrom(backgroundColor: Colors.red),
                  onPressed: call.hangup,
                  icon: const Icon(Icons.call_end),
                  label: const Text('Hang up'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
