# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Callio is a standalone contact-center call engine that **any product** integrates with. Customers call over a channel (WhatsApp Calling today, SIP/PSTN in progress); agents answer in a browser or app over WebRTC; Callio owns routing (queues), IVR, availability, transfers, supervisor monitoring, recording and the call record. It has **its own MySQL database** and knows nothing about any consuming product.

Read these before changing anything a consumer depends on:

- **`PLATFORM_ARCHITECTURE.md`** — the integration contract (Management API, event webhooks, agent gateway, channel ingress, push), the ports/adapters rules, the code layout and the build order.
- **`docs/management-api.md`, `docs/events.md`, `docs/agent-protocol.md`** — the three public surfaces, as implemented. If you change behaviour a consumer can observe, update the matching doc in the same change.
- **`migrations/README.md`** — the data model. Every schema change is a new Knex migration (`npm run migrate:make -- <name>`); never edit a migration that has run anywhere real.
- **`SIP_INTEGRATION.md`** — the SIP gateway (drachtio-server + rtpengine under `deploy/sip-gateway/`) and the SIP channel plan.

`ARCHITECTURE.md` is the older internals guide (media pipeline, call-flow narrative). Its media/IVR/recording detail is still accurate; anything in it about businesses, midlr tables, Laravel or chat is historical.

### Design rules (from PLATFORM_ARCHITECTURE.md §6)

- **No consumer names or consumer concepts in code.** Per-consumer differences are data (consumer/tenant/channel/queue rows), never an `if`. A consumer's own ids live only in `external_ref` / `consumer_metadata`, which Callio stores and never interprets.
- **No provider types in the core.** Meta payload shapes stay in `src/channels/whatsapp/`; the core sees a call with a `channel` and a `provider_call_id`, calls providers only through `customerChannels`, and receives provider events only through `ChannelIngress`. Media takes provider SDP rules as the adapter's `sdpProfile`.
- **Identity comes from auth, never from payloads.** API routes resolve the consumer from the API key; sockets resolve tenant + agent from the verified JWT. Every call action on a socket goes through `core/calls/CallAccess.js` before a socket joins a call room.
- **Tenant scoping in every query** that reads consumer-owned data.

## Commands

```bash
cp .env.example .env              # CALLIO_MASTER_KEY, DB_*, REDIS_* at minimum
npm install
npm run migrate:latest            # also: migrate:status, migrate:rollback, migrate:make
npm run dev                       # nodemon index.js, single process
npm start                         # node index.js
pm2 start ecosystem.config.cjs    # multi-worker fleet (production shape)

npm run consumer:create -- --name "Acme" --slug acme [--webhook-url URL] [--lookup-url URL]
npm run seed:dev -- --phone-number-id <id> --whatsapp-token <token>   # dev consumer/tenant/agents/queue/channel

docker compose -f test/e2e/docker-compose.yml up -d   # MySQL + Redis for tests
npm run test:e2e                  # end-to-end suites with real WebRTC media (test/e2e/README.md)
npm run test:e2e -- routing       # one suite

npm run logs / logs:follow / logs:errors
node --check <file>               # syntax-check a file (no build step)
```

There is no unit-test suite and no lint/format config. **Verify behaviour changes with `npm run test:e2e`** — it catches races and wiring mistakes that `node --check` can't, and it has found real bugs every time it was extended. When you add a feature, add its scenario to a suite.

## Architecture

### Layout (`src/`, see PLATFORM_ARCHITECTURE.md §7)

