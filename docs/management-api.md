# Management API (v1)

Server-to-server REST API for a consumer's backend: provisioning, outbound
calls, call history and control. Base path `/v1`, JSON in and out.

## Authentication

```
Authorization: Bearer ck_<slug>_<secret>
```

API keys are issued by the Callio operator (`npm run consumer:create`) and
stored hashed; several can be active at once so a key can be rotated without
downtime. Every request is scoped to the calling consumer — its tenants,
their agents, queues, channels and calls. Anything else is `404`.

Rate limit: 1200 requests per minute per consumer (`429` with `Retry-After`).

## Conventions

- **Address entities by your own ids.** `{tenantRef}`, `{agentRef}`,
  `{queueRef}`, `{channelRef}`, `{flowRef}` are your references (1–191
  characters). `PUT` creates or updates; you never need to store Callio's ids.
- Callio's numeric ids are returned in responses and events for convenience.
- Errors: `{ "error": { "code": "invalid_request", "message": "name is required" } }`
  with `400` (invalid), `401` (no/invalid key), `403` (consumer suspended),
  `404` (not found / not yours), `409` (conflict, e.g. agent busy),
  `429`, `5xx`.

## Tenants

| Method | Path | Body |
|---|---|---|
| `PUT` | `/v1/tenants/{tenantRef}` | `{ name, status?: ACTIVE\|SUSPENDED, settings? }` |
| `GET` | `/v1/tenants/{tenantRef}` | — |

`settings`:

```json
{
  "auto_offline": { "enabled": true, "missed_threshold": 3 },
  "recording": { "storage_limit_bytes": 5368709120 }
}
```

`auto_offline` takes an agent offline after N consecutive missed offers from
a `ROUND_ROBIN`/`PRIORITY` queue.

## Agents

