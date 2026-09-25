# Migrations

Knex migrations for Callio's own database. Callio is a standalone service:
it runs against its **own** MySQL database (e.g. `callio`), never a
consumer's. These migrations create that database's full schema from
scratch — run them with `npm run migrate:latest` against an empty database.

```bash
npm run migrate:status     # what has / hasn't run
npm run migrate:latest     # apply pending migrations
npm run migrate:rollback   # undo the last batch
npm run migrate:make -- <name>
```

Every schema change — new column, enum value, index — is a new migration
here. Never `ALTER TABLE` by hand, and never let a consumer's migration
system touch this database.

## Data model

Callio knows nothing about any consumer's business domain. Consumers
provision what Callio needs through its API and correlate with their own
records via opaque `external_ref` values that Callio stores but never reads.

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
| `consumers` | An integrating product (midlr, others). Event webhook URL, push credentials. |
| `consumer_api_keys` | Server-to-server API keys (hashed, several active for rotation). |
| `consumer_signing_keys` | Secrets the consumer signs agent JWTs with, selected by `kid`. |
| `tenants` | An isolated routing space inside a consumer (for midlr: one business). Tenant-wide auto-offline and recording-quota policy. |
| `agents` | People who handle or supervise calls. Role (`AGENT`/`SUPERVISOR`) and live availability. |
| `agent_push_tokens` | Push targets per agent device and provider (FCM, APNs VoIP, OneSignal). |
| `audio_assets` | Audio Callio plays: IVR prompts, queue hold audio. `tenant_id` NULL = platform default. |
| `queues`, `queue_members` | Where calls wait: strategy (`RING_ALL`/`ROUND_ROBIN`/`PRIORITY`), ring timeout, overflow, hold audio; members with priority. |
| `sip_trunks` | Carrier connections SIP channels arrive on and dial out through. |
| `channels` | Customer-facing lines: `WHATSAPP` (a Meta phone number) or `SIP` (a DID), with provider credentials and an inbound queue. |
| `ivr_flows` | IVR flow graphs and their trigger conditions, tenant-wide or per channel. |
| `calls` | One row per call between a channel and a customer. |
| `call_connections` | One row per media leg: `AGENT`, `CUSTOMER`, `MONITOR`. |
| `call_lifecycle_events` | Append-only audit trail per call. |
| `call_transfer_logs` | Transfers to an agent or into a queue. |
| `ivr_sessions`, `ivr_session_inputs` | IVR runs and DTMF input. |
| `call_recordings` | Stereo recordings and their retention/purge lifecycle. |
| `webhook_deliveries` | Outbox of events for consumers, delivered with retries. |

Conventions:
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
  (`call_lifecycle_events`, `webhook_deliveries`) are validated in code;
  call status, leg type, termination reason etc. stay ENUMs.
- **Secret-bearing columns** (`consumer_signing_keys.secret`,
  `event_webhook_secret`, `push_credentials`, `channels.credentials`,
  `sip_trunks.credentials`) hold ciphertext encrypted by the application.

## Relationship to midlr's schema

The call tables started as a reconstruction of midlr's production tables
(traced through the Laravel repo's migration history) and were then made
consumer-agnostic. Each migration's header lists what changed from the midlr
version. The main renames, useful when writing midlr's integration later:

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
