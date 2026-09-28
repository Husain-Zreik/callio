# Callio platform architecture

How Callio is structured as a standalone calling service, and exactly how
external projects integrate with it. midlr is the first consumer, not a
special one: nothing in this document, the schema or the code may assume a
particular consumer.

Companion documents: `migrations/README.md` (data model), `SIP_INTEGRATION.md`
(SIP gateway), `ARCHITECTURE.md` (current internals, pre-restructure).

---

## 1. What Callio is — and isn't

Callio is a **contact-center call engine**. It connects customers who call in
over a channel (WhatsApp Calling, SIP/PSTN) to agents in a browser or app, and
runs everything in between: routing and queues, IVR, agent assignment,
transfers, supervisor monitoring, recording, and the call record.

Every media leg terminates at Callio — the customer leg (WhatsApp WebRTC or
SIP via rtpengine) and each agent/supervisor leg (WebRTC). Callio bridges
them. Agents never talk to the provider directly, and consumers never touch
media.

| Callio owns | The consuming product owns |
|---|---|
| Channels (lines) and their provider credentials | Its own users, login, permissions and UI |
| Routing: queues, strategies, IVR flows, audio | Its customer/CRM records ("who is +961…") |
| Agent availability and live presence | Consent to call a customer (outbound) |
| Call state, legs, lifecycle audit, transfers | Billing and rates |
| Recordings and their retention | Chat timelines, tickets, reporting UI |
| Push delivery of incoming calls to agent devices | Mapping its entities to Callio's (external_ref) |

Rule: **if only one product would ever want it, it isn't Callio's.** Products
attach their own meaning through `external_ref` and `consumer_metadata`, which
Callio stores and returns but never interprets.

---

## 2. Actors

```
                ┌──────────────────────────── Consumer product ────────────────────────────┐
                │  Backend (server)                         Agent clients (web / mobile)    │
                └──────┬───────────────▲──────────────────────────────┬──────────▲──────────┘
      (A) REST, API key│    (B) event   │ webhooks (HMAC)   (C) socket│+ WebRTC   │ (E) push
                       ▼               │                    JWT      ▼          │
                ┌──────────────────────┴────────── Callio ───────────────────────┴──────────┐
                │  Management API │ Event outbox │ Agent gateway │ Media engine │ Push       │
                └──────▲──────────────────────────────────────────────────────▲─────────────┘
          (D) provider │ webhooks                                  SIP + RTP  │
                ┌──────┴───────┐                                   ┌──────────┴─────────┐
                │ Meta (WhatsApp)│                                  │ SIP trunk (carrier) │
                └──────────────┘                                   └────────────────────┘
```

- **Consumer backend** — the product's server. Provisions, starts outbound
  calls, reads history, receives events. Never in the media path.
- **Agent client** — the product's web/mobile app, used by its staff. Connects
  to Callio directly for signaling and media, using a token the consumer
  backend issued. Uses the Callio client SDK.
- **Providers** — Meta and SIP carriers. Talk only to Callio.
- **Customers** — never interact with Callio or the consumer directly; they
  are on the other end of a channel.

---

## 3. Integration surfaces — the public contract

Five surfaces, each with one auth model and one audience. Everything
external projects depend on is one of these; anything else is internal and
may change freely.

### (A) Management API — consumer backend → Callio

REST, JSON, versioned under `/v1`. Auth: `Authorization: Bearer <api key>`
(`consumer_api_keys`, hashed, rotatable). Every request is scoped to the
calling consumer; a consumer can never see another's tenants.

**Idempotent by external_ref.** Consumers address their own entities by their
own ids, so they never have to store Callio ids:

```
PUT  /v1/tenants/{tenant_ref}                              upsert tenant
PUT  /v1/tenants/{tenant_ref}/agents/{agent_ref}           upsert agent (name, role)
DELETE …/agents/{agent_ref}                                 soft-delete
PUT  /v1/tenants/{tenant_ref}/queues/{queue_ref}           upsert queue (strategy, timeouts, overflow)
PUT  …/queues/{queue_ref}/members                           replace members [{agent_ref, priority}]
PUT  /v1/tenants/{tenant_ref}/channels/{channel_ref}       upsert channel (type, address, credentials, inbound queue)
PUT  /v1/tenants/{tenant_ref}/ivr-flows/{flow_ref}         upsert flow (structure, trigger)
POST /v1/tenants/{tenant_ref}/audio-assets                 upload audio → id
PUT  …/agents/{agent_ref}/push-tokens/{device_id}          register device push token
DELETE …/agents/{agent_ref}/push-tokens/{device_id}
```

