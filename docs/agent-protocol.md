# Agent protocol (v1)

How an agent client (browser, mobile app, desktop softphone) talks to Callio.
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

The consumer's backend signs a short-lived HS256 JWT with a signing key issued
to it by the Callio operator (`consumer_signing_keys`):

| Where | Field | Value |
|---|---|---|
| header | `alg` | `HS256` (the only accepted algorithm) |
| header | `kid` | the signing key id, e.g. `k1` — lets a new key be introduced before the old one is revoked |
| payload | `iss` | the consumer's slug |
| payload | `tnt` | the tenant's reference (the consumer's own id, e.g. its business id) |
| payload | `sub` | the agent's reference (the consumer's own user id) |
| payload | `exp` | required; keep it short (5–15 minutes) and reconnect with a fresh token |
| payload | `name` | optional display name |
| payload | `role` | optional `AGENT` or `SUPERVISOR` |

The agent is created on first connect (name/role from the token); later tokens
update the name, and the role when present. Queue membership is managed only
through the Management API. A rejected connection fails with
`connect_error: Authentication failed: <reason>`.

## Identity and rooms

Identity always comes from the token. Payload fields never identify who is
acting. A socket receives:

- its own agent's events (assignments, availability),
- events of the calls it is on (after `call:accept` / `call:start` / `call:reconnect` / `call:monitor` succeeds),
- tenant-wide call state updates (small, no customer data): `call:status`, `call:handled`, `call:terminated`, `call:agent_queue`, `call:agent_availability`,
- supervisor-only events if the agent is a `SUPERVISOR`.

## Client → server

