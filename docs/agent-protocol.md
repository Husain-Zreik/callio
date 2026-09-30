# Agent protocol (v1)

How an agent client (browser, mobile app, desktop softphone) talks to Callio.
For JavaScript clients, `sdk/agent-js` implements all of this.
One Socket.IO connection per agent session carries all signaling; audio flows
over WebRTC between the client and Callio's media engine — never peer to
peer, never through the consumer's backend.

## Connecting

```js
import { io } from 'socket.io-client';

const socket = io('https://callio.example.com', {
  transports: ['websocket'],        // polling is not supported
  auth: {
    token: agentJwt,                // signed by the consumer's backend — see below
    device_id: stableDeviceId,      // survives reconnects; identifies this device
    protocol: 1,                    // optional; refused if the server speaks another version
    purpose: 'session',             // 'session' for the main connection (default);
                                    // anything else = an auxiliary socket that takes no part
                                    // in presence or call redelivery
  },
});
```

### The agent token

The consumer's backend signs a short-lived HS256 JWT with one of its signing
keys (`consumer_signing_keys`; issued with the consumer, rotated through
`/v1/signing-keys` — [management-api.md → Keys](management-api.md#keys)):

| Where | Field | Value |
|---|---|---|
| header | `alg` | `HS256` (the only accepted algorithm) |
| header | `kid` | the signing key id, e.g. `k1` — lets a new key be introduced before the old one is revoked |
| payload | `iss` | the consumer's slug; the token must be signed with one of that consumer's keys |
| payload | `tnt` | the tenant's reference (the consumer's own id, e.g. its business id) |
| payload | `sub` | the agent's reference (the consumer's own user id) |
| payload | `exp` | required; keep it short (5–15 minutes) and reconnect with a fresh token |
| payload | `name` | optional display name (defaults to `sub`) |
| payload | `role` | optional `AGENT` or `SUPERVISOR`; any other value is ignored |

The agent is created on first connect (name/role from the token), and an
agent deleted through the Management API is restored. Later tokens update the
name, and the role when present. Queue membership is managed only through the
Management API. The consumer and the tenant must both be `ACTIVE`.

A rejected connection fails with `connect_error` and the message
`Authentication failed: <reason>`:

| `<reason>` |
|---|
| `No token provided` |
| `Token is missing kid or iss` |
| `Unknown or suspended consumer` |
| `Unknown signing key` |
| `Invalid or expired token` (bad signature, algorithm or `exp`) |
| `Token is missing sub or tnt` |
| `Token must expire` |
| `Unknown or suspended tenant` |
| `Unsupported protocol version <n> (server speaks 1)` |
| `internal error` |