**Call control and queries:**

```
POST /v1/tenants/{tenant_ref}/calls           create an outbound call intent (see §5.2)
GET  /v1/tenants/{tenant_ref}/calls?…         list/filter (status, agent, channel, external_ref, time)
GET  /v1/calls/{call_id}                      call + legs + lifecycle + transfers
POST /v1/calls/{call_id}/terminate            end a call from the backend
GET  /v1/calls/{call_id}/recording            signed, short-lived download URL
PATCH /v1/calls/{call_id}                     set external_ref / consumer_metadata
PUT  /v1/tenants/{tenant_ref}/agents/{agent_ref}/availability   force availability
```

**Operational:** `GET /v1/health`, and per-consumer rate limits.

### (B) Event webhooks — Callio → consumer backend

Callio POSTs events to the consumer's `event_webhook_url`. This is how a
product learns what happened: to write its own chat timeline, update its CRM,
bill, or report. No product ever reads Callio's database.

- Written to the `webhook_deliveries` outbox in the same step as the change
  that caused it, delivered by a worker with exponential backoff; at-least-once.
- Signed: `X-Callio-Signature: t=<ts>,v1=<HMAC-SHA256(secret, ts.body)>`;
  consumers reject stale timestamps.
- Envelope: `{ event_id, event_type, api_version, occurred_at, tenant_ref, data }`.
  `event_id` is stable across retries — consumers de-duplicate on it.
- Ordering is not guaranteed across events; each carries the full current
  call snapshot so consumers can apply "latest `occurred_at` wins".

Event catalog (v1):

| Event | When |
|---|---|
| `call.created` | Inbound call arrived / outbound intent created |
| `call.ringing` | Ringing an agent (inbound) or the customer (outbound) |
| `call.queued` | Waiting in a queue |
| `call.ivr.completed` | IVR session ended (outcome, inputs) |
| `call.assigned` | Offered to / claimed by an agent |
| `call.answered` | Media connected between customer and agent |
| `call.transferred` | Moved to another agent or queue |
| `call.ended` | Terminated or failed — reason, durations, terminated_by |
| `recording.completed` | Recording uploaded and available |
| `agent.availability.changed` | AVAILABLE / ON_CALL / OFFLINE |

### (C) Agent gateway — agent client ↔ Callio

The only realtime surface. Socket.IO over WebSocket only (no polling), plus
the WebRTC media connection to Callio's media engine. It exists because
WebRTC needs a bidirectional signaling channel (SDP, trickle ICE,
reconnects) and because ringing must reach agents instantly — neither fits
HTTP.

**Auth.** The consumer backend signs a short-lived JWT (HS256, 5–15 min) with
one of its `consumer_signing_keys`:

```json
header  { "alg": "HS256", "kid": "k1" }
payload { "iss": "<consumer slug>", "sub": "<agent_ref>", "tnt": "<tenant_ref>",
          "name": "Display Name", "role": "AGENT", "exp": 1790000000 }
```

Callio resolves `iss` → consumer, `kid` → key, `tnt` → tenant, `sub` → agent.
If the agent doesn't exist yet it is created from `name`/`role`
(just-in-time provisioning); the Management API remains the way to set queue
membership and to change roles. Tokens are refreshed by reconnecting.

**Protocol.** Versioned (`auth.protocol = 1` in the handshake) and documented
as a message catalog in `docs/agent-protocol.md`. Client → server:
`call:accept`, `call:reject`, `call:start` (outbound, §5.2), `call:terminate`,
`call:transfer`, `call:reconnect`, `connection:ice-candidate`,
`call:monitor{,:mode,:stop}`, `call:agent:private`, `call:agent:muted`,
`agent:availability:set`, `calls:sync`. Server → client: `call:incoming`,
`call:offer_withdrawn`, `call:started`, `call:handled`, `call:terminated`,
`call:transferred`, `call:agent_queue`, `call:agent_availability`, ICE/SDP
replies, supervisor events. The full catalog is in `docs/agent-protocol.md`.

