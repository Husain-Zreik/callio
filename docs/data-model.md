# Data model

Callio runs against its **own** MySQL database (e.g. `callio`), never a
consumer's. The Knex migrations in `migrations/` create the full schema from
an empty database; `knexfile.js` reads its connection from `config/envConfig.js`.

```bash
npm run migrate:status     # what has / hasn't run
npm run migrate:latest     # apply pending migrations
npm run migrate:rollback   # undo the last batch
npm run migrate:make -- <name>
```

**Every schema change** — new column, enum value, index — **is a new
migration** (`npm run migrate:make -- <name>`). Never edit a migration that
has run anywhere real, never `ALTER TABLE` by hand, and never let a
consumer's migration system touch this database.

## Migrations

| Migration | Creates / changes |
|---|---|
| `20260925000001_create_consumers_tables.js` | `consumers`, `consumer_api_keys`, `consumer_signing_keys` |
| `20260925000002_create_tenants_table.js` | `tenants` |
| `20260925000003_create_agents_table.js` | `agents` |
| `20260925000004_create_agent_push_tokens_table.js` | `agent_push_tokens` |
| `20260925000005_create_audio_assets_table.js` | `audio_assets` |
| `20260925000006_create_queues_tables.js` | `queues`, `queue_members` |
| `20260925000007_create_sip_trunks_table.js` | `sip_trunks` |
| `20260925000008_create_channels_table.js` | `channels` |
| `20260925000009_create_ivr_flows_table.js` | `ivr_flows` |
| `20260925000010_create_calls_table.js` | `calls` |
| `20260925000011_create_call_connections_table.js` | `call_connections` |
| `20260925000012_create_call_lifecycle_events_table.js` | `call_lifecycle_events` |
| `20260925000013_create_call_transfer_logs_table.js` | `call_transfer_logs` |
| `20260925000014_create_ivr_sessions_tables.js` | `ivr_sessions`, `ivr_session_inputs` |
| `20260925000015_create_call_recordings_table.js` | `call_recordings` |
| `20260925000016_create_webhook_deliveries_table.js` | `webhook_deliveries` |
| `20260928000001_add_queue_timing_to_calls.js` | `calls.queued_at`, `offered_at`, `overflow_count` + two timeout-scan indexes |
| `20260930000001_add_event_dedupe_and_idempotency_keys.js` | `webhook_deliveries.dedupe_key` + `(consumer_id, id)` index; `api_idempotency_keys` |
| `20260930000002_add_consumer_to_calls_terminated_by.js` | `calls.terminated_by` gains `CONSUMER` |
| `20260930120000_add_history_indexes_and_lifecycle_tenant.js` | `calls` `(tenant_id, created_at)` and `(tenant_id, ended_at)`; `call_lifecycle_events.tenant_id` (backfilled) + `(tenant_id, occurred_at)`; `agent_push_tokens` unique `(provider, token)`, `is_active` dropped |
| `20260930150000_add_consumer_event_types.js` | `consumers.event_types` |
| `20261001120000_create_call_participants_table.js` | `call_participants` |

## Overview

Callio knows nothing about any consumer's business domain. Consumers
provision what Callio needs through the Management API and correlate with
their own records via opaque `external_ref` values that Callio stores but
never reads.

```
consumer ─┬─ api keys, signing keys, webhook_deliveries
          ├─ sip_trunks (consumer-owned; NULL consumer = platform trunk)
          └─ tenant ─┬─ agents ── push tokens
                     ├─ queues ── queue_members (agent, priority)
                     ├─ channels (WHATSAPP | SIP) ── inbound queue, IVR flows
                     ├─ audio_assets
                     └─ calls ─┬─ call_connections (AGENT | CUSTOMER | MONITOR legs)
                               ├─ call_lifecycle_events, call_transfer_logs
                               ├─ ivr_sessions ── ivr_session_inputs
                               └─ call_recordings
```

