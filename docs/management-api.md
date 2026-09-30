# Management API (v1)

Server-to-server REST API for a consumer's backend: provisioning, outbound
calls, call history and control. Base path `/v1`, JSON in and out.

## Authentication

```
Authorization: Bearer ck_<slug>_<secret>
```

The first API key comes with the consumer (`npm run consumer:create`); more
are issued and revoked through [Keys](#keys). Keys are stored hashed; several
can be active at once, so a key is rotated without downtime. Every request is scoped to the calling consumer — its tenants,
their agents, queues, channels and calls. Anything else is `404`.

Rate limit: 1200 requests per minute per consumer, in fixed one-minute
windows (`429` with `Retry-After` in seconds).

## Conventions

- **Address entities by your own ids.** `{tenantRef}`, `{agentRef}`,
  `{queueRef}`, `{channelRef}`, `{flowRef}` are your references (1–191
  characters); you never need to store Callio's ids.
- **`PUT` creates or replaces.** A field you omit is reset to its default,
  not kept (e.g. omitting `status` sets it back to `ACTIVE`). Two exceptions:
  a tenant's `settings` and a channel's `credentials` are kept when omitted.
- **Responses** wrap the entity in a named key (`{ "tenant": … }`,
  `{ "queues": [ … ] }`); fields are camelCase; linked entities are returned
  as Callio ids (`overflowQueueId`, `inboundQueueId`, `channelId`). `DELETE`
  returns `204` with no body.
- Callio's numeric ids are returned in responses and events for convenience.
  Enum values in bodies are case-insensitive and returned uppercase.
- Request bodies are limited to 10 MB (15 MB for audio uploads).
- **Retry `POST`s safely with an `Idempotency-Key`** — see
  [Idempotency](#idempotency). `PUT`, `PATCH`, `GET` and `DELETE` are
  idempotent already.

### Idempotency

Send `Idempotency-Key: <any unique string, 1–255 chars>` on a `POST` (e.g. a
UUID per logical request). If the request is retried with the same key:

| Situation | Response |
|---|---|
| The first request finished with `2xx` or `4xx` | That same status and body again, with `Idempotent-Replayed: true`. Nothing runs twice |
| The first request is still running | `409 idempotency_key_in_use`, `Retry-After: 1` |
| Same key, different method, path or body | `422 idempotency_key_reused` |
| The first request failed with `5xx` | The retry runs normally (a `5xx` isn't stored) |

Keys are per consumer and kept for 24 hours. `POST /v1/api-keys` and
`POST /v1/signing-keys` are never replayed (the stored response would hold the
new secret): a retry issues another key; revoke the one you don't use. A
request without the header
behaves as before. A key whose first request never finished (the worker
died) can be reused after 2 minutes.

### Errors

Every error has one shape:

```json
{ "error": { "code": "invalid_request", "message": "name is required" } }
```

Some errors add `details` (for `in_use`: what is using the entity).

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_request` | A field is missing, has the wrong type or is out of range; a `*_ref` in the body matches nothing; malformed JSON |
| `401` | `unauthorized` | Missing or invalid API key |
| `403` | `consumer_suspended` | The consumer is suspended |
| `404` | `not_found` | The entity doesn't exist or isn't yours |
| `404` | `not_enabled` | `POST /webhooks/whatsapp` when direct Meta ingress isn't configured |
| `409` | `invalid_channel`, `channel_disabled`, `unsupported_channel`, `invalid_agent`, `agent_busy`, `invalid_customer` | `POST …/calls` — see [Outbound calls](#outbound-calls) |
| `409` | `call_ended` | `POST /v1/calls/{id}/terminate` on a call that already ended |
| `409` | `call_active`, `recording_in_progress` | [Deleting data](#deleting-data) before the call ended or its recording was saved |
| `409` | `idempotency_key_in_use` | A request with this `Idempotency-Key` is still running |
| `409` | `in_use` | A `DELETE` of something still in use — see [Deleting](#deleting) |
| `409` | `last_key`, `kid_taken` | Revoking your last active API or signing key; a `kid` that exists — see [Keys](#keys) |
| `413` | `invalid_request` | Request body over the size limit |
| `422` | `idempotency_key_reused` | The `Idempotency-Key` was used with a different request |
| `429` | `rate_limited` | Over the rate limit |
| `500` | `internal_error` | Unexpected failure |
| `503` | `storage_unavailable` | `GET /v1/calls/{id}/recording` when object storage isn't configured; deleting data when a recording file can't be deleted |

## Tenants

| Method | Path | Body | Response |
|---|---|---|---|
| `PUT` | `/v1/tenants/{tenantRef}` | `{ name, status?: ACTIVE\|SUSPENDED, settings? }` | `{ tenant }` |
| `GET` | `/v1/tenants/{tenantRef}` | — | `{ tenant }` |

`tenant`: `{ id, ref, name, status, settings }`. `status` defaults to
`ACTIVE`. A `SUSPENDED` tenant's agents can't connect. `settings` replaces
the stored object as a whole when given, and is kept when omitted:

```json
{
  "auto_offline": { "enabled": true, "missed_threshold": 3 },
  "recording": { "storage_limit_bytes": 5368709120, "retention_days": 90 }
}
```

`recording.retention_days` deletes this tenant's recordings that many days
after they were made (`0` keeps them; default: the deployment's
`RECORDING_RETENTION_DAYS`, which keeps them unless set).

`auto_offline` takes an agent `OFFLINE` after `missed_threshold` (default 3)
consecutive missed offers. Counted as missed, for a call in a
`ROUND_ROBIN`/`PRIORITY` queue: the queue's ring timeout passing it on, the
customer hanging up while it rang that agent, or a live transfer the agent
didn't accept in time. Also counted, whatever the queue: an IVR transfer to
the agent not answered within the flow's `agent_ring_timeout`. Accepting a
call resets the count.

## Agents

| Method | Path | Body | Response |
|---|---|---|---|
| `PUT` | `/v1/tenants/{t}/agents/{agentRef}` | `{ name, role?: AGENT\|SUPERVISOR }` | `{ agent }` |
| `GET` | `/v1/tenants/{t}/agents` | — | `{ agents }` |
| `DELETE` | `/v1/tenants/{t}/agents/{agentRef}` | — | `204` |
| `PUT` | `/v1/tenants/{t}/agents/{agentRef}/availability` | `{ availability: AVAILABLE\|OFFLINE }` | `{ agent }` |
| `PUT` | `/v1/tenants/{t}/agents/{agentRef}/push-tokens/{deviceId}` | `{ platform: ANDROID\|IOS\|WEB, provider: FCM\|APNS_VOIP\|ONESIGNAL, token }` | `{ registered: true }` |
| `DELETE` | `/v1/tenants/{t}/agents/{agentRef}/push-tokens/{deviceId}` | — | `204` |

- `agent`: `{ id, ref, name, role, availability }`. `role` is kept when
  omitted on an existing agent and defaults to `AGENT` on a new one.
- `DELETE` is a soft delete: the agent goes `OFFLINE` and disappears from
  lists. A later `PUT`, or the agent's next socket connection, restores them
  (with their queue memberships).
- `availability`: `AVAILABLE` also releases any stale call blocking the
  agent. An agent on a live call stays `ON_CALL`; the response then says
  `ON_CALL`. `ON_CALL` is set by Callio only.
- Push tokens: `token` up to 512 characters; one token per device and
  provider (a new one replaces it). A token registered to another agent
  moves to this one. `DELETE` removes all of that device's tokens.

Agents are also created on their first socket connection (see
[agent-protocol.md](agent-protocol.md)); `PUT` is how you set roles and names
ahead of time.

## Keys

Your API keys and agent-token signing keys. To rotate: issue the new key,
move over to it, then revoke the old one.

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/v1/api-keys` | — | `{ apiKeys }` |
| `POST` | `/v1/api-keys` | `{ name?, expires_in_days? }` (1–3650) | `201 { apiKey }` with `key` — the only time it is shown |
| `DELETE` | `/v1/api-keys/{id}` | — | `204` |
| `GET` | `/v1/signing-keys` | — | `{ signingKeys }` |
| `POST` | `/v1/signing-keys` | `{ kid? }` (default: the next `k<n>`) | `201 { signingKey: { kid, secret } }` — the only time the secret is shown |
| `DELETE` | `/v1/signing-keys/{kid}` | — | `204` |

- `apiKey`: `{ id, name, prefix, createdAt, lastUsedAt, expiresAt,
  revokedAt }`; `prefix` is the key's first 16 characters, to tell keys apart.
  `signingKey` in a list: `{ kid, createdAt, revokedAt }`.
- A revoked API key stops working at once. A revoked signing key's tokens
  are refused at once on the worker that revoked it and within a minute on
  the others, and every agent socket that connected with one of its tokens is
  disconnected.
- Your last active key of a kind can't be revoked (`409 last_key`); a `kid`
  that exists, revoked or not, is `409 kid_taken` — kids are never reused.

## Push credentials

Your app's own push credentials. Callio pushes your agents' devices with
them: your Firebase project, your Apple key, your OneSignal app.

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/v1/push-credentials` | — | `{ pushCredentials: { fcm, apns, onesignal } }` |
| `PUT` | `/v1/push-credentials/fcm` | `{ service_account }` — the Firebase service account JSON, as downloaded | `{ fcm }` |
| `PUT` | `/v1/push-credentials/apns` | `{ key_p8, key_id, team_id, bundle_id, production? }` | `{ apns }` |
| `PUT` | `/v1/push-credentials/onesignal` | `{ app_id, rest_api_key }` | `{ onesignal }` |
| `DELETE` | `/v1/push-credentials/{fcm\|apns\|onesignal}` | — | `204` |

- Reads never return a key. They say which app is set: `fcm`
  `{ projectId, clientEmail }`, `apns` `{ keyId, teamId, bundleId,
  production }`, `onesignal` `{ appId }`, or `null` when not set.
- `fcm` sends Android pushes and the iOS alert. `apns` sends the iOS VoIP
  push (PushKit → CallKit), to topic `<bundle_id>.voip`. `key_p8` is the
  contents of the `.p8` file; `production` is `true` for TestFlight and App
  Store builds. `onesignal` sends web push.
- Keys are checked when set (`400` if one doesn't parse) and stored encrypted.
- A provider you haven't set uses the platform's credentials, if the
  deployment has any. A change reaches every worker within a minute.

## Queues

| Method | Path | Body | Response |
|---|---|---|---|
| `PUT` | `/v1/tenants/{t}/queues/{queueRef}` | see below | `{ queue }` |
| `GET` | `/v1/tenants/{t}/queues` | — | `{ queues }` |
| `PUT` | `/v1/tenants/{t}/queues/{queueRef}/members` | `{ members: [{ agent_ref, priority? }] }` — replaces the list | `{ members }` |
| `DELETE` | `/v1/tenants/{t}/queues/{queueRef}` | — | `204` — see [Deleting](#deleting) |

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

`queue`: `{ id, ref, name, strategy, ringTimeoutSeconds, maxActiveCalls,
maxWaitSeconds, overflowQueueId, holdAudioAssetId, status }`. `members`:
`[{ id, ref, name, role, availability, priority }]`.

| Field | Values | Omitted |
|---|---|---|
| `name` | required, ≤255 chars | — |
| `strategy` | `RING_ALL`, `ROUND_ROBIN`, `PRIORITY` | `ROUND_ROBIN` |
| `ring_timeout_seconds` | 5–600 | `null` |
| `max_wait_seconds` | 5–86400 | `null` |
| `overflow_queue_ref` | a queue of this tenant | `null` |
| `max_active_calls` | 1–10000 | `null` |
| `hold_audio_asset_id` | an audio asset id | `null` |
| `status` | `ACTIVE`, `DISABLED` | `ACTIVE` |
| member `priority` | 1–1000 | `1` |

- `strategy`:
  - `RING_ALL` — every available member is offered the call at once; the first to accept takes it; a decline withdraws it only for that agent.
  - `ROUND_ROBIN` — one available member at a time, longest-available first.
  - `PRIORITY` — lowest `priority` member first, then by agent id.
  - With `ROUND_ROBIN` and `PRIORITY`, a decline passes the call to the next member; the customer keeps waiting. An agent who declined is not offered that call again. Once every member has declined, the call waits until someone new becomes available, its `max_wait_seconds` runs out, or the customer hangs up.
- `ring_timeout_seconds` (`ROUND_ROBIN` / `PRIORITY`) — how long one member is offered a call before it passes to the next member. It counts as a missed offer for the tenant's auto-offline policy. A member who missed it is skipped until every other available member has had it; then a new round starts, so a lone member is offered it again. `null`: an offer rings until it is answered or the customer hangs up. `RING_ALL` ignores it.
- `max_wait_seconds` — how long a call may wait unanswered after entering the queue (on arrival, or when an IVR transfers it). After that it moves to `overflow_queue_ref` and waits again there, up to 3 hops. With no overflow queue, or after 3 hops, it ends as `TIMEOUT` (`terminatedBy: SYSTEM`). `null`: no limit. Callio still ends a call that has rung unanswered for about a minute, the lifetime of a ringing WhatsApp call, in case the provider's end event is lost.
- `max_active_calls` — cap on calls being handled from this queue at once (e.g. `1` for a single shared line).
- `hold_audio_asset_id` — what customers hear while waiting after an IVR transfer.

## Channels

| Method | Path | Body | Response |
|---|---|---|---|
| `PUT` | `/v1/tenants/{t}/channels/{channelRef}` | see below | `{ channel }` |
| `GET` | `/v1/tenants/{t}/channels` | — | `{ channels }` |
| `DELETE` | `/v1/tenants/{t}/channels/{channelRef}` | — | `204` — see [Deleting](#deleting) |

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

`channel`: `{ id, ref, type, displayName, address, providerAccountId,
sipTrunkId, inboundQueueId, recordingEnabled, status }`.

| Field | Values | Omitted |
|---|---|---|
| `type` | `WHATSAPP`, `SIP` (required) | — |
| `address` | required, ≤50 chars | — |
| `display_name` | ≤255 chars | `null` |
| `provider_account_id` | required for `WHATSAPP` (Meta `phone_number_id`) | `null` |
| `sip_trunk_id` | required for `SIP` | `null` |
| `credentials` | object; `null` clears them | kept |
| `inbound_queue_ref` | a queue of this tenant | `null` |
| `recording_enabled` | boolean | `false` |
| `status` | `ACTIVE`, `DISABLED` | `ACTIVE` |

For a SIP channel, `address` is the DID in E.164 form — inbound calls to
that number reach this channel, and outbound calls from it show it as the
caller. `sip_trunk_id` is a trunk the Callio operator set up
(`npm run sip:trunk`): a platform trunk or one of this consumer's own.
Outbound customers are E.164 numbers or `sip:` URIs.

Credentials are encrypted at rest and never returned. An address or
`provider_account_id` can belong to only one channel (`400` otherwise).

## IVR flows

| Method | Path | Body | Response |
|---|---|---|---|
| `PUT` | `/v1/tenants/{t}/ivr-flows/{flowRef}` | see below | `{ ivrFlow }` |
| `GET` | `/v1/tenants/{t}/ivr-flows` | — | `{ ivrFlows }` (without `structure`) |
| `DELETE` | `/v1/tenants/{t}/ivr-flows/{flowRef}` | — | `204` — see [Deleting](#deleting) |

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

`ivrFlow`: `{ id, ref, name, channelId, schemaVersion, triggerCondition,
triggerPriority, timeoutSeconds, agentRingTimeout, status, structure }`.

| Field | Values | Omitted |
|---|---|---|
| `name` | required, ≤255 chars | — |
| `structure` | required, `{ nodes: [], edges: [] }` | — |
| `channel_ref` | a channel of this tenant; none = tenant-wide | `null` |
| `status` | `ACTIVE`, `INACTIVE` | `INACTIVE` |
| `trigger_condition` | `ALWAYS`, `ALL_AGENTS_BUSY`, `ALL_AGENTS_OFFLINE`, `ALL_AGENTS_UNAVAILABLE` | `ALWAYS` |
| `trigger_priority` | 0–10000 | `0` |
| `timeout_seconds` | 1–120 | `10` |
| `agent_ring_timeout` | 5–600 — how long an agent the flow transfers to may ring before the call ends as `IVR_AGENT_NO_ANSWER` | `60` |
| `schema_version` | `1` | `1` |

- Selection on an inbound call, among `ACTIVE` flows: flows for that
  channel first, then tenant-wide flows; within each, lowest
  `trigger_priority` first, then most recently updated. The first whose
  `trigger_condition` holds takes the call. Conditions are evaluated over the
  channel's inbound queue.
- Node types: `ivr_start`, `ivr_menu` (plays `audioFileId`, waits for a key;
  edges' `sourceHandle` is the digit), `ivr_play`, `ivr_transfer`
  (`targetType: queue|agent`, `targetId` = queue/agent id; no `targetId` =
  the channel's inbound queue; `offlineAction`/`busyAction` with
  `offlineAudioFileId`/`busyAudioFileId` for unavailable targets),
  `ivr_hangup`. Ids inside nodes are Callio ids (audio assets, queues, agents).
- Keys are detected in-band from the customer's audio.

## Audio assets

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/v1/tenants/{t}/audio-assets` | upload or register — see below | `201 { audioAsset }` |
| `GET` | `/v1/tenants/{t}/audio-assets` | — | `{ audioAssets }` (includes platform-wide defaults) |
| `DELETE` | `/v1/tenants/{t}/audio-assets/{id}` | — | `204` — see [Deleting](#deleting); platform defaults are `404` |

- Upload: `{ name, content_base64, mime_type }` — stored in object storage
  (`400` if none is configured).
- Register an existing object: `{ name, storage_key, storage_provider?: S3|LOCAL, mime_type? }`
  (`storage_key` ≤512 chars; `storage_provider` defaults to `S3`).
- Both take optional `ref` (your reference, unique per tenant — `400` if
  another asset has it) and `duration_seconds` (0–86400).

`audioAsset`: `{ id, ref, name, storageProvider, storageKey, mimeType,
durationSeconds, platformDefault }`; `storageProvider` is lowercase (`s3`,
`local`). Any format ffmpeg can decode works (WAV, MP3, OGG). The whole JSON
body is limited to 15 MB, so base64 content can carry about 11 MB of audio.

## Deleting

Queues, channels, IVR flows and audio assets are deleted for good. Call
history stays: a call keeps its own channel address, customer and times, and
its link to the deleted entity becomes `null`.

A delete is refused with `409 in_use` while something depends on it.
`error.details` says what, so you can re-point it and try again:

| Entity | Refused while | `details` |
|---|---|---|
| Queue | a live call is in it; a channel routes into it; a queue overflows into it; an IVR flow transfers to it | `liveCalls`, `channels`, `overflowQueues`, `ivrFlows` |
| Channel | a live call is on it | `liveCalls` |
| IVR flow | a live call is in it or came through it | `liveCalls` |
| Audio asset | a queue holds with it; an IVR flow plays it | `queues`, `ivrFlows` |

`liveCalls` is `true`; the others are lists of your refs. A channel's IVR
flows are deleted with it. An audio file Callio stored itself (an upload) is
removed from storage; an object you registered by `storage_key` is left alone.

## Reports

| Method | Path | Query | Response |
|---|---|---|---|
| `GET` | `/v1/tenants/{t}/reports/calls` | `from`, `to`, `interval` (`hour`\|`day`), `utc_offset_minutes`, `service_level_seconds`, `queue_ref`, `channel_ref` | `{ totals, buckets: [{ start, … }] }` |
| `GET` | `/v1/tenants/{t}/reports/agents` | `from`, `to` | `{ agents: [{ agentRef, … }] }` |
| `GET` | `/v1/tenants/{t}/reports/live` | — | `{ at, liveCalls, inIvr, queues: [{ queueRef, … }] }` |

- `from` / `to`: ISO 8601; default the last 24 hours. At most 7 days with
  `interval=hour` (the default), 93 days with `day`.
- **Calls** counts the calls created in the window, as totals and per bucket.
  Buckets start on the hour or day in `utc_offset_minutes` (default `0`, a
  fixed offset — no daylight saving). Each has:

  | Field | Meaning |
  |---|---|
  | `inbound` | Inbound calls |
  | `answered` | An agent answered (an IVR picking up doesn't count) |
  | `abandoned` | Ended unanswered because the customer hung up |
  | `missed` | Ended unanswered for any other reason (timeout, rejected, failure) |
  | `inProgress` | Not answered and not over yet |
  | `outbound`, `outboundConnected` | Outbound calls, and those the customer answered |
  | `serviceLevelPercent` | Answered within `service_level_seconds` (default 20) of entering the queue, out of the calls that entered a queue and are answered or over; `null` without any |
  | `avgWaitSeconds`, `maxWaitSeconds` | Queue entry → an agent answering, over answered calls |
  | `talkSeconds`, `avgTalkSeconds` | Customer ⇄ agent time, answered inbound and connected outbound |

  `queue_ref` / `channel_ref` narrow it to one queue or line.
- **Agents**: per agent, over lifecycle events in the window — `answered`,
  `transfersReceived`, `declined`, `missed` (rang out), `outbound`,
  `outboundConnected` — and `talkSeconds` / `avgTalkSeconds` for calls that
  ended in the window, credited to the agent the call ended with. Also
  `name`, `role`, current `availability` (`null` for a deleted agent, who is
  listed only if they have activity).
- **Live**: right now. Per queue: `waiting` (calls not yet answered, IVR not
  included), `longestWaitSeconds`, `onCall`, and its members by
  `agents: { available, onCall, offline }`. `liveCalls` and `inIvr` are for the
  whole tenant.

## Calls

| Method | Path | Body / query | Response |
|---|---|---|---|
| `POST` | `/v1/tenants/{t}/calls` | Outbound intent — see below | `201 { call }` |
| `GET` | `/v1/tenants/{t}/calls` | `?status&direction&agent_ref&external_ref&customer&channel_ref&queue_ref&from&to&limit&before_id` | `{ calls, nextBeforeId }` |
| `GET` | `/v1/calls/{callId}` | — | `{ call, legs, events, transfers, ivrSessions, recording }` |
| `PATCH` | `/v1/calls/{callId}` | `{ external_ref?, consumer_metadata? }` | `{ call }` |
| `POST` | `/v1/calls/{callId}/terminate` | — | `202 { accepted: true }` |
| `GET` | `/v1/calls/{callId}/recording` | — | `{ url, expiresInSeconds, format, channelMap }` |
| `DELETE` | `/v1/calls/{callId}` | — | `204` — see [Deleting data](#deleting-data) |
| `POST` | `/v1/tenants/{t}/customers/erase` | `{ address }` | `{ callsErased, recordingsDeleted, activeCallsSkipped }` |

`call` is the call view described in [events.md](events.md#envelope)
(`data.call`).

- **List:** `status` is one of `INITIATED`, `RINGING`, `IN_PROGRESS`,
  `TERMINATED`, `FAILED`; `direction` `INBOUND` or `OUTBOUND`; `from`
  (inclusive) and `to` (exclusive) are ISO 8601 timestamps compared with the
  call's creation time (`400` if one doesn't parse); `customer` is the
  customer's address — a phone number with or without `+` or `00`, or a SIP
  URI; `channel_ref` / `queue_ref` pick one line or queue (`400` if the ref
  matches nothing); `limit` 1–200, default 50. Pages are newest first; pass
  `nextBeforeId` as `before_id` for the next page. `nextBeforeId` is `null`
  only when the page is empty.
- **Detail:** `legs` — `[{ type: AGENT|CUSTOMER|MONITOR, agentId, deviceId,
  state, connectedAt, disconnectedAt }]`; `events` — the lifecycle log,
  `[{ type, agentId, occurredAt, durationSeconds, metadata }]`; `recording` —
  `{ id, status, durationSeconds, format, channelMap, completedAt }` or
  `null`; `transfers` — `[{ id, fromAgentId, toAgentId, toQueueId,
  initiatedByAgentId, initiatedByType, transferredAt, acceptedAt,
  acceptanceDurationSeconds }]`; `ivrSessions` — `[{ id, ivrFlowId,
  completed, outcome, durationSeconds, startedAt, endedAt, inputs: [{
  nodeName, input, pressedAt }] }]`.
- **PATCH:** `external_ref` ≤191 chars; `consumer_metadata` an object. An
  omitted field is left unchanged.
- **Terminate:** `409 call_ended` if the call already ended. The result
  arrives as `call.ended`: `COMPLETED` if it was `IN_PROGRESS`, `CANCELLED`
  otherwise, with `terminatedBy: CONSUMER` (your backend ended it). An
  outbound intent the agent hasn't started yet ends straight away.
- **Recording:** a short-lived download URL. `404` until the recording has
  completed; `503 storage_unavailable` without object storage.

### Deleting data

For a customer's request to delete their data, or your own cleanup. Both
touch ended calls only, delete the recording files from storage first, and
remove the events Callio sent about those calls (they carry the customer too).
Callio's own retention also removes old detail and recordings on a schedule —
see the tenant `settings` above.

- **`DELETE /v1/calls/{callId}`** — the call and everything about it: legs,
  lifecycle log, transfers, IVR sessions and key presses, the recording, and
  its events (`GET /v1/events` no longer lists them). `409 call_active` while
  the call hasn't ended.
- **`POST /v1/tenants/{t}/customers/erase { address }`** — every ended call of
  the tenant with this customer address (same forms as the `customer` filter)
  keeps its row for your history and reports, but without the customer: the
  address, name, `external_ref`, `consumer_metadata` and provider details are
  cleared, and its lifecycle log, IVR key presses, SDP, recording and events
  are deleted. `activeCallsSkipped` counts the customer's calls still in
  progress — erase again once they've ended. Safe to repeat.
- Either answers `409 recording_in_progress` while a recording is still being
  saved (try again in a minute), and `503 storage_unavailable` when a
  recording file can't be deleted; nothing is changed then.

### Outbound calls

Outbound starts on your backend, because consent to call a customer is yours
to check.

`POST /v1/tenants/biz-123/calls`

```json
{
  "channel_ref": "whatsapp-main",
  "agent_ref": "user-7",
  "customer": { "address": "+96181030841", "name": "Jane Doe" },
  "external_ref": "crm-call-42",
  "consumer_metadata": { "crm_contact_id": 991 }
}
```

`201`:

```json
{ "call": { "callId": 88, "status": "INITIATED" } }
```

(abridged — the full call view.)

- `customer.address` is required (≤191 chars); `customer.address_type`
  (`E164`, `WHATSAPP_USER`, `SIP_URI`) is inferred when omitted;
  `customer.name` ≤255 chars; `external_ref` ≤191 chars.
- An unknown `channel_ref` is `400`; an unknown `agent_ref` is `404`.
- `409` codes: `invalid_channel` / `invalid_agent` (not this tenant's),
  `channel_disabled` (channel not `ACTIVE`), `unsupported_channel` (the
  channel type can't place outbound calls), `agent_busy` (the agent already
  has an active call), `invalid_customer` (the address isn't valid for the
  channel).

Give `callId` to that agent's client, which sends
`call:start { callId, sdpOffer }` over its socket; Callio then dials the
customer. An intent not started within 2 minutes ends as `CANCELLED`
(`terminatedBy: SYSTEM`). When an outbound call ends, the agent goes
`OFFLINE`, not `AVAILABLE`.

## Events

The events Callio sent, or is sending, to your webhook — to catch up after
an outage, or to check a delivery. The event body and fields are described
in [events.md](events.md).

| Method | Path | Query | Response |
|---|---|---|---|
| `GET` | `/v1/events` | `?tenant_ref&call_id&type&status&limit&before_id` | `{ events, nextBeforeId }` |
| `GET` | `/v1/events/{eventId}` | — | `{ event }` |
| `POST` | `/v1/events/{eventId}/redeliver` | — | `202 { accepted: true }` |

```json
{
  "eventId": "2f0c…",
  "type": "call.ended",
  "callId": 42,
  "createdAt": "2026-09-30T10:15:03.000Z",
  "delivery": { "status": "DELIVERED", "attempts": 1, "lastResponseStatus": 200, "deliveredAt": "2026-09-30T10:15:04.000Z" },
  "body": { "event_id": "2f0c…", "event_type": "call.ended", "…": "exactly what the webhook POSTed" }
}
```

- **List:** newest first; `type` is an event type (`call.ended`); `status`
  `PENDING`, `DELIVERED` or `FAILED` (given up after the last retry); `limit`
  1–200, default 50; pass `nextBeforeId` as `before_id` for the next page.
- **Redeliver:** queues the event again with the same `event_id` and a fresh
  retry schedule, whatever its status — for a `FAILED` event once your
  endpoint is fixed.

## Webhooks in

| Method | Path | Auth |
|---|---|---|
| `POST` | `/v1/webhooks/whatsapp/forward` | API key — forward Meta's WhatsApp webhook payload (the whole envelope, or a single `{ value }`) if your Meta app's webhook must keep pointing at your own backend. Only payloads for your own channels are processed. |
| `GET` | `/webhooks/whatsapp` | Meta's subscription check: with `hub.mode=subscribe` and `hub.verify_token` equal to the configured verify token, replies with `hub.challenge` as text; otherwise `403`. |
| `POST` | `/webhooks/whatsapp` | Meta posts directly, signed with `X-Hub-Signature-256` — point a Meta app's webhook straight at Callio. `401` on a bad signature, `404 not_enabled` when no app secret is configured. |

Both `POST`s answer `200 { received: n }` (n = call-related changes in the
payload) before processing, or `503` while the worker is shutting down so
Meta redelivers.

## Health and metrics

`GET /health` (probe) and `GET /v1/health` (diagnostics) — no authentication.
`GET /metrics` is Prometheus metrics for the operator (bearer
`METRICS_TOKEN`), not part of this API.