**Rules the gateway enforces** (fixing today's gaps): a socket only joins a
call's room after the core confirms it is that call's agent or a supervisor
of that tenant; identity (agent, tenant) always comes from the token, never
from payloads; server events go to the narrowest audience (the agent, the
call room, or the tenant's supervisors — never "everyone in the tenant" for
call data).

**Client SDK.** Consumers should not reimplement the protocol and WebRTC
handling. Callio ships `@callio/agent-sdk` (JS first; Flutter later) that
wraps connect/auth, incoming-call events, accept/reject, media, reconnect,
and monitoring. The socket protocol is the contract; the SDK is the
supported way to use it.

### (D) Channel ingress — providers → Callio

- **WhatsApp:** Meta posts call webhooks to `POST /webhooks/whatsapp`,
  verified with Meta's `X-Hub-Signature-256` using the app secret; the
  channel is resolved by `metadata.phone_number_id` →
  `channels.provider_account_id`. For consumers whose Meta app webhook must
  keep pointing at their own backend (because it also carries messages),
  `POST /v1/webhooks/whatsapp/forward` accepts the same payload forwarded
  server-to-server with an API key — today's midlr path, generalised.
- **SIP:** inbound INVITEs arrive at drachtio on the trunks in `sip_trunks`;
  the channel is resolved by the dialled DID → `channels.address`.

### (E) Push — Callio → agent devices

When an agent's app isn't connected, Callio wakes it with FCM (Android),
APNs VoIP/PushKit (iOS CallKit) or OneSignal (web). Tokens are registered
through (A). Today the push credentials are the platform's (env); per-consumer
credentials (`consumers.push_credentials`, so pushes come from each
consumer's own app) are the next step. The payload is one documented shape
(`{ type: "call.incoming" | "call.cancelled", call_id, tenant_ref,
customer_name, customer_address, channel }`); anything app-specific (deep-link
URLs, CallKit field names) is per-consumer configuration, not code.

### Optional: synchronous lookup hook

Consumers that want to enrich an inbound call before it rings (show the
customer's CRM name, attach their own ids, or reject blocked numbers) set a
`lookup_url`. Callio calls it with the channel and customer address, waits at
most ~1.5 s, and on timeout or error continues without it — a consumer
outage can delay a call by at most the timeout, never drop it. Response:
`{ customer_name?, external_ref?, consumer_metadata?, action?: "reject" }`.

---

## 4. Tenancy and identity

```
consumer (API keys, signing keys, webhook, push credentials)
  └─ tenant            ← consumer's workspace/business   (external_ref)
       ├─ agents       ← consumer's staff users          (external_ref = JWT sub)
       ├─ queues + members
       ├─ channels     ← lines, one tenant each
       ├─ ivr_flows, audio_assets
       └─ calls
```

- Every repository query is scoped by `tenant_id`, resolved from the API key
  or JWT — never from request payloads. Cross-tenant access is impossible by
  construction, not by checks sprinkled in handlers.
- Callio ids are returned in responses and events, but consumers never need
  to store them: external refs are unique per scope and accepted everywhere.
- Secrets (signing keys, webhook secret, push and channel credentials) are
  encrypted at rest with a Callio master key from the environment.

---

## 5. The three call flows, end to end

### 5.1 Inbound

```
Customer dials ─► provider ─► (D) ingress ─► channel → tenant
  ─► [optional lookup hook] ─► IVR flow if one triggers ─► queue
  ─► AgentPicker offers to agent(s): (C) call:incoming + (E) push if offline
  ─► agent call:accept (SDP) ─► media engine bridges customer ↔ agent
  ─► (B) call.created, call.queued, call.assigned, call.answered … call.ended
```

### 5.2 Outbound — the consumer decides, the agent connects

Consent to call a customer belongs to the consumer, so outbound starts on the
consumer backend, not the agent socket:

```
1. Agent clicks "call" in the product UI.
2. Product backend checks its own consent rules, then
   POST /v1/tenants/{t}/calls { channel_ref, agent_ref, customer_address,
                                 customer_name?, external_ref?, consumer_metadata? }
   → { call_id, status: "INITIATED" }
3. Product passes call_id to the agent's client; the SDK emits
   call:start { call_id, sdpOffer }. Callio checks the call belongs to that
   agent, answers the agent leg, then dials the customer via the channel.
4. Events flow as for inbound (call.ringing … call.ended).
```

This removes the current `call:initiate`, which trusts client-supplied
customer and line ids and has no place for a consent check.

### 5.3 Transfer and monitoring

Initiated by agents/supervisors over (C), or by the backend over (A). Targets
are an agent or a queue. Supervisors join as MONITOR legs (listen / whisper /
barge); several may monitor one call.

---

## 6. Internal architecture — ports and adapters

The core call engine must not know which consumer, channel provider, push
provider, database or transport it runs with. Dependencies point inward:
adapters depend on the core's ports, never the reverse.

```
          inbound adapters                 core                    outbound adapters
 ┌────────────────────────────┐   ┌──────────────────────┐   ┌──────────────────────────────┐
 │ http/v1 (Management API)   │   │ application services │   │ channels/whatsapp (Graph API) │
 │ channel ingress (Meta, SIP)│──►│  calls · routing ·   │──►│ channels/sip (drachtio)       │
 │ realtime (agent gateway)   │   │  ivr · agents ·      │   │ media (WebRTC engine)         │
 │ sip ingress (drachtio)     │   │  recording policy    │   │ realtime notifier (Socket.IO) │
 └────────────────────────────┘   │ domain: Call, Queue, │   │ push (FCM / APNs / OneSignal) │
                                  │  Agent, Leg, events  │   │ outbox (event webhooks)       │
                                  │ ports (interfaces)   │   │ persistence (MySQL / knex)    │
                                  └──────────────────────┘   │ storage (S3) · cluster (Redis)│
                                                             └──────────────────────────────┘
```

**Ports the core defines:**

| Port | Purpose | Adapters |
|---|---|---|
| `CustomerChannel` (`core/channels/CustomerChannels.js`) | outbound to the provider: accept, reject, terminate, initiate; SDP rewrites; address rules; provisioning validation; ingress routes | `WhatsAppChannel` (`SipChannel` next) |
| `ChannelIngress` (`core/channels/ChannelIngress.js`) | inbound from the provider, already translated: `inboundCall`, `outboundAnswered`, `statusChanged`, `callEnded` | called by each channel's translator |
| `MediaEngine` | create/close legs, SDP/ICE, bridge, play audio, capture DTMF, record | WebRTC engine (wrtc + worker threads) |
| `AgentNotifier` | deliver realtime events to agents / call rooms / supervisors | Socket.IO gateway |
| `PushNotifier` | wake offline agent devices | FCM, APNs VoIP, OneSignal |
| `EventPublisher` | emit consumer-facing events | `webhook_deliveries` outbox |
| `CustomerLookup` | optional pre-ring enrichment | HTTP lookup hook |
| Repositories | persistence | MySQL via knex |
| `CallOwnership` / locks | one worker owns a call's media | Redis |
| `ObjectStorage` | recordings, audio assets | S3 |

Rules:
- **No consumer names in code.** Anything that differs per consumer is data
  (consumer/tenant/channel config), never an `if`.
- **No provider types in the core.** The core sees a `Call` with a `channel`
  and a `provider_call_id`; Meta payloads and SIP messages stop at the adapter.
- **One implementation per operation.** One `CallTerminator` for every way a
  call ends, one `AgentPicker` for every way an agent is chosen, one
  `releaseAgentAfterCall`.
- **Transport is a thin shell.** HTTP and socket handlers validate shape, pass
  identity from auth, call an application service, and map results. No
  queries, timers or business rules.
- The contract (A)–(E) is versioned and documented in `docs/`; internals are
  not part of it.

### Channels are adapters

WhatsApp is one channel, not the shape of the system. A channel adapter under
`src/channels/<name>/` does exactly three things:

1. **Ingress:** resolves the provider's line to a `channels` row (WhatsApp:
   `phone_number_id` → `provider_account_id`), translates its payloads and
   reports them to `ChannelIngress` in Callio's terms. Every decision (dedup,
   lookup, IVR or queue, who to offer, termination reason, releasing agents)
   is made there, once, for every channel.
2. **Outbound actions:** implements the `CustomerChannel` port the core calls
   through `customerChannels` (by `calls.channel`): accept, reject, terminate,
   initiate.
3. **Provider quirks:** its customer-leg SDP rewrites (`sdp` profile), how
   customer addresses are normalised, which channel fields are required.

It is registered in `src/channels/index.js`. The core, media engine and
Management API import no adapter. Adding SIP is a new folder plus one
registration line; nothing in `core/` or `media/` changes.

### Process model

Unchanged in shape: N PM2 workers, each running every surface, with Redis for
cross-worker state. Media must live on one worker per call, so the gateway
routes a call's socket traffic to the owning worker (nginx hashing on
`X-Call-ID`, Redis pub/sub for events that land elsewhere). The outbox
dispatcher and cleanup reapers run as leader-elected tasks, so N workers
don't each do the same job.