| Table | What it is |
|---|---|
| `consumers` | An integrating product: API auth, agent-token signing, event delivery. |
| `consumer_api_keys` | Server-to-server API keys (SHA-256 hash only; several active for rotation). |
| `consumer_signing_keys` | HS256 secrets the consumer signs agent JWTs with, selected by `kid`. |
| `tenants` | An isolated routing space inside a consumer. Tenant-wide policies in `settings`. |
| `agents` | People who handle or supervise calls: role and live availability. |
| `agent_push_tokens` | Push targets per agent device and provider. |
| `audio_assets` | Audio Callio plays: IVR prompts, queue hold audio. `tenant_id` NULL = platform default. |
| `queues`, `queue_members` | Where calls wait for an agent; members with priority. |
| `sip_trunks` | Carrier connections SIP channels arrive on and dial out through. |
| `channels` | Customer-facing lines: `WHATSAPP` (a Meta phone number) or `SIP` (a DID). |
| `ivr_flows` | IVR flow graphs and their trigger conditions, tenant-wide or per channel. |
| `calls` | One row per call between a channel and a customer. |
| `call_participants` | Who is in a call (customer, agents, supervisors), when they joined and left. |
| `call_connections` | One row per media leg type per call. |
| `call_lifecycle_events` | Append-only audit trail per call. |
| `call_transfer_logs` | Transfers to an agent or into a queue. |
| `ivr_sessions`, `ivr_session_inputs` | IVR runs and their DTMF input. |
| `call_recordings` | Stereo recordings and their lifecycle. |
| `webhook_deliveries` | Outbox of events for consumers, delivered with retries (`src/outbox/OutboxDispatcher.js`). |
| `api_idempotency_keys` | `Idempotency-Key`s of Management API POSTs and the responses to replay, for 24 h. |

## Conventions

- **Only what Callio acts on is stored.** A consumer's own identifiers go in
  `external_ref` (indexed, never interpreted); anything else it wants attached
  to a call goes in `calls.consumer_metadata`.
- **Tenant scoping** on call child tables comes through `call_id → calls.tenant_id`,
  not a copied `tenant_id` column.
- **A leg's role is separate from its transport.** `call_connections.connection_type`
  says what a leg is for; `calls.channel` says how the customer is connected.
  Adding a channel never means adding a leg type.
- **The customer is stored once, direction-independent**: `customer_address` +
  `customer_address_type` + `customer_name`, with `channel_address` for our side.
- **Growing vocabularies are strings, fixed ones are ENUMs.** Event types
  (`call_lifecycle_events.event_type`, `webhook_deliveries.event_type`) are
  validated in code; statuses, leg types, termination reasons stay ENUMs.
  ENUMs are uppercase except `ivr_sessions.outcome`,
  `call_transfer_logs.initiated_by_type` and `call_recordings.status`, which are lowercase.
- **Secret-bearing columns** (`consumer_signing_keys.secret`,
  `consumers.event_webhook_secret`, `consumers.push_credentials`,
  `channels.credentials`, `sip_trunks.credentials`) are TEXT holding ciphertext
  encrypted with `CALLIO_MASTER_KEY` (`src/infra/crypto/secretBox.js`).
- **Timestamps are UTC** (`timezone: 'Z'`, session `time_zone = '+00:00'`).

## Tables

Only the columns that need explanation; see each migration for the full list.

### consumers

| Column | Notes |
|---|---|
| `slug` | Unique; used by the CLI scripts (`consumer:create`, `agent:token`). |
| `status` | `ACTIVE` / `SUSPENDED`. A suspended consumer's API keys get 403 (`src/http/auth/apiKeyAuth.js`) and its agent tokens are refused (`src/realtime/middleware/authMiddleware.js`). |
| `event_webhook_url`, `event_webhook_secret` | Where events are POSTed, and the signing secret (encrypted). Set by the consumer with `PUT /v1/webhook`. |
| `event_types` | JSON array of the event types the consumer receives; `NULL` = every type. Others are never written to its outbox. |
| `lookup_url` | Optional pre-ring customer lookup (`src/core/calls/CustomerLookup.js`); short timeout, failures never block the call. |
| `push_credentials` | Encrypted JSON, one optional section per provider: `fcm` `{ service_account }`, `apns` `{ key_p8, key_id, team_id, bundle_id, production }`, `onesignal` `{ app_id, rest_api_key }`. Pushes to the consumer's agents use it; a provider not set falls back to the platform credentials from env (`src/push/PushCredentials.js`). Set with `PUT /v1/push-credentials/{provider}` or `npm run push:credentials`. |

`consumer_api_keys`: `key_hash` unique, `key_prefix` for identifying a key in
logs/UI, `expires_at` / `revoked_at`, `last_used_at` updated on use.
`consumer_signing_keys`: unique (`consumer_id`, `kid`), `revoked_at`.

### tenants

