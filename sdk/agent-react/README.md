# @callio/agent-react

React bindings for [`@callio/agent-sdk`](../agent-js/README.md): a provider
that connects once, and hooks that re-render when calls, availability, queues
or the supervisor board change. The SDK's objects and actions are used as they
are — this package only wires them into React. React 18+.

```jsx
import { CallioProvider, useAgent, useIncomingCalls, useActiveCall, useCall, RemoteAudio } from '@callio/agent-react';

export default function App() {
  return (
    <CallioProvider url="https://callio.example.com" getToken={() => fetch('/api/callio-token').then((r) => r.text())}>
      <AgentScreen />
    </CallioProvider>
  );
}

function AgentScreen() {
  const { me, availability, setAvailability } = useAgent();
  const ringing = useIncomingCalls();
  const active = useActiveCall();
  return (
    <>
      <p>{me?.name} — {availability}</p>
      <button onClick={() => setAvailability('AVAILABLE')}>Available</button>
      {ringing.map((call) => <Ringing key={call.id} call={call} />)}
      {active && <OnCall call={active} />}
    </>
  );
}

function Ringing({ call }) {
  const { customer, accept, decline } = useCall(call);
  return <div>{customer.address} <button onClick={() => accept()}>Answer</button> <button onClick={decline}>Decline</button></div>;
}

function OnCall({ call }) {
  const { state, customer, remoteStream, muted, mute, hangup, transfer } = useCall(call);
  return (
    <div>
      {customer.address} — {state}
      <RemoteAudio stream={remoteStream} />
      <button onClick={() => mute(!muted)}>{muted ? 'Unmute' : 'Mute'}</button>
      <button onClick={() => transfer({ queueId: 3 })}>Transfer</button>
      <button onClick={hangup}>Hang up</button>
    </div>
  );
}
```

## Provider

`<CallioProvider>` takes `connect()`'s options (`url`, `token` | `getToken`,
`deviceId`, `webrtc`, `getUserMedia`) or `agent` — an already connected
`CallioAgent`. The latest `token` / `getToken` is used on every (re)connect,
so passing a fresh token doesn't reconnect; only another `url` or `deviceId`
does. The connection closes on unmount.

## Hooks

| Hook | Returns |
|---|---|
| `useCallio()` | `{ agent, status, error }` — `status`: `connecting` · `ready` · `reconnecting` · `error` |
| `useAgent()` | `{ me, tenant, availability, isSupervisor, setAvailability(value, { agentId? }) }` |
| `useCalls()` | this agent's calls (SDK `Call` objects) |
| `useIncomingCalls()` | the ringing ones |
| `useActiveCall()` | the call being set up / on / dialing, or `null` |
| `useCall(call)` | `{ state, data, customer, remoteStream, muted, lastDigit, endReason, accept, decline, hangup, mute, transfer, setPrivate, switchHere }` |
| `useQueues()` | queue snapshots |
| `useTeam()` | the tenant's agents' availability |
| `useBoard()` | supervisors: the tenant's live calls |
| `useMonitor(callId)` | supervisors: `{ state, mode, stream, error, start(), stop(), setMode(), mute() }` — `stream` is the call as they hear it; stops on unmount |

`<RemoteAudio stream />` plays a stream (a call's `remoteStream`, a monitor's
`stream`); other props go to the `<audio>` element.

## Supervisor screen

```jsx
function Board() {
  const calls = useBoard();
  const [watching, setWatching] = useState(null);
  return (
    <>
      {calls.map((c) => (
        <div key={c.callId}>
          {c.customer?.address} · {c.status} · {c.agentName ?? 'waiting'} {c.ivr && `· IVR ${c.ivr.nodeType}`}
          <button onClick={() => setWatching(c.callId)}>Listen</button>
        </div>
      ))}
      {watching && <Listening callId={watching} />}
    </>
  );
}

function Listening({ callId }) {
  const { state, mode, stream, start, setMode, stop } = useMonitor(callId);
  useEffect(() => { start(); }, [start]);
  return (
    <div>
      {state} · {mode}
      <RemoteAudio stream={stream} />
      <button onClick={() => setMode('whisper')}>Whisper</button>
      <button onClick={() => setMode('barge')}>Barge</button>
      <button onClick={stop}>Stop</button>
    </div>
  );
}
```

## No build step

The package is plain ES modules (`React.createElement`, no JSX) with
TypeScript types, so any bundler takes it as is. Tested by
`test/e2e/react.test.mjs` against real calls.
