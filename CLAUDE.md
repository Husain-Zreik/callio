# CLAUDE.md

Callio is a standalone contact-center call engine that **any product** integrates with. Customers call over a channel (WhatsApp Calling, or SIP/PSTN through a carrier trunk); agents answer in a browser or app over WebRTC; Callio owns routing (queues), IVR, availability, transfers, supervisor monitoring, recording and the call record. Media runs on a media plane Callio drives — rtpengine at the edge, a FreeSWITCH room per call — and never through Callio's Node processes. It has **its own MySQL database** and knows nothing about any consuming product.

## Docs — read the one for the area you change

| Doc | Covers |
|---|---|
| `docs/architecture.md` | How it works: surfaces, boundaries, process model, call flows, routing, media, IVR, startup/shutdown |
| `docs/management-api.md` · `docs/events.md` · `docs/agent-protocol.md` | The public contract (REST API, consumer webhooks, agent socket + WebRTC). **If you change behaviour a consumer can observe, update the matching doc in the same change.** |
| `docs/data-model.md` | Tables and columns. Every schema change is a new Knex migration (`npm run migrate:make -- <name>`); never edit a migration that has run anywhere real |
| `docs/media-architecture.md` | The media plane's design and what's left: rtpengine + FreeSWITCH rooms, participants, ownership failover, the order of work |
| `docs/sip.md` | SIP gateway (`deploy/sip-gateway/`) and SIP channel (`src/channels/sip/`): carrier requirements, config, deploy, tests, open items |
| `docs/logging.md` | Logging rules in full, reading logs, metrics |
| `test/e2e/README.md` · `deploy/*/README.md` · `sdk/agent-js/README.md` | The test runner, deploy pieces and the agent SDK, next to their files |

## Design rules

- **No consumer names or consumer concepts in code.** Per-consumer differences are data (consumer/tenant/channel/queue rows), never an `if`. A consumer's own ids live only in `external_ref` / `consumer_metadata`, which Callio stores and never interprets.
- **No provider types in the core.** Meta payload shapes stay in `src/channels/whatsapp/`; the core sees a call with a `channel` and a `provider_call_id`, calls providers only through `customerChannels`, and receives provider events only through `ChannelIngress`. Media takes provider SDP rules as the adapter's `sdpProfile`.
- **No media in the core.** The core touches audio only through the room-shaped media port `callMedia` (`core/media/CallMedia.js`, via `MediaLegs`); the implementation is `src/media/rooms/`.
- **Identity comes from auth, never from payloads.** API routes resolve the consumer from the API key; sockets resolve tenant + agent from the verified JWT. Every call action on a socket goes through `core/calls/CallAccess.js` before a socket joins a call room.
- **Tenant scoping in every query** that reads consumer-owned data.

## Commands

```bash
cp .env.example .env              # CALLIO_MASTER_KEY, DB_*, REDIS_* at minimum
npm install
npm run migrate:latest            # also: migrate:status, migrate:rollback, migrate:make
npm run dev                       # nodemon index.js, single process
pm2 start ecosystem.config.cjs    # multi-worker fleet (production shape)

npm run consumer:create -- --name "Acme" --slug acme [--webhook-url URL] [--lookup-url URL]
npm run seed:dev -- --phone-number-id <id> --whatsapp-token <token> [--sip-did +961…]   # dev consumer/tenant/agents/queue/channels
npm run sip:trunk -- --name <name> --host <carrier> [--cidr <source/32>]   # create/update a SIP trunk (operator)
npm run ivr:test -- --consumer <slug> --tenant <ref> --channel <ref> [--off]   # test IVR menu on a real line (DTMF)
npm run agent:token -- --consumer <slug> --tenant <ref> --agent <ref>   # sign a test agent token
npm run push:credentials -- --consumer <slug> --show   # also --fcm <sa.json> | --apns <key.p8> … | --remove fcm
npm run push:credentials -- --consumer <slug> --show | --fcm <sa.json> | --apns <key.p8> … | --remove fcm   # a consumer's push credentials
npm run demo:agent [-- <port>]    # SDK demo page: http://localhost:5173/examples/agent.html

docker compose -f test/e2e/docker-compose.yml up -d --wait                    # MySQL + Redis for tests
docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d --build   # media plane: drachtio, rtpengine, FreeSWITCH (every suite)
npm run test:e2e                  # every suite, real WebRTC media
npm run test:e2e -- routing       # one suite

npm run logs -- --call 42 --level warn --component channels.sip   # also logs:follow / logs:errors / logs:stats
npm run log-level -- channels.sip=debug --for 30m                 # live, every worker; --reset to undo
node --check <file>               # syntax-check (no build step)
```