Unique (`consumer_id`, `external_ref`); `status` `ACTIVE` / `SUSPENDED`.
`settings` (JSON) holds the tenant-wide policies that aren't per queue
(read by `src/persistence/TenantRepository.js`):

| Key | Meaning |
|---|---|
| `auto_offline.enabled` | Take an agent offline after consecutive missed offers (`src/core/routing/AutoOfflinePolicy.js`). |
| `auto_offline.missed_threshold` | How many consecutive misses; default 3. |
| `recording.storage_limit_bytes` | Quota across all the tenant's recordings; unset = the platform default. |

### agents

| Column | Notes |
|---|---|
| `external_ref` | The consumer's id for this person — the JWT `sub`. Unique per tenant. |
| `role` | `AGENT` / `SUPERVISOR` (supervisors also monitor, whisper, barge, transfer). |
| `availability` | The shift: `AVAILABLE` / `OFFLINE`, plus `availability_changed_at`. Only queues read it. `ON_CALL` is a legacy value no code writes any more (read as `AVAILABLE`; a later migration drops it). |
| `busy_call_id` | The call holding the agent, or NULL. Claimed with a guarded update (`busy_call_id IS NULL`) when routing offers them a call, a `RING_ALL` accept or `call:start`, and released only by that call (`AgentRepository`). The API and events report `ON_CALL` while it is set. Agents left held by an ended or deleted call are released by the cleanup loop. |
| `deleted_at` | Soft delete: deleting sets it, `availability = 'OFFLINE'` and `busy_call_id = NULL`; every lookup filters `deleted_at IS NULL`; re-provisioning the same `external_ref` clears it (`src/persistence/AgentRepository.js`). |

### agent_push_tokens

One row per (`agent_id`, `device_id`, `provider`), unique. `platform`
`ANDROID` / `IOS` / `WEB`; `provider` `FCM` / `APNS_VOIP` / `ONESIGNAL`;
`last_seen_at`. A token is unique per `provider` (one device): registering it
for another device or agent moves it. `device_id` is also written to
`call_connections.device_id` to know which device answered.

### audio_assets

`tenant_id` NULL = platform-wide. `storage_provider` (default `s3`),
`storage_key`, `mime_type`, `duration_seconds`, `file_size_bytes`.

### queues, queue_members

| Column | Notes |
|---|---|
| `strategy` | `RING_ALL` (every available member at once), `ROUND_ROBIN` (one at a time, rotating), `PRIORITY` (lowest `queue_members.priority` first, then agent id). Interpreted only by `src/core/routing/QueueRouter.js`. |
| `ring_timeout_seconds` | How long one agent is offered a call before it moves on / counts as missed. NULL = ring until answered or the customer hangs up. |
| `max_wait_seconds` | After waiting this long (from `calls.queued_at`) the call moves to `overflow_queue_id`, or ends as `TIMEOUT` if none. NULL = wait indefinitely. |
| `overflow_queue_id` | Self-reference, `SET NULL` on delete. |
| `max_active_calls` | Cap on calls handled from this queue at once (answered, plus outbound still setting up). NULL = no cap. |
| `hold_audio_asset_id` | Queue hold audio. |
| `status` | `ACTIVE` / `DISABLED`; routing treats a disabled queue as no queue (`QueueRouter.getQueue`), and it can't be a transfer target. |

`queue_members`: primary key (`queue_id`, `agent_id`); `priority` (default 1)
matters only under `PRIORITY`.

### sip_trunks

| Column | Notes |
|---|---|
| `consumer_id` | NULL = a platform trunk shared by every consumer. |
| `host`, `port`, `transport` | Where outbound INVITEs go; `transport` `UDP` / `TCP` / `TLS` (default `UDP`), used in the request URI (`src/channels/sip/SipChannel.js`). |
| `credentials` | Encrypted JSON `{ username, password }` for digest auth. |
| `inbound_source_cidrs` | JSON array of CIDRs inbound INVITEs may come from (`src/channels/sip/sipAddress.js`). Empty/NULL = any source (development only). |
| `number_rules` | JSON `{ country_code, national_prefix? }` for a carrier that sends national numbers (`applyNumberRules` in `sipAddress.js`). NULL = numbers arrive in E.164. |
| `status` | `ACTIVE` / `DISABLED`. |

Created with `npm run sip:trunk`.

### channels