| Event | Payload | Notes |
|---|---|---|
| `calls:sync` | — | Resync: replies `calls:list` (agents: their own calls; supervisors: the tenant's) and one `call:agent_queue` per queue. Send on every (re)connect. `call:ongoing` is an alias. |
| `agent:availability:set` | `{ availability: 'AVAILABLE'\|'OFFLINE', agentId? }` | Go available/offline. `agentId` only for a supervisor setting someone else. `ON_CALL` is set by Callio, never by hand. |
| `call:agent-availability:sync` | `{ userId? }` | Re-broadcast an agent's current availability (self by default). |
| `call:agent-queue:sync` | — | Replies with the tenant's queue snapshots. |
| `call:accept` | `{ callId, sdpAnswer }` | Accept an offered call (answer to `call:incoming.sdpOffer`). |
| `call:reject` | `{ callId }` | Decline. On a `RING_ALL` call nobody has taken, this only withdraws the offer for this agent. |
| `call:start` | `{ callId, sdpOffer }` | Start an outbound call the consumer created via `POST /v1/tenants/{t}/calls`. Only the agent the intent names may start it. Replies `call:started { ...call, sdpAnswer }`. |
| `call:terminate` | `{ callId, reason? }` | Hang up. `reason: 'system_failed'` when the client gave up reconnecting media. |
| `call:cancel` | `{ callId }` | Cancel an outbound call before it's answered. |
| `call:reconnect` | `{ callId, sdpOffer, reconnectTrigger? }` | Re-establish the media leg (network change, page reload, moving to another device). Another still-live socket holding the call gets `call:connection_superseded`. |
| `call:transfer` | `{ callId, agentId }` or `{ callId, queueId }` | Transfer to an agent, or into a queue (picked by the queue's strategy). Allowed for the agent on the call and for supervisors. |
| `connection:ice-candidate` | `{ callId, candidate, connectionType: 'AGENT'\|'MONITOR' }` | Trickle ICE for this socket's leg. Ignored unless the socket is bound to the call. |
| `call:monitor` | `{ callId, sdpOffer }` | Supervisors only. Offer **two** audio transceivers: the agent and the customer arrive as separate tracks. Replies `call:monitor:started { callId, sdpAnswer }`. |
| `call:monitor:mode` | `{ callId, mode: 'listen'\|'whisper'\|'barge' }` | While monitoring. |
| `call:monitor:stop` | `{ callId }` | |
| `call:agent:private` | `{ callId, active }` | The agent talks privately to the monitoring supervisor (muted to the customer). |
| `call:agent:muted` | `{ callId, muted }` | Informational — relayed to the call room so a supervisor sees it. |

## Server → client

### Calls

| Event | Payload |
|---|---|
| `call:incoming` | A call offered to this agent (see *Call payload*). `assignmentType`: `DIRECT` (claimed for you), `QUEUED` (from a queue; with `agentId: null` it's a `RING_ALL` offer — first accept wins), `TRANSFERRED`. Carries `sdpOffer`. |
| `call:offer_withdrawn` | `{ callId, reason }` — stop ringing for this call (you declined it on another device, or someone else took it). |
| `call:started` | Reply to `call:start`: the call plus `sdpAnswer`. |
| `call:handled` | `{ callId, userId, agentName, deviceId, action: 'accepted'\|'rejected' }` — someone answered/declined; other agents should stop ringing. |
| `call:status` | `{ callId, status, userId, ringingAt?, answeredAt? }` — provider status changes (`RINGING`, `ACCEPTED`, ...). |
| `call:reconnected` | `{ callId, userId, sdpAnswer }` — reply to `call:reconnect`. |
| `call:connection_superseded` | `{ callId, reason }` — this socket no longer holds the call's media (taken over by another device). |
| `call:transferred` | Transfer notice for the previous agent and supervisors. |
| `call:terminated` | `{ callId, reason, terminationReason?, terminatedBy? }` |
| `calls:list` | `{ ongoing: [call payload + deviceId + sdpOffer?] }` — reply to `calls:sync`. |
| `connection:ice-candidate:server` | `{ callId, candidate, connectionType }` — Callio's trickled candidates for your leg. |
| `call:error` | `{ callId, code, message }` — see *Errors*. |

### Media state

| Event | Payload |
|---|---|
| `call:customer:media:state` | `{ callId, state: 'active'\|'drop' }` — the customer's audio stopped/resumed. |
| `call:network:terminating` | `{ callId }` — the customer's audio has been gone long enough that Callio is about to end the call. |
| `call:network:quality:customer` | `{ callId, ... }` — customer-leg quality stats. |
| `call:dtmf` | `{ callId, digit }` — a key the customer pressed during the call. |
| `call:agent:muted` | `{ callId, muted }` |
| `call:agent:private:changed` | `{ callId, active }` |

### Agents and queues

| Event | Payload |
|---|---|
| `call:agent_availability` | `{ tenantId, userId, availability, reason?, updatedAt }` |
| `call:agent_queue` | Queue snapshot: `{ tenantId, queueId, queueName, strategy, nextAgentId, order: [...], members: [...], availableCount, waitingCount, updatedAt }` |

### Supervisors only

| Event | Payload |
|---|---|
| `call:incoming:supervisor` | Every new call (without SDP), including calls in IVR (`assignmentType: 'IVR'`). |
| `call:initiated` | An agent started an outbound call. |
| `call:monitor:started` | `{ callId, sdpAnswer }` — reply to `call:monitor`. |
| `call:monitor:mode:changed` / `call:supervisor:mode` | Mode changes. |
| `call:monitor:agent:reconnected` / `call:monitor:ended` | |
| `call:ivr_state` | `{ callId, nodeType, nodeId }` — live IVR progress. |
| `call:ivr_transferred` / `call:ivr_terminated` / `call:ivr_session_closed` | IVR outcomes. |

## Call payload

`call:incoming`, `call:started` and `calls:list` entries share one shape:

```json
{
  "callId": 42,
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
  "endedAt": null,
  "offeredAgentIds": [7],
  "assignmentType": "DIRECT",
  "transferredFrom": null,
  "assignedBy": null,
  "sdpOffer": "v=0..."
}
```

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

## Errors

`call:error.code` is one of `ACCEPT_FAILED`, `REJECT_FAILED`,
`CALL_INITIATION_FAILED`, `TERMINATE_FAILED`, `CANCEL_FAILED`,
`RECONNECT_FAILED`, `CALL_TRANSFER_FAILED`, `MONITOR_FAILED`,
`STOP_MONITOR_FAILED`, `MONITOR_CONNECTION_FAILED`, `AGENT_PRIVATE_FAILED`,
`AGENT_MEDIA_NOT_READY`, `CALL_ALREADY_ENDED`, `PROVIDER_TRIGGER_FAILED`,
`AGENT_QUEUE_SYNC_FAILED`, `AGENT_AVAILABILITY_SYNC_FAILED`,
`FAILED_FETCH_ACTIVE`, `MISSING_TENANT_CONTEXT`, `EVENT_HANDLER_FAILED`.
`message` is safe to show to the agent.