---

## 7. Code layout

```
src/
  core/                         no imports from http/, realtime/, channels/
    calls/                      CallService, flows (inbound, outbound, accept,
                                reconnect, transfer, monitor), CallTerminator
    routing/                    QueueRouter, AgentPicker, AutoOfflinePolicy
    ivr/                        IvrEngine, IvrSession
    agents/                     AvailabilityService, PresenceService
    recording/                  RecordingPolicy, retention
    tenancy/                    consumer/tenant resolution, provisioning services
    events/                     domain events + consumer event catalog
    channels/                   CustomerChannel port + registry, ChannelIngress
    constants/
  http/                         inbound adapter
    v1/                         Management API routes + schemas
    auth/                       API key, rate limits
  realtime/                     inbound + outbound adapter for agents
    gateway.js, auth.js (consumer JWT), rooms.js, handlers/, notifier.js
  channels/                     CustomerChannel adapters, registered in index.js
    whatsapp/                   WhatsAppChannel (port), WhatsAppCallApi (Graph API),
                                WhatsAppWebhookTranslator, webhookRoutes (Meta
                                signature + forward), whatsappSdp
    sip/                        SipChannel (drachtio-srf) — next
  media/                        MediaEngine adapter
    webrtc/                     peers, SDP, ICE
    bridge/  dtmf/  recording/  playback/
  push/                         PushNotifier: fcm/, apns/, onesignal/
  outbox/                       webhook dispatcher worker, signing
  persistence/                  mysql2 repositories (tenant-scoped; Knex runs migrations only)
  infra/                        redis/ (client, pubsub, keys.js), db/, storage/,
                                crypto/ (secret encryption), logging/, monitoring/
  server/                       bootstrap (composition root), shutdown
docs/
  api/openapi.yaml              surface (A)
  events.md                     surface (B)
  agent-protocol.md             surface (C)
sdk/agent-js/                   @callio/agent-sdk (may move to its own repo)
```

