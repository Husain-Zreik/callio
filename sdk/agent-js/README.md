# @callio/agent-sdk

The agent side of Callio's [agent protocol](../../docs/agent-protocol.md) for
browsers and Node: connect, go available, ring, answer, hang up, transfer,
and keep calls alive across network drops, page reloads and device switches.
The app keeps its own UI, ringtones and routing; the SDK gives it events,
state and the remote audio stream.

```js
import { connect } from '@callio/agent-sdk';

const agent = await connect({
  url: 'https://callio.example.com',
  getToken: () => fetch('/api/callio-token').then((r) => r.text()), // your backend signs it
});

agent.setAvailability('AVAILABLE');

agent.on('incoming', (call) => {
  ring(call.customer);                       // your UI
  call.on('remoteStream', (stream) => { audioEl.srcObject = stream; });
  call.on('ended', ({ reason }) => stopRinging());
  acceptButton.onclick = () => call.accept();  // asks for the microphone
  declineButton.onclick = () => call.decline();
});
```

## Connecting

`connect(options)` resolves once Callio has identified the agent (`session:ready`).

| Option | |
|---|---|
| `url` | Callio's base URL |
| `getToken` | `async () => jwt`, called on every (re)connect — agent tokens are short-lived. Or `token` for a fixed one. |
| `deviceId` | Stable id for this device (default: one kept in `localStorage`). Callio uses it to tell "this device" from "my other device". |
| `webrtc` | `{ RTCPeerConnection, MediaStream }` outside a browser (e.g. `@roamhq/wrtc` in Node) |
| `getUserMedia` | `async () => MediaStream` for the microphone (default: `navigator.mediaDevices.getUserMedia`) |

ICE/TURN servers come from Callio; the app never configures them.

## The agent

| | |
|---|---|
| `agent.setAvailability('AVAILABLE' \| 'OFFLINE', { agentId? })` | `ON_CALL` is set by Callio; `agentId`: a supervisor setting someone else |
| `agent.startOutbound(callId, { stream? })` | start an outbound call the consumer created (`POST /v1/tenants/{t}/calls`) |
| `agent.calls`, `agent.call(id)` | this agent's calls |
| `agent.queues` | queue snapshots by queue id |
| `agent.team` | the tenant's agents' availability, as it changes |
| `agent.refreshSession()` | new ICE/TURN credentials (done automatically before they expire) |
| `agent.agent`, `agent.session` | identity from `session:ready` |
| `agent.close()` | |

Events: `incoming` (call), `elsewhere` (call), `callState` (call, state, previous),
`callEnded` (call, info), `availability`, `team`, `queue`, `ready` (after each reconnect),
`sessionRefreshed`, `disconnected`, `error`.

## A call

`call.state`: `ringing` → `connecting` → `active` → `ended`; `dialing` for an
outbound call before the customer answers; `elsewhere` when its media is on
another of the agent's devices.

| | |
|---|---|
| `call.accept({ stream? })` | answer (default microphone) |
| `call.decline()` | in a queue, it passes to the next agent |
| `call.hangup()` | |
| `call.mute(bool)` | |
| `call.transfer({ agentId } \| { queueId })` | |
| `call.switchHere({ stream? })` | take a call that's active on another device |
| `call.setPrivate(bool)` | talk privately to the monitoring supervisor |
| `call.customer`, `call.direction`, `call.channel`, `call.callUuid`, `call.data` | |
| `call.remoteStream`, `call.localStream`, `call.pc` | |

Events: `state` (state, previous), `remoteStream` (stream), `ended` ({ reason }),
`updated`, `dtmf`, `customerMedia`, `networkTerminating`, `supervisorMode`,
`privateChanged`.

`ended` reasons: `hangup`, `declined`, `terminated` (the call ended — see
`terminationReason`), `withdrawn` (the offer went to someone else),
`answered_elsewhere`, `media_failed`, `accept_failed`, `error`, `gone`.

## Supervisors

An agent whose token has `role: 'SUPERVISOR'` (`agent.isSupervisor`) also gets:

| | |
|---|---|
| `agent.board` | the tenant's live calls (`Map` callId → call view: status, direction, customer, agent, queue, `ivr` position), rebuilt on every sync |
| `agent.monitor(callId, { stream? })` | listen to a call → a `Monitor` |
| `agent.transferCall(callId, { agentId } \| { queueId })` | move any call |
| `agent.setAvailability(value, { agentId })` | set an agent's availability |

Board events: `board` (the whole board, after each sync), `boardCall` (a call
appeared or changed), `boardCallEnded` (view, { terminationReason, terminatedBy }).

```js
const monitor = await agent.monitor(callId);            // asks for the microphone
monitor.on('agentStream', (s) => { agentAudio.srcObject = s; });
monitor.on('customerStream', (s) => { customerAudio.srcObject = s; });
monitor.setMode('whisper');                              // 'listen' | 'whisper' | 'barge'
monitor.stop();
```

`listen`: the supervisor hears both, nobody hears the supervisor ·
`whisper`: the agent hears the supervisor · `barge`: both do. Callio mixes, so
switching modes is instant. Monitor events: `state`, `agentStream`,
`customerStream`, `mode`, `agentPrivate` (the agent talking privately to you),
`agentReconnected`, `ended` ({ reason: `stopped` \| `call_ended` \| `ended` \|
`disconnected` \| `failed` }). A reconnect of the supervisor's socket ends
monitoring — start it again.

## TypeScript

Types ship with the package (`src/index.d.ts`): `connect`, `CallioAgent`,
`Call`, `Monitor` and the payload shapes.

## What it handles

- Resync on every connect (`calls:sync`): ringing calls, calls on this device
  (reconnected automatically after a reload), calls on another device.
- ICE candidates buffered both ways until each side is ready.
- Media recovery: no media within 15 s or a failed connection → one reconnect,
  then the call is ended with `system_failed`.
- Offers withdrawn (taken, timed out, declined elsewhere, an unaccepted
  transfer returned to its queue) and redelivered offers.
- TURN credentials refreshed on the live connection before they expire, for
  long shifts.

## Demo

```bash
npm run agent:token -- --consumer <slug> --tenant <tenant_ref> --agent <agent_ref>   # on the Callio server
npm run demo:agent                                                                   # locally
```

Open http://localhost:5173/examples/agent.html, paste the token, Connect,
Available — and call the line.

Tested by `test/e2e/sdk.test.mjs` against real calls.