The token is only checked when the socket connects. Revoking its signing key
ends the socket: the server disconnects it (socket.io reason
`io server disconnect`, which the client doesn't retry by itself), on every
worker; the app has to reconnect with a token signed by a current key. Give the client a way to
fetch a fresh one for every reconnect (e.g. `auth: (cb) => getToken().then((token) => cb({ token, ... }))`
with socket.io-client) — a token captured once expires under a long session.

### session:ready

The first event on every connection, before anything that can deliver a call:

```json
{
  "protocol": 1,
  "agent": { "id": 7, "ref": "user-7", "name": "Agent One", "role": "AGENT" },
  "tenant": { "id": 1, "ref": "biz-123" },
  "deviceId": "phone-5c1e…",
  "purpose": "session",
  "iceServers": [{ "urls": "stun:…" }, { "urls": ["turn:…", "turns:…"], "username": "…", "credential": "…" }],
  "iceServersExpireAt": "2026-09-29T09:52:36.000Z",
  "serverTime": "2026-09-28T09:52:36.000Z"
}
```

Use `iceServers` for every peer connection to Callio — clients don't ship
STUN/TURN settings or credentials. TURN credentials may be short-lived and
per agent (`iceServersExpireAt`); send `session:refresh` to get a new
`session:ready` before they expire. A peer connection already set up keeps
working.

When a `session` connection is the agent's only live one and an inbound call
assigned to that agent is still ringing, Callio sends that socket a fresh `call:incoming`
(new `sdpOffer`, `assignmentType: DIRECT`) right after connecting.

## Identity and rooms

Identity always comes from the token. Payload fields never identify who is
acting. A socket receives:

- its own agent's events (offers, withdrawals),
- events of the calls it is on (after `call:accept` / `call:start` / `call:reconnect` / `call:monitor` succeeds, or while a call is offered to it),
- tenant-wide call state updates (small, no customer data): `call:status`, `call:handled`, `call:terminated`, `call:agent_queue`, `call:agent_availability`,
- supervisor-only events if the agent is a `SUPERVISOR`.

## Client → server

| Event | Payload | Notes |
|---|---|---|
| `session:refresh` | — | Replies with a fresh `session:ready` (new TURN credentials). |
| `calls:sync` | — | Resync: replies `calls:list` (agents: their own calls; supervisors: the tenant's) and one `call:agent_queue` per queue. Send on every (re)connect. `call:ongoing` is an alias. |
| `agent:availability:set` | `{ availability: 'AVAILABLE'\|'OFFLINE', agentId? }` | Go available/offline. `agentId` only for a supervisor setting someone else. A value other than these two, an unknown agent or a non-supervisor setting someone else → `AGENT_AVAILABILITY_SYNC_FAILED`. An agent on a live call stays `ON_CALL`: the request is ignored. |
| `call:agent-availability:sync` | `{ userId? }` | Re-broadcast an agent's current availability as `call:agent_availability` (self by default; others for supervisors only). An agent stuck `ON_CALL` with no active call is set `OFFLINE`. |
| `call:agent-queue:sync` | — | Replies with the tenant's queue snapshots. |
| `call:accept` | `{ callId, sdpAnswer }` | Accept an offered call (answer to `call:incoming.sdpOffer`). |
| `call:reject` | `{ callId }` | Decline. On a `RING_ALL` call nobody has taken, this only withdraws the offer for this agent. On a `ROUND_ROBIN` / `PRIORITY` offer it passes the call to the next member and you are not offered it again. With no queue to pass it to, it declines the call. |
| `call:start` | `{ callId, sdpOffer }` | Start an outbound call the consumer created via `POST /v1/tenants/{t}/calls`. Only the agent the intent names may start it. Replies `call:started`. When the call ends the agent goes `OFFLINE`, not `AVAILABLE`. |
| `call:terminate` | `{ callId, reason? }` | Hang up. Allowed for the agent on (or offered) the call and for the tenant's supervisors. The call ends `COMPLETED`, or `NO_ANSWER` if nobody answered yet (`terminatedBy: AGENT`). `reason: 'system_failed'` when the client gave up reconnecting media: it ends `FAILED` / `NETWORK_ERROR` (`terminatedBy: SYSTEM`). Any other `reason` is ignored. |
| `call:cancel` | `{ callId }` | Cancel an outbound call before it's answered: ends `CANCELLED` (`terminatedBy: AGENT`). Same permissions as `call:terminate`. |
| `call:reconnect` | `{ callId, sdpOffer, reconnectTrigger? }` | Re-establish the media leg (network change, page reload, moving to another device). Another still-live socket holding the call gets `call:connection_superseded`. |
| `call:transfer` | `{ callId, agentId }` or `{ callId, queueId }` | Transfer to an agent, or into a queue (picked by the queue's strategy). Allowed for the agent on the call and for supervisors. The target agent must be `AVAILABLE`; a queue must be `ACTIVE` and have an available member other than the current agent. |
| `connection:ice-candidate` | `{ callId, candidate, connectionType: 'AGENT'\|'MONITOR' }` | Trickle ICE for this socket's leg. Ignored unless the socket is bound to the call. |
| `call:monitor` | `{ callId, sdpOffer }` | Supervisors only, on an `IN_PROGRESS` call; one supervisor per call at a time. Offer **two** audio transceivers — see *Monitoring*. Replies `call:monitor:started`. |
| `call:monitor:mode` | `{ callId, mode: 'listen'\|'whisper'\|'barge' }` | While monitoring. Any other mode → `MONITOR_FAILED`. |
| `call:monitor:stop` | `{ callId }` | Ignored unless this socket is monitoring the call. |
| `call:agent:private` | `{ callId, active }` | The agent talks privately to the monitoring supervisor (muted to the customer). Takes effect only while the supervisor is in `whisper` mode, and ends when the supervisor leaves `whisper`. |
| `call:agent:muted` | `{ callId, muted }` | Informational — relayed to the call room so a supervisor sees it. |

## Server → client

### Calls

| Event | Payload |
|---|---|
| `call:incoming` | A call offered to this agent — see *Call payloads*. `assignmentType`: `DIRECT` (claimed for you), `QUEUED` (from a queue; with `agentId: null` it's a `RING_ALL` offer — first accept wins), `TRANSFERRED`. Carries `sdpOffer`. |
| `call:offer_withdrawn` | `{ callId, reason, takenBy? }` — stop ringing for this call. `reason`: `declined` (you declined, possibly on another device), `taken` (another member answered a `RING_ALL` call; `takenBy` is their agent id), `timeout` (the queue's ring timeout passed it to someone else, or a live call transferred to you wasn't accepted within `CALL_TRANSFER_TIMEOUT_SECONDS` — it went back to its queue), `overflow` (it waited too long and moved to another queue). |
| `call:started` | Reply to `call:start` — see *Call payloads*. |
| `call:success` | `{ callId, message, code: 'CALL_ACCEPTED' }` — to the call room once an accept went through. |
| `call:handled` | `{ callId, tenantId, userId, agentName, deviceId, action: 'accepted'\|'rejected' }` — someone answered/declined; other agents should stop ringing. For an outbound call, `accepted` means the customer answered (`deviceId: null`). |
| `call:status` | `{ callId, tenantId, status, userId, ringingAt?, answeredAt? }` — provider status changes: `RINGING`, `ACCEPTED`, `REJECTED`, `FAILED`. `userId` is the call's agent. |
| `call:reconnected` | `{ callId, userId, deviceId, sdpAnswer }` — reply to `call:reconnect`, sent only to the socket that sent it. |
| `call:connection_superseded` | `{ callId, reason: 'switched_device' }` — this socket no longer holds the call's media (taken over by another of the agent's sockets). |
| `call:transferred` | To the previous agent and supervisors: the new agent's `call:incoming` payload without `sdpOffer` and `tenantId`, plus `userId` (the new agent), `targetQueueId` and `transferTarget: { type: 'agent'\|'queue', queueId }`. |
| `call:terminated` | `{ callId, tenantId, reason, terminationReason, terminatedBy, source }` — the call ended; `reason` equals `terminationReason` (values in [events.md](events.md#values)); `source` is a short internal label. Two other forms: `{ callId, reason: 'transferred' }` to the call room when a transfer moves the call away from the previous agent — that agent's leg is over, the call is not; and `{ callId, tenantId, reason: 'orphan_cleanup', terminationReason }` when Callio closes leftover media of a call that already ended (`terminationReason` is then the call's status, or `NOT_FOUND`; no `terminatedBy`). |
| `calls:list` | `{ ongoing: [ … ] }` — reply to `calls:sync`; see *Call payloads*. |
| `connection:ice-candidate:server` | `{ callId, candidate, connectionType }` — Callio's trickled candidates for your leg. |
| `call:error` | `{ callId, code, message }` — see *Errors*. |

### Media state

| Event | Payload |
|---|---|
| `call:customer:media:state` | `{ callId, state: 'active'\|'drop' }` — the customer's audio stopped/resumed. |
| `call:network:terminating` | `{ callId }` — 15 s after a `drop` with no recovery. If the audio still hasn't resumed 20 s after the `drop`, the call ends as `CUSTOMER_NETWORK_LOSS` (`FAILED`, `terminatedBy: SYSTEM`). |
| `call:network:quality:customer` | `{ callId, ... }` — customer-leg quality stats. |
| `call:dtmf` | `{ callId, digit }` — a key the customer pressed during the call. |
| `call:agent:muted` | `{ callId, muted }` |
| `call:agent:private:changed` | `{ callId, active }` |
| `call:supervisor:mode` | `{ callId, mode }` — to the call room, so the agent sees whether a supervisor is whispering or barged in; `listen` when the supervisor leaves. |

### Agents and queues

| Event | Payload |
|---|---|
| `call:agent_availability` | `{ tenantId, userId, availability, updatedAt, reason?, consecutiveMissed? }` — `reason: 'auto_offline_missed_calls'` with `consecutiveMissed` when the tenant's auto-offline policy took the agent offline. |
| `call:agent_queue` | Queue snapshot — see below. |

Queue snapshot:

```json
{
  "tenantId": 1, "queueId": 3, "queueName": "Sales", "strategy": "ROUND_ROBIN",
  "lastAssignedAgentId": 7, "lastAssignedAgentName": "Agent One",
  "nextAgentId": 9, "nextAgentName": "Agent Two",
  "order": [
    { "position": 1, "agentId": 9, "name": "Agent Two", "availability": "AVAILABLE", "connected": true, "availableSince": "…" }
  ],
  "members": [
    { "agentId": 7, "name": "Agent One", "priority": 1, "availability": "ON_CALL", "connected": true },
    { "agentId": 9, "name": "Agent Two", "priority": 1, "availability": "AVAILABLE", "connected": true }
  ],
  "availableCount": 1, "memberCount": 2, "waitingCount": 0,
  "updatedAt": "…"
}
```

`order` is the available members in the order the queue will offer them
calls; `connected` means the agent has a live session socket; `waitingCount`
is calls waiting in the queue with no agent.

### Supervisors only

| Event | Payload |
|---|---|
| `call:incoming:supervisor` | Every offer of a call: the `call:incoming` payload without `sdpOffer`, including calls entering IVR (`assignmentType: 'IVR'`). |
| `call:initiated` | An agent started an outbound call: the call view (no SDP). |
| `call:monitor:started` | `{ callId, sdpAnswer }` — reply to `call:monitor`. |
| `call:monitor:mode:changed` | `{ callId, mode }` — to the supervisor's socket, confirming `call:monitor:mode`. |
| `call:monitor:ended` | `{ callId, userId }` — to the supervisor's socket when monitoring stopped. |
| `call:monitor:agent:reconnected` | `{ callId }` — to the call room: the agent's leg was rebuilt and the supervisor hears the agent again. |
| `call:ivr_state` | `{ callId, nodeType, nodeId }` — live IVR progress. |
| `call:ivr_transferred` | `{ callId }` — the IVR handed the call to a queue or agent. |
| `call:ivr_terminated` | `{ callId, action, reason, terminationReason }` — the call ended during IVR; `reason` equals `terminationReason`. |
| `call:ivr_session_closed` | `{ callId, tenantId, ivrFlowId, sessionId, outcome, endedAt, durationSeconds }` — `outcome`: `transferred`, `hung_up`, `timeout`, `error`. |

## Call payloads

Every call event is built on one call view:

```json
{
  "callId": 42,
  "callUuid": "00000000-0000-0000-0000-000000000042",
  "tenantId": 1,
  "channel": "WHATSAPP",
  "channelId": 1,
  "channelAddress": "+96170000000",
  "queueId": 1,
  "direction": "INBOUND",
  "status": "RINGING",
  "state": null,
  "customer": { "address": "+96181030841", "addressType": "E164", "name": "Test Customer" },
  "agentId": 7,
  "agentName": "Agent One",
  "externalRef": null,
  "ringingAt": "2026-09-25T10:00:00.000Z",
  "answeredAt": null,
  "endedAt": null
}
```

| Event | Adds to the call view |
|---|---|
| `call:incoming` | `sdpOffer`; `offeredAgentIds` (the agents it's offered to); `assignmentType`; `transferredFrom` (`{ id, name, isAssignment }` for a transfer — `isAssignment: true` when a supervisor assigned an unassigned call — else `null`); `assignedBy` (`{ id, name }` when a supervisor transferred someone else's call, else `null`) |
| `call:started` | `sdpOffer` (yours), `sdpAnswer` (Callio's) |
| `calls:list` entries | `deviceId` (the device the call's agent leg is bound to, or `null`), `sdpOffer` (Callio's offer for a ringing inbound call, else `null`) |

`callUuid` is a stable UUID-shaped id for the call, for native call UIs that
require one (CallKit, Android Telecom). The same value is in the call's pushes.

## Media

- **Inbound:** `call:incoming.sdpOffer` is Callio's offer for your leg. Answer it,
  send the answer in `call:accept`, and exchange ICE candidates both ways
  (`connection:ice-candidate` / `connection:ice-candidate:server`).
- **Outbound:** you create the offer and send it in `call:start`; Callio
  answers in `call:started`.
- Send your microphone as one audio track. Callio waits up to 5 seconds for
  it before telling the provider the call is answered; if it never arrives the
  call fails with `AGENT_MEDIA_NOT_READY`.
- While a call is being set up or re-established you may hear a short
  placeholder tone from Callio.
- **Reconnecting** (network change, ICE failure, page reload, another device):
  build a new peer connection, send its offer in `call:reconnect`, apply the
  answer from `call:reconnected`. There is no ICE restart — Callio rebuilds its
  side of the leg. If reconnecting doesn't bring media back, send
  `call:terminate { reason: 'system_failed' }`.

### Monitoring

A supervisor's offer has two audio transceivers, in this order:

| # | Direction | Carries |
|---|---|---|
| 1 | `sendrecv` | sends the supervisor's microphone; receives the **agent** |
| 2 | `recvonly` | receives the **customer** |

Identify the tracks by transceiver (`mid`), not by arrival order. The
microphone is only heard in `whisper` (by the agent) and `barge` (by the
agent and the customer) — Callio does the mixing, so there is no
renegotiation when the mode changes. Older clients that send the microphone
on a third, `sendonly` transceiver are also accepted.

## Push

Callio sends pushes to the tokens the consumer registered for the agent's
devices (`PUT …/agents/{agentRef}/push-tokens/{deviceId}`), whether or not the
agent also has a live socket. A push never carries SDP: the app connects,
sends `calls:sync`, and answers from `calls:list`.

| Provider | Delivery | `type` |
|---|---|---|
| FCM (Android) | data-only, high priority, 30 s TTL | `call.incoming`, `call.cancelled` |
| APNs VoIP (iOS, PushKit) | report to CallKit immediately | `call.incoming`, `call.cancelled` |
| FCM (iOS) | visible banner next to the VoIP push | `call.incoming.alert` |
| OneSignal (web) | notification with Answer / Decline | `call.incoming` |

Data fields (FCM and APNs VoIP; FCM values are strings): `call_id`,
`call_uuid`, `tenant_id`, `channel`, `customer_name`, `customer_address`. The
APNs VoIP payload also has `id` (= `call_uuid`), `nameCaller`, `handle` and
`isVideo`, the fields CallKit integrations read. `call.cancelled` means stop
ringing: someone answered, the offer was withdrawn, or the call ended.

## Errors

`call:error` is `{ callId, code, message }`; `callId` is `null` for errors
that aren't about one call. `message` is human-readable English text.

| `code` | Sent when |
|---|---|
| `ACCEPT_FAILED` | `call:accept` is malformed, the call isn't offered to you, or another agent answered first |
| `REJECT_FAILED` | `call:reject` is malformed or the call isn't offered to you |
| `CALL_INITIATION_FAILED` | `call:start` failed (missing fields, not your intent, already started, …) |
| `PROVIDER_TRIGGER_FAILED` | Dialing the customer failed; the call ends `FAILED` / `PROVIDER_TRIGGER_FAILED` |
| `TERMINATE_FAILED`, `CANCEL_FAILED` | `call:terminate` / `call:cancel` is malformed or not allowed |
| `RECONNECT_FAILED` | `call:reconnect` is malformed or you're not on the call |
| `CALL_TRANSFER_FAILED` | `call:transfer` is malformed or not allowed |
| `MONITOR_FAILED` | `call:monitor` / `call:monitor:mode` failed: not a supervisor, call not in progress, someone else monitoring, not monitoring this call, invalid mode; also a failed `call:agent:private` change |
| `STOP_MONITOR_FAILED` | `call:monitor:stop` is malformed |
| `BRIDGE_NOT_READY`, `MONITOR_CONNECTION_FAILED`, `MONITOR_ADD_FAILED` | Setting up the monitor leg failed (sent to the call room) |
| `AGENT_PRIVATE_FAILED` | `call:agent:private` from a socket that isn't the agent's leg of that call |
| `AGENT_MEDIA_NOT_READY` | Your microphone track never arrived; the call ends `FAILED` |
| `CALL_ALREADY_ENDED` | Accepting a call that ended, or while you are on another active call |
| `AGENT_QUEUE_SYNC_FAILED`, `FAILED_FETCH_ACTIVE`, `MISSING_TENANT_CONTEXT` | `call:agent-queue:sync` / `calls:sync` failed |
| `AGENT_AVAILABILITY_SYNC_FAILED` | `agent:availability:set` was not allowed or failed |
| `EVENT_HANDLER_FAILED` | The core failed to carry out an action that passed the checks above — e.g. a transfer whose target isn't available, or a reconnect with no live call |
| `null` or a provider's own code (e.g. a number) | The provider reported the call failed |