`server/bootstrap.js` is the composition root: the only place that picks
concrete adapters and hands them to the core.

---

## 8. How a product integrates — checklist

Using midlr as the worked example; any product does the same.

1. **Get credentials.** Callio operator creates the consumer → API key,
   signing key (`kid`), webhook secret. Product sets its webhook URL and push
   credentials.
2. **Sync its model.** On create/update in the product:
   business → `PUT /v1/tenants/{id}`; staff with call access → agents;
   call-routing settings / groups → queues + members; WhatsApp numbers → channels
   (with the Meta phone_number_id and token); IVR menus → ivr flows + audio.
3. **Connect agents.** Product backend signs agent JWTs; product frontend and
   mobile app embed the agent SDK. Device push tokens → `PUT …/push-tokens`.
4. **Wire the channel.** Point the Meta webhook at Callio, or forward call
   webhooks to `/v1/webhooks/whatsapp/forward`. SIP DIDs are assigned by the
   Callio operator.
5. **Consume events.** Verify signatures, de-duplicate on `event_id`, and
   write the product's own records (midlr: the chat-timeline call bubble,
   CRM "last contact", billing) from `call.*` events.
6. **Outbound.** Product checks consent, calls `POST …/calls`, hands `call_id`
   to the agent client.
7. **Optional.** Lookup hook for caller names from the product's CRM.

---

## 9. Build order

Each phase leaves the service working end to end.

| Phase | Delivers | Status |
|---|---|---|
| 0 | Delete dead code; fix multi-worker startup wipes, IVR replay, shutdown bugs | done |
| 1 | New schema + seed; `src/` restructured into the layout above; constants renamed | done |
| 2 | Persistence on the new schema, tenant-scoped; midlr repositories deleted | done |
| 3 | One end-of-call path (`CallTerminator`); queue timers (ring timeout, max wait, overflow) | done |
| 4 | Routing on queues (`QueueRouter`) | done |
| 5 | Channels as adapters: `CustomerChannel` port, `ChannelIngress`; WhatsApp ingress with signature verification, payloads scoped per channel | done |
| 6 | Agent gateway: consumer JWT, room authorization, protocol v1 doc, `call:start` outbound | done |
| 7 | Management API v1 + outbox dispatcher + event catalog | done; per-consumer push credentials pending |
| 8 | `SipChannel` (SIP Milestone B) on the `CustomerChannel` port and `ChannelIngress` | next |
| 9 | Agent SDK; midlr integration against the public contract | planned |

End-to-end coverage for everything marked done: `test/e2e` (`npm run test:e2e`).
