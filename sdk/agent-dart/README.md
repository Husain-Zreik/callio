# callio_agent

The agent side of Callio's [agent protocol](../../docs/agent-protocol.md) for
Flutter: connect, go available, ring, answer, hang up, transfer, keep calls
alive across network drops, app restarts and device switches, and — for
supervisors — the tenant's live calls and monitoring (listen / whisper /
barge). Same model and behaviour as the JS SDK ([`sdk/agent-js`](../agent-js/README.md)).

The app keeps its own screens and ringtones; the SDK gives it state
(`ChangeNotifier`, works with Provider), events (streams) and the audio.

```dart
import 'package:callio_agent/callio_agent.dart';

final agent = await CallioAgent.connect(
  url: 'https://callio.example.com',
  deviceId: storedDeviceId,                       // stable per installation
  getToken: () => api.fetchCallioToken(),         // your backend signs it; called on every (re)connect
);

agent.setAvailability(Availability.available);

agent.onIncoming.listen((call) {
  showRinging(call.customer);                     // your UI
  // later: await call.accept();  or  call.decline();
});
agent.onCallEnded.listen((e) => closeCallScreen(e.call, e.end.reason));
```

## The agent

| | |
|---|---|
| `CallioAgent.connect(url:, deviceId:, token: \| getToken:)` | completes on `session:ready` |
| `agent.status` | `connecting` · `ready` · `reconnecting` · `closed` |
| `agent.me`, `agent.isSupervisor`, `agent.availability` | |
| `agent.setAvailability(Availability.available \| offline, agentId:?)` | `onCall` is Callio's |
| `agent.calls`, `agent.ringingCalls`, `agent.activeCall`, `agent.call(id)` | this agent's calls |
| `agent.queues`, `agent.team` | queue snapshots, agents' availability |
| `agent.startOutbound(callId)` | a call your backend created (`POST /v1/tenants/{t}/calls`) |
| `agent.refreshSession()` | new ICE/TURN credentials (automatic before they expire) |
| `agent.close()` | |

Streams: `onIncoming`, `onElsewhere` (your call is on another device),
`onCallState`, `onCallEnded`, `onError` (`CallioError`), `onBoardCallEnded`.

## A call

`call.state`: `ringing` → `connecting` → `active` → `ended`; `dialing` for
outbound before the customer answers; `elsewhere` when its media is on another
of your devices.

| | |
|---|---|
| `call.accept()` / `call.decline()` / `call.hangup()` | |
| `call.mute(bool)`, `call.muted` | |
| `call.transfer(agentId:)` / `call.transfer(queueId:)` | |
| `call.setPrivate(bool)` | talk only to the monitoring supervisor |
| `call.switchHere()` | take a call that's active on another device |
| `call.customer`, `call.direction`, `call.callUuid`, `call.data` | |
| `call.remoteStream`, `call.localStream` | native platforms play the remote audio by themselves |
| `call.signals` | `DtmfSignal`, `CustomerMediaSignal`, `NetworkTerminatingSignal`, `SupervisorModeSignal`, `PrivateChangedSignal` |
| `call.ended` | `Future<CallEnd>` — `reason`: hangup, declined, withdrawn, answered_elsewhere, terminated (see `terminationReason`), gone, accept_failed, media_failed, error |

## Supervisors

`agent.board` — the tenant's live calls (`CallData`: status, customer, agent,
queue, `ivr` position), kept current and rebuilt on every sync.

```dart
final monitor = await agent.monitor(callId);   // asks for the microphone
monitor.setMode(MonitorMode.whisper);           // listen | whisper | barge
monitor.stop();
```

`monitor.agentStream` / `monitor.customerStream`, `monitor.mode`,
`monitor.state`, `monitor.ended`. A reconnect ends monitoring.

## What it handles

- Resync on every connect: ringing calls ring, calls on this device reconnect
  after an app restart, calls on another device show as `elsewhere`.
- ICE candidates buffered both ways until each side is ready (including the
  ones Callio sends while a call rings).
- Media recovery: no media within 15 s or a failed connection → one reconnect,
  then the call is ended (`system_failed`).
- One socket per agent (never shared with another connection to the same URL);
  a fresh token on every reconnect; TURN credentials from Callio, refreshed.

## Testing

`flutter test` drives the SDK through the protocol with a scripted gateway and
fake WebRTC (`test/fakes.dart`).