| Column | Notes |
|---|---|
| `type` | `WHATSAPP` / `SIP`. |
| `address` | WhatsApp: the business phone number. SIP: the DID (E.164) inbound INVITEs resolve by. |
| `provider_account_id` | WhatsApp: the Meta `phone_number_id` inbound webhooks resolve by. |
| `sip_trunk_id` | SIP: the trunk it arrives on / dials out through. |
| `credentials` | Encrypted JSON (WhatsApp: `{ access_token }`). |
| `inbound_queue_id` | A shared line: where inbound calls wait when no IVR flow takes them. |
| `owner_agent_id` | A personal line: the agent its inbound calls ring and the only one who may call out from it. Never together with `inbound_queue_id` (API-enforced). FK, `SET NULL` on delete. |
| `ring_timeout_seconds` | Personal line: how long it rings the owner before `NO_ANSWER` (NULL = 30). |
| `recording_enabled`, `display_name`, `status` (`ACTIVE` / `DISABLED`) | |

Unique: (`tenant_id`, `external_ref`), (`type`, `address`),
(`type`, `provider_account_id`) — an address or provider account belongs to
one channel across all consumers.

### ivr_flows

| Column | Notes |
|---|---|
| `channel_id` | NULL = tenant-wide. |
| `structure`, `schema_version` | The flow graph `src/core/ivr/IvrEngine.js` runs (`{ nodes[], edges[] }`; node types `ivr_start` / `ivr_menu` / `ivr_play` / `ivr_transfer` / `ivr_hangup`; edge `sourceHandle` = DTMF digit). Ids inside nodes are Callio ids (audio assets, queues, agents). |
| `trigger_condition` | `ALWAYS` / `ALL_AGENTS_BUSY` / `ALL_AGENTS_OFFLINE` / `ALL_AGENTS_UNAVAILABLE`, evaluated against the members of the channel's inbound queue. |
| `trigger_priority` | Lower is tried first. |
| `timeout_seconds` | DTMF wait on a menu node (default 10). |
| `agent_ring_timeout` | How long an agent may ring after an IVR transfer before the call ends as `IVR_AGENT_NO_ANSWER` (default 60). |
| `status` | `ACTIVE` / `INACTIVE` (default `INACTIVE`). |

Selection on an inbound call: channel-specific flows before tenant-wide ones,
then `trigger_priority` ascending, then most recently updated; the first
whose `trigger_condition` holds wins.

### calls

| Column | Notes |
|---|---|
| `tenant_id`, `channel_id`, `queue_id`, `agent_id`, `ivr_flow_id` | `agent_id` is the agent handling or currently offered the call. |
| `channel` | `WHATSAPP` / `SIP`, denormalised from `channels.type` so the call keeps its transport. |
| `channel_address` | Snapshot of our side of the line. |
| `provider_call_id` | Meta call id / SIP Call-ID; unique per (`channel`, `provider_call_id`). |
| `customer_address`, `customer_address_type`, `customer_name` | Type `E164` / `WHATSAPP_USER` (a business-scoped user id) / `SIP_URI`. |
| `external_ref`, `consumer_metadata` | The consumer's: stored and returned, never read. |
| `metadata` | Callio's own (e.g. provider-specific identifiers). |
| `type`, `direction` | `AUDIO` / `VIDEO`; `INBOUND` / `OUTBOUND`. |
| `status` | `INITIATED` / `RINGING` / `IN_PROGRESS` / `TERMINATED` / `FAILED`. |
| `state` | Where the call is within its status: `IVR` / `QUEUE` / `ACTIVE` / `ON_HOLD`, NULL before routing. `ON_HOLD` is not set by the code. |
| `termination_reason` | `COMPLETED`, `CANCELLED`, `REJECTED`, `BUSY`, `NO_ANSWER`, `TIMEOUT`, `AGENT_DISCONNECTED`, `AGENT_MEDIA_NOT_READY`, `SYSTEM_ERROR`, `NETWORK_ERROR`, `PROVIDER_ERROR`, `PROVIDER_TRIGGER_FAILED`, `SERVICE_MAINTENANCE`, `CUSTOMER_NETWORK_LOSS`, `IVR_AGENT_NO_ANSWER`. |
| `terminated_by` | `AGENT` (agent or supervisor) / `CONSUMER` (Management API terminate) / `CUSTOMER` / `PROVIDER` / `SYSTEM`. |
| `ringing_at`, `answered_at`, `ended_at` | |
| `queued_at` | When the call entered its current queue (arrival, IVR transfer, overflow); `max_wait_seconds` counts from here. |
| `offered_at` | When the current offer to `agent_id` started; NULL while nobody is offered it and once the agent starts answering. `ring_timeout_seconds` counts from here. On an `IN_PROGRESS` call it marks a transfer waiting for its target. |
| `overflow_count` | Overflows so far; `src/core/routing/QueueTimeoutService.js` stops at 3 so overflow loops end. |
| `ringing_duration`, `call_duration`, `queue_duration` | Seconds. `queue_duration`: entering the queue → an agent answering (or the end), set when the call ends. `on_hold_duration` is unused (there is no hold yet). |
| `failure_details` | JSON `{ errors: [{ code, title, details, source }], provider_callback_data }`. |