No unit tests, no lint/format config. **Verify behaviour changes with `npm run test:e2e`** — it catches races and wiring mistakes `node --check` can't. When you add a feature or fix a bug, add its scenario to a suite.

## Layout (`src/`)

- `core/` — the call engine; no HTTP/socket/push/provider/media imports. It reaches single sockets through the `agentConnections` port (`agents/AgentConnections.js`), push through `callNotifications` (`calls/CallNotifications.js`) and audio through `callMedia` (`media/CallMedia.js`), all registered at startup; everything else it tells sockets is an `EventBus` event. `EventBus.js` is strictly in-process.
  - `media/` — `CallMedia` (the room-shaped media port, documented in the file), `MediaLegs` (port calls that also keep each leg's `call_connections` record), `AgentLegSockets`.
  - `calls/` — `CallAdoption` (takes over calls whose worker stopped: lease, room rebuilt from its snapshot, inbox), `CallTerminator` (the one way a call ends: guarded commit → call:terminated → agent release → provider → media → log), `CallParticipants` (who is in a call: `call_participants`), `CallView` (the one call shape), `IncomingCallPayload`, `CallAccess`, `CallQueryService`, `CallCleanupService` (stuck calls, expired outbound intents, stale recordings), `CallLifecycleLogger`, `CustomerLookup`, `RetentionService` (scheduled deletion), `CallErasure` (deletion on request: a call, a customer), `endedDuringWork`.
  - `routing/` — `QueueRouter` (the only place that interprets `queues.strategy`), `CallAgentAssignmentService` (per-queue Redis lock, round-robin order), `AgentAssignmentCoordinator` (availability changes, releasing agents, draining queues, transfers into queues, passing an offer on, overflow), `QueueTimeoutService` (ring timeout / max wait / overflow from `calls.offered_at` / `queued_at`, and the transfer timeout), `OfferHistory`, `AgentMissedCallTracker`, `AutoOfflinePolicy`.
  - `events/` — `CallEventHandler` routes Redis-delivered call events to `handlers/` (initiation/outbound, agent, connection, customer, termination, rejection, transfer, monitor); `EventTypes`; `ConsumerEventPublisher` → outbox; `CallErrorCodes` / `CallErrorEmitter`.
  - `ivr/` — `IvrEngine` (flow graph), `IvrCoordinator`, `IvrTransferHandler`, `IvrTerminationHandler`.
  - `channels/` — `CustomerChannels` (the port every adapter implements; the registry by `calls.channel`) and `ChannelIngress` (where adapters report provider events; all call decisions, once for every channel).
  - `agents/PresenceService`, `tenancy/ConsumerProvisioning`, `constants/CallConstants.js` (frozen enums — never raw string literals for statuses, leg types `AGENT`/`CUSTOMER`/`MONITOR`, channels, strategies).
- `channels/` — adapters, registered in `channels/index.js`; a new channel is a folder plus one line. `whatsapp/`: `WhatsAppChannel`, `WhatsAppCallApi`, `WhatsAppWebhookTranslator`, `webhookRoutes`, `whatsappSdp`. `sip/`: `SipChannel`, `SipIngress`, `SipDialogs` (cross-worker leg ownership), `sipSdp`, `sipAddress`, `sipLegs`.
- `media/rooms/` — the media port's implementation: `RoomMedia` (rooms, legs, who-hears-whom rules, hold, IVR player, DTMF, orphan sweep), `FreeSwitch` (drachtio-fsmrf connection, boot id), `RtpLegs` (one rtpengine leg per participant), `CustomerLegMonitor` (drop + quality from rtpengine), `RoomRecorder` (stereo recording, uploaded by the media server), `MediaAudio` (signed `/media/audio` URLs the media server fetches), `sdpLines`.
- `http/` — Fastify: `routes/index.js` (every surface), `v1/` Management API (`validate.js`), `auth/apiKeyAuth.js`, `errors.js`, `accessLog.js`, `controllers/` (health, metrics, media audio).
- `realtime/` — agent gateway: `server.js` (Socket.IO, websocket only), `IceServers` (what clients get in `session:ready`), `middleware/authMiddleware` (consumer JWT), `handlers/connectionHandler`, `namespaces/call/socketHandlers.js` (client → server), `busHandlers.js` + `handlers/*` (EventBus → socket relays, thin), `managers/RoomManager`.
- `push/` — `CallPushNotifier` (who gets which push), `PushCredentials` (the consumer's credentials, else the platform's), `FcmService`, `ApnsVoipService`, `OneSignalService`.
- `outbox/` — `OutboxDispatcher` (leased, signed, retried delivery of `webhook_deliveries`), `signing.js`.
- `persistence/` — mysql2 repositories, one per aggregate (raw SQL; Knex only for migrations). DB pool: `config/dbConnection.js`.
- `infra/` — `redis/`, `cluster/` (`CallInbox`: per-call lease + Redis Stream inbox + `request()` to the owner; `Deadlines`: per-call timers in Redis; `CallState`: a call's room/IVR state for a worker taking it over; `WorkerBoot`; provider-event dedup lock, orphan reaper), `sip/Drachtio` (the drachtio connection, shared by the SIP channel and media), `media/RtpEngineClient` (ng protocol), `storage/`, `crypto/secretBox`, `logging/`, `monitoring/`.
- `server/` — `bootstrap.js` (`initOptionalServices`, `startCoreServices`), `shutdown.js` (strictly ordered; read its numbered comments before reordering).

## Process model

PM2 fork-mode workers (`WORKER_COUNT`, each on `BASE_PORT + i`) share no memory; everything cross-worker goes through Redis. A call's media legs are controlled from one worker (`CallOwnershipService` lock; FreeSWITCH reports each endpoint's events back to the worker that made it) and its inputs reach that worker through a per-call Redis Stream behind a lease (`infra/cluster/CallInbox.js`: `post()` from anywhere, the lease holder reads), so any worker can take any request. Socket.IO's Redis adapter propagates room emits. Background loops run on every worker; the ones that must run once hold a Redis lock/lease.

## Patterns

- **Singletons**: instantiated at the bottom of the file, exported lowercase (`export const queueRouter = new QueueRouter()`). Import the instance.
- **Coordinators** own a multi-step operation end to end; **handlers** process one category of event.
- **Race-safe SQL**: state transitions are guarded `UPDATE ... WHERE <expected state>`; callers act on `affectedRows` (`finalizeFromWebhook`, `claimAgentAndAssignCall`, `markOnCall`, `withdrawOffer`). Keep that shape; the comments document real races.
- **Time is UTC** end to end (pool and Knex `timezone: 'Z'`, session `time_zone` `+00:00`).
- Socket handlers check payload shape and authorization only; business rules belong in the core. Socket call errors go through `emitCallError()` with a `CallErrorCodes` code; HTTP errors through `http/errors.js`.
- **Config**: `config/envConfig.js` is the only reader of `process.env` (exceptions: `ecosystem.config.cjs`, and `preload.cjs` for `WORKER_ID`). DB secrets are encrypted with `CALLIO_MASTER_KEY` via `infra/crypto/secretBox.js`.

## Logging (full rules: `docs/logging.md`)

- Never `console.*` in `src/`: `const log = logger('<layer>.<area>.<File>')` from `infra/logging/logger.js`.
- Fields first, short message: `log.warn({ callId, err }, 'rtpengine offer failed')`. Ids are fields (names from `policy.FIELDS`), errors as `err`; no `[Prefix]`, no emojis — the e2e runner fails on them.
- `info` = lifecycle steps (a call is a handful of lines), `debug` = internals, `trace` = per packet; anything that can repeat fast goes through `throttle()`; guard record-building in hot paths with `log.isLevelEnabled()`.

## Status

- Implemented and covered by `test/e2e`: WhatsApp and SIP, inbound and outbound; queues (`RING_ALL`/`ROUND_ROBIN`/`PRIORITY`) with ring timeout, max wait, overflow and transfer timeout; IVR, transfer, monitoring, recording, push, the Management API and consumer events.
- Dev environment `callio.pcg-ms.com` (nginx → PM2) runs on Callio's own database. Real inbound calls verified there: WhatsApp, and SIP from the carrier with two-way audio. Open: outbound SIP, carrier DTMF, a real DID (`docs/sip.md`).
- Media plane (rtpengine + FreeSWITCH rooms) replaced the in-Node wrtc media; covered by the whole e2e suite and running on the dev server, where real inbound WhatsApp and SIP calls work (2026-10-02). Next: failover-able call ownership, media placement across nodes — see `docs/media-architecture.md`.
- `sdk/agent-js` — JS agent SDK (browser + Node, TypeScript types) for agents and supervisors; tested by `test/e2e/sdk.test.mjs`. React bindings and the Dart SDK are next.

## History

Extracted from midlr's `WhatsappCommunicationSystem` monorepo (Laravel + Node; local copies at `C:\Users\hzrei\Documents\Projects\PCG-MS\WhatsappCommunicationSystem` and `...-callservice`), then ported onto its own consumer-agnostic schema. midlr integrates through the public contract like any other consumer — don't reintroduce midlr-specific behaviour; integration adapters belong on midlr's side.