| Method | Path | Body |
|---|---|---|
| `PUT` | `/v1/tenants/{t}/agents/{agentRef}` | `{ name, role?: AGENT\|SUPERVISOR }` |
| `GET` | `/v1/tenants/{t}/agents` | — |
| `DELETE` | `/v1/tenants/{t}/agents/{agentRef}` | — (soft delete; the agent goes OFFLINE) |
| `PUT` | `/v1/tenants/{t}/agents/{agentRef}/availability` | `{ availability: AVAILABLE\|OFFLINE }` — also releases any stale call blocking the agent |
| `PUT` | `/v1/tenants/{t}/agents/{agentRef}/push-tokens/{deviceId}` | `{ platform: ANDROID\|IOS\|WEB, provider: FCM\|APNS_VOIP\|ONESIGNAL, token }` |
| `DELETE` | `/v1/tenants/{t}/agents/{agentRef}/push-tokens/{deviceId}` | — (all of that device's tokens) |

Agents are also created on their first socket connection (see
[agent-protocol.md](agent-protocol.md)); `PUT` is how you set roles and names
ahead of time.

## Queues

| Method | Path | Body |
|---|---|---|
| `PUT` | `/v1/tenants/{t}/queues/{queueRef}` | see below |
| `GET` | `/v1/tenants/{t}/queues` | — |
| `PUT` | `/v1/tenants/{t}/queues/{queueRef}/members` | `{ members: [{ agent_ref, priority? }] }` — replaces the list |

```json
{
  "name": "Sales",
  "strategy": "ROUND_ROBIN",
  "ring_timeout_seconds": 20,
  "max_wait_seconds": 120,
  "overflow_queue_ref": "sales-backup",
  "max_active_calls": null,
  "hold_audio_asset_id": 12,
  "status": "ACTIVE"
}
```

- `strategy`:
  - `RING_ALL` — every available member is offered the call at once; the first to accept takes it; a decline withdraws it only for that agent.
  - `ROUND_ROBIN` — one available member at a time, longest-available first.
  - `PRIORITY` — lowest `priority` member first, then by agent id.
  - With `ROUND_ROBIN` and `PRIORITY`, a decline passes the call to the next member; the customer keeps waiting. An agent who declined is not offered that call again. Once every member has declined, the call waits until someone new becomes available, its `max_wait_seconds` runs out, or the customer hangs up.
- `ring_timeout_seconds` (5–600, `ROUND_ROBIN` / `PRIORITY`) — how long one member is offered a call before it passes to the next member. It counts as a missed offer for the tenant's auto-offline policy. A member who missed it is skipped until every other available member has had it; then a new round starts, so a lone member is offered it again. `null`: an offer rings until it is answered or the customer hangs up. `RING_ALL` rings everyone at once and ignores this.
- `max_wait_seconds` (5–86400) — how long a call may wait unanswered after entering the queue (on arrival, or when an IVR transfers it). After that it moves to `overflow_queue_ref` and waits again there, up to 3 hops. With no overflow queue, or after 3 hops, it ends as `TIMEOUT` (`terminatedBy: SYSTEM`). `null`: no limit. Callio still ends a call that has rung unanswered for about a minute, the lifetime of a ringing WhatsApp call, in case the provider's end event is lost.
- `max_active_calls` — cap on calls being handled from this queue at once (e.g. `1` for a single shared line).
- `hold_audio_asset_id` — what customers hear while waiting after an IVR transfer.

## Channels

| Method | Path | Body |
|---|---|---|
| `PUT` | `/v1/tenants/{t}/channels/{channelRef}` | see below |
| `GET` | `/v1/tenants/{t}/channels` | — |

WhatsApp line:

```json
{
  "type": "WHATSAPP",
  "display_name": "Support line",
  "address": "+96170000000",
  "provider_account_id": "<Meta phone_number_id>",
  "credentials": { "access_token": "<Meta system-user token>" },
  "inbound_queue_ref": "support",
  "recording_enabled": true
}
```

SIP line (a DID on a carrier trunk):

```json
{
  "type": "SIP",
  "display_name": "Beirut office",
  "address": "+9611234567",
  "sip_trunk_id": 1,
  "inbound_queue_ref": "support"
}
```

`address` is the DID in E.164 form — inbound calls to that number reach this
channel, and outbound calls from it show it as the caller. `sip_trunk_id` is
a trunk the Callio operator set up (`npm run sip:trunk`): a platform trunk or
one of this consumer's own. Outbound customers are E.164 numbers or `sip:`
URIs.

Credentials are encrypted at rest and never returned. Omit `credentials` to
keep the stored ones. A number/phone_number_id can belong to only one channel.

## IVR flows

| Method | Path | Body |
|---|---|---|
| `PUT` | `/v1/tenants/{t}/ivr-flows/{flowRef}` | see below |
| `GET` | `/v1/tenants/{t}/ivr-flows` | — |

```json
{
  "name": "Main menu",
  "channel_ref": "whatsapp-main",
  "status": "ACTIVE",
  "trigger_condition": "ALWAYS",
  "trigger_priority": 0,
  "timeout_seconds": 10,
  "agent_ring_timeout": 60,
  "schema_version": 1,
  "structure": {
    "nodes": [
      { "id": "start", "type": "ivr_start", "data": {} },
      { "id": "menu", "type": "ivr_menu", "data": { "audioFileId": 12, "timeoutSeconds": 8, "noInputAction": "replay" } },
      { "id": "sales", "type": "ivr_transfer", "data": { "targetType": "queue", "targetId": 3 } },
      { "id": "bye", "type": "ivr_hangup", "data": {} }
    ],
    "edges": [
      { "source": "start", "target": "menu" },
      { "source": "menu", "target": "sales", "sourceHandle": "1" },
      { "source": "menu", "target": "bye", "sourceHandle": "9" }
    ]
  }
}
```

- Selection on an inbound call: flows for that channel first, then
  tenant-wide flows (no `channel_ref`); within each, by `trigger_priority`;
  the first whose `trigger_condition` holds takes the call. Conditions
  (`ALWAYS`, `ALL_AGENTS_BUSY`, `ALL_AGENTS_OFFLINE`, `ALL_AGENTS_UNAVAILABLE`)
  are evaluated over the channel's inbound queue.
- Node types: `ivr_start`, `ivr_menu` (plays `audioFileId`, waits for a key;
  edges' `sourceHandle` is the digit), `ivr_play`, `ivr_transfer`
  (`targetType: queue|agent`, `targetId` = queue/agent id; no `targetId` =
  the channel's inbound queue; `offlineAction`/`busyAction` with
  `offlineAudioFileId`/`busyAudioFileId` for unavailable targets),
  `ivr_hangup`. Ids inside nodes are Callio ids (audio assets, queues, agents).
- Keys are detected in-band from the customer's audio.

## Audio assets

| Method | Path | Body |
|---|---|---|
| `POST` | `/v1/tenants/{t}/audio-assets` | `{ name, content_base64, mime_type }` (upload, needs S3) or `{ name, storage_key, storage_provider?: S3\|LOCAL }` (register an existing object) |
| `GET` | `/v1/tenants/{t}/audio-assets` | — (includes platform-wide defaults) |

Any format ffmpeg can decode works (WAV, MP3, OGG). Maximum upload 15 MB.

## Calls

| Method | Path | Body / query |
|---|---|---|
| `POST` | `/v1/tenants/{t}/calls` | Outbound intent — see below |
| `GET` | `/v1/tenants/{t}/calls` | `?status&direction&agent_ref&external_ref&from&to&limit&before_id` |
| `GET` | `/v1/calls/{callId}` | Call, legs, lifecycle events, transfers, IVR sessions, recording |
| `PATCH` | `/v1/calls/{callId}` | `{ external_ref?, consumer_metadata? }` |
| `POST` | `/v1/calls/{callId}/terminate` | End the call (`202`; the result arrives as `call.ended`) |
| `GET` | `/v1/calls/{callId}/recording` | `{ url, expiresInSeconds, format, channelMap }` — short-lived download URL |

### Outbound calls

Outbound starts on your backend, because consent to call a customer is yours
to check:

```json
POST /v1/tenants/biz-123/calls
{
  "channel_ref": "whatsapp-main",
  "agent_ref": "user-7",
  "customer": { "address": "+96181030841", "name": "Jane Doe" },
  "external_ref": "crm-call-42",
  "consumer_metadata": { "crm_contact_id": 991 }
}
→ 201 { "call": { "callId": 88, "status": "INITIATED", ... } }
```

Give `callId` to that agent's client, which sends
`call:start { callId, sdpOffer }` over its socket; Callio then dials the
customer. An intent not started within 2 minutes is cancelled.
`customer.address_type` (`E164`, `WHATSAPP_USER`) is inferred when omitted.

List responses page newest first; pass the returned `nextBeforeId` as
`before_id` for the next page.

## Webhooks in

| Method | Path | Auth |
|---|---|---|
| `POST` | `/v1/webhooks/whatsapp/forward` | API key — forward Meta's WhatsApp webhook payload (the whole envelope, or a single `{ value }`) if your Meta app's webhook must keep pointing at your own backend. Only payloads for your own channels are accepted. |
| `GET`/`POST` | `/webhooks/whatsapp` | Meta's own verification and `X-Hub-Signature-256` — point a Meta app's webhook straight at Callio. |

## Health

`GET /health` (probe) and `GET /v1/health` (diagnostics) — no authentication.