Indexes: (`tenant_id`, `status`, `created_at`), (`tenant_id`, `external_ref`),
(`tenant_id`, `customer_address`), (`queue_id`, `status`, `agent_id`,
`ringing_at`) for unassigned-queue scans, (`agent_id`, `status`),
(`status`, `queue_id`, `offered_at`) and (`status`, `queue_id`, `queued_at`)
for the timeout scans, plus `channel_id`, `ivr_flow_id`.

### call_connections

One row per (`call_id`, `connection_type`), unique — the SDP record of each
media leg, written by `src/core/media/MediaLegs.js`: a new offer, a transfer
or a reconnect replaces the `AGENT` row, and one supervisor monitors at a time.
`agent_id` and `device_id` are who is on the leg now (a reloaded client's
resync reads them, and a ringing call's `local_sdp` is the offer it is
re-delivered with). Who was in the call over time is `call_participants`.

| Column | Values |
|---|---|
| `connection_type` | `AGENT` (an agent's WebRTC peer), `CUSTOMER` (over WhatsApp or SIP), `MONITOR` (a supervisor). |
| `connection_state` | `NEW` (offered) / `CONNECTED` (answered) / `CLOSED` (the call ended). |
| `ice_gathering_state`, `ice_connection_state` | Not tracked since media left Node (stay `NEW` until `CLOSED`). |
| `sdp_type`, `local_sdp`, `remote_sdp`, `ice_candidates`, `media_types` | Diagnostics. |

### call_participants

Who is in a call: one row per stay. A transfer closes the old agent's row
(`TRANSFERRED`) and the new agent gets one on accept; supervisors get one per
monitoring session; the call ending closes every open row (`ENDED`). Open
while `left_at` is NULL; `src/core/calls/CallParticipants.js` keeps at most one
open row per (call, kind, agent). Replaces `call_connections` once media leaves
Node ([media-architecture.md](media-architecture.md#data-model)).

| Column | Values |
|---|---|
| `kind` | `CUSTOMER` / `AGENT` / `SUPERVISOR`. |
| `agent_id`, `device_id` | The agent or supervisor, and their device (updated on a reconnect). NULL for the customer. |
| `media_node` | The media server the leg runs on (set once media runs there). |
| `joined_at`, `left_at`, `leave_reason` | `leave_reason`: `ENDED` / `TRANSFERRED` / `MONITOR_STOPPED`. |

### call_lifecycle_events

`event_type` string (64), validated in code; `tenant_id` (the call's, for
per-tenant reads such as the reports), `agent_id`, `occurred_at`,
`duration_seconds`, `metadata`. Written by `src/core/calls/CallLifecycleLogger.js`.
Deleted with the rest of a call's detail after the retention period (see
[Retention](#retention)).

### call_transfer_logs

One row per transfer: `to_agent_id`, or `to_queue_id` (with `to_agent_id`
filled once someone accepts). `from_agent_id`, `initiated_by_agent_id`,
`initiated_by_type` (lowercase: `agent` / `supervisor` / `system`),
`transferred_at`, `accepted_at`, `acceptance_duration_seconds`.

### ivr_sessions, ivr_session_inputs

One session per IVR run: `completed`, `outcome` (lowercase: `transferred` /
`hung_up` / `timeout` / `error`), `duration`, `started_at`, `ended_at`;
`ivr_flow_id` is `SET NULL` on flow deletion so history survives. One input
row per DTMF press: `node_name`, `input`, `pressed_at`.

### call_recordings

One stereo recording per call (`channel_map` default
`left=customer,right=agent`, `format` default `ogg`), uploaded to object
storage under `storage_key`.

| Column | Notes |
|---|---|
| `status` | Lowercase: `recording` → `processing` → `completed`, or `failed` (including stale `recording`/`processing` rows swept by `src/core/calls/CallCleanupService.js`). `purged`: removed from storage by the retention job (`storage_key` cleared, `purged_at` set). `pending_deletion` is not set yet. |
| `error_message`, `started_at`, `completed_at`, `duration_seconds`, `file_size_bytes` | |
| `purged_at` | When the retention job removed it. |
| `retained_until`, `scheduled_purge_at`, `deletion_requested_by_ref`, `deletion_requested_at` | Not used yet. |

Only `completed` recordings count toward the tenant quota and can be fetched
through the API.

### webhook_deliveries

`event_id` (UUID, unique, sent with the payload for de-duplication),
`event_type`, `payload`, `status` `PENDING` / `DELIVERED` / `FAILED`,
`attempts`, `next_attempt_at`, `last_response_status`, `last_error`,
`delivered_at`. See `docs/events.md`.

`dedupe_key` (unique, nullable) is `<call_id>:<event_type>` for the events a
call has at most once (`call.created`, `call.answered`, `call.ended`): the
unique key, not a flag set before the write, keeps several workers from
writing one twice. The same rows serve `GET /v1/events`.

### api_idempotency_keys

One row per (`consumer_id`, `idempotency_key`): `request_hash` (SHA-256 of
method, path and body), `status` `IN_PROGRESS` / `COMPLETED`,
`response_status`, `response_body`, `expires_at` (24 h; expired rows are
purged as keys are used). Written by `src/http/v1/idempotency.js`.

## Retention

`src/core/calls/RetentionService.js` removes old data. One sweep runs per
`RETENTION_SWEEP_SECONDS` (1 h) across all workers, in bounded batches. A
value of `0` keeps that data.

| Data | Removed after | Setting |
|---|---|---|
| A call's `call_lifecycle_events`, `call_connections`, `call_transfer_logs`, `ivr_sessions` (+ inputs) | the call ended 180 days ago | `CALL_DETAIL_RETENTION_DAYS` |
| `call_connections.local_sdp` / `remote_sdp` / `ice_candidates` (cleared, row kept) | the call ended 24 h ago | `CALL_SDP_RETENTION_HOURS` |
| `webhook_deliveries` that are `DELIVERED` or `FAILED` (never `PENDING`) | 30 days | `WEBHOOK_DELIVERY_RETENTION_DAYS` |
| `call_recordings`: the stored object, then `status = purged` | never by default | `RECORDING_RETENTION_DAYS`, or a tenant's `settings.recording.retention_days` |

The `calls` rows, the call record itself, are kept.

## Reference: migrating from the old midlr schema

The call tables started as a reconstruction of midlr's production tables and
were then made consumer-agnostic. The headers of the queues, calls and
call_recordings migrations list their differences in detail. For moving data
or writing midlr's integration:

| midlr | Callio |
|---|---|
| `businesses` | `tenants` |
| `users` + role permissions + `call_availability` | `agents` |
| `business_numbers` + `businesses.token` | `channels` |
| `businesses.call_settings` routing, `has_call_center`, `user_groups` | `queues` + `queue_members` (mapping in the queues migration header) |
| `ivr_menus` | `ivr_flows` |
| `media_files` (audio), `platform_settings` queue audio | `audio_assets` |
| `user_devices`, `users.fcm_token`, `notification_subscriptions` | `agent_push_tokens` |
| `chat_messages` call rows | events via `webhook_deliveries` |
| `business_id` | `tenant_id` |
| `user_id` (agent) | `agent_id` |
| `business_number_id` | `channel_id` |
| `ivr_menu_id` | `ivr_flow_id` |
| `client_number_id`, `caller_*`/`callee_*` | `customer_address` / `customer_address_type` / `customer_name` + `channel_address` |
| `wacid` | `provider_call_id` (unique per `channel`) |
| `callback_data` | `failure_details` |
| `is_billed`/`is_billable` | removed |
| `connection_type` FRONTEND/WHATSAPP | AGENT/CUSTOMER |
| `terminated_by` BUSINESS/CLIENT/WHATSAPP | AGENT/CUSTOMER/PROVIDER |
| `WHATSAPP_TRIGGER_FAILED` | `PROVIDER_TRIGGER_FAILED` |
| `call_recordings.recording_url` | `storage_key` |
| `call_recordings.business_id` | removed (tenant via `call_id`) |
| `call_recordings.deletion_requested_by` | `deletion_requested_by_ref` (opaque) |