- `core/` — the call engine; no HTTP/socket/provider imports expected here (a few existing handlers still import `realtime/managers/RoomManager` — don't add more).
  - `calls/` — `CallView` (the one call shape for agents and consumers), `IncomingCallPayload`, `CallAccess`, `CallQueryService`, `CallCleanupService` (stuck calls, expired outbound intents, stale recordings), `CallLifecycleLogger`, `CustomerLookup`.
  - `routing/` — `QueueRouter` (the only place that interprets `queues.strategy`), `CallAgentAssignmentService` (per-queue Redis lock, round-robin order), `AgentAssignmentCoordinator` (single entry point for availability changes, releasing agents, draining queues, transfers into queues).
  - `events/` — `CallEventHandler` routes Redis-delivered call events to handlers (`handlers/`: initiation/outbound, agent accept/reconnect, connection, customer, termination, rejection, transfer, monitor); `ConsumerEventPublisher` bridges in-process events to the outbox.
  - `ivr/` — `IvrEngine` (flow graph), `IvrCoordinator`, `IvrTransferHandler`, `IvrTerminationHandler`.
  - `agents/PresenceService` — which agents have live sockets (per-worker bookkeeping).
  - `tenancy/ConsumerProvisioning` — operator-side consumer/key creation.
  - `constants/CallConstants.js` — frozen enums; never use raw string literals for statuses, leg types (`AGENT`/`CUSTOMER`/`MONITOR`), channels, strategies.
  - `channels/` — the customer-channel boundary: `CustomerChannels` (the port every adapter implements, and the registry the core calls by `calls.channel`) and `ChannelIngress` (where adapters report provider events: inbound offer, outbound answer, status, end — all call decisions live here, once for every channel).
- `channels/` — channel adapters, registered in `channels/index.js`. `whatsapp/`: `WhatsAppChannel` (the port), `WhatsAppCallApi` (Graph API with the channel's credentials), `WhatsAppWebhookTranslator` (Meta payloads → `ChannelIngress`), `webhookRoutes` (Meta signature + forward endpoint), `whatsappSdp` (customer-leg SDP rules). A new channel is a new folder plus one registration line; nothing in `core/` or `media/` changes.
- `media/` — WebRTC engine: `webrtc/` (peers, SDP, ICE), `bridge/` (AudioBridge, monitor mixing, customer network/silence watchdogs), `dtmf/` (in-band detection in a worker thread), `recording/` (stereo OGG/Opus in worker threads), `playback/` (IVR/queue audio).
- `http/` — Fastify routes: `v1/` Management API (API key via `auth/apiKeyAuth.js`, errors via `errors.js`), health; each registered channel adds its own ingress routes.
- `realtime/` — the agent gateway: Socket.IO server (websocket only), `middleware/authMiddleware` (consumer JWT), `namespaces/call/socketHandlers.js` (client → server), `namespaces/call/handlers/*` (EventBus → socket relays, thin), `managers/RoomManager`.
- `push/` — `CallPushNotifier` decides who gets which push; `FcmService`, `ApnsVoipService`, `OneSignalService` send.
- `outbox/` — `OutboxDispatcher` (leader-leased, signed, retried delivery of `webhook_deliveries`) and `signing.js`.
- `persistence/` — mysql2 repositories, one per aggregate (raw SQL; Knex is used only for migrations).
- `infra/` — redis (client, base wrapper, pub/sub), cluster (call ownership, orphan reaper), storage (S3, resolver, stream upload), crypto (`secretBox` for encrypted columns), logging, monitoring.
- `server/` — `bootstrap.js` (init sequences and `startCoreServices`) and `shutdown.js`.

### Process model

PM2 runs multiple fork-mode workers (`ecosystem.config.cjs`, `WORKER_COUNT`, each on `BASE_PORT + i`). Workers share no memory — everything cross-worker goes through Redis. A call's media lives on one worker (`CallOwnershipService` lock); call events are routed to it over Redis pub/sub (`RedisPubSubService.publishCallEvent`). Socket.IO's Redis adapter propagates room emits to every worker. `EventBus` (`core/EventBus.js`) is strictly in-process.

Background loops (`CallCleanupService`, `RedisCleanupService`, `OutboxDispatcher`) run on every worker; the ones that must not run N times hold a Redis lock/lease.

### Entry point and lifecycle

`index.js` is a thin orchestrator: logging (`AppLogService`) → `initRedis()` → `initOptionalServices()` → routes → Socket.IO + admission control → `startCoreServices()` → listen. `shutdown.js` runs a strictly ordered sequence (Socket.IO close → recording flush → worker threads → peers + DB finalization → S3 drain → background jobs → Redis → DB pool) with a 60s hard-kill fallback and a double-run guard — read its numbered comments before reordering.

### Patterns

- **Singletons**: a class instantiated at the bottom of its file and exported as a lowercase instance (`export const queueRouter = new QueueRouter()`). Import the instance.
- **Coordinators** own a multi-step operation end to end; **handlers** process one category of event and are instantiated by a coordinator.
- **Race-safe SQL**: state transitions are guarded `UPDATE ... WHERE <expected state>` and callers act on `affectedRows` (see `finalizeFromWebhook`, `claimAgentAndAssignCall`, `markOnCall`). Keep that shape; many comments document real races these guards close.

### Validation, errors, logging

- Socket handlers check payload shape and authorization only; business rules belong in the core.
- Call-domain socket errors go through `emitCallError()` (`core/events/CallErrorEmitter.js`) with a code from `CallErrorCodes`; HTTP errors through `http/errors.js`.
- Logs: `console.log/warn/error` with a `[Module]` or `[Module:sub-concern]` prefix; pass the error object (not `.message`) so stacks survive.

### Config

`config/envConfig.js` is the only place that reads `process.env` (exception: `ecosystem.config.cjs`, which runs before the ESM app). Secrets stored in the DB are encrypted with `CALLIO_MASTER_KEY` via `infra/crypto/secretBox.js`.

## Status

- WhatsApp inbound and outbound, queues (`RING_ALL`/`ROUND_ROBIN`/`PRIORITY`), IVR, transfer, monitoring, recording, push, the Management API and consumer events are implemented and covered by `test/e2e`.
- Deployed dev environment: `callio.pcg-ms.com` (nginx → PM2). The SIP gateway under `deploy/sip-gateway/` has handled a real inbound call from the carrier; the SIP **channel** in `src/channels/sip/` (Milestone B in SIP_INTEGRATION.md) is next.
- Not yet: per-consumer push credentials (push uses platform credentials from env), queue `ring_timeout_seconds` / `max_wait_seconds` / overflow enforcement, an agent client SDK.

## History

Callio was extracted from the `WhatsappCommunicationSystem` monorepo (midlr's Laravel + Node app); local copies live at `C:\Users\hzrei\Documents\Projects\PCG-MS\WhatsappCommunicationSystem` and `...-callservice`. It then ran against midlr's database until it was ported onto its own consumer-agnostic schema. midlr keeps its own separate code and will integrate with Callio through the public contract like any other consumer — don't reintroduce midlr-specific behaviour here; integration adapters belong on midlr's side.
