# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Callio is a standalone Node.js WebRTC call-center service. It was extracted from a larger Laravel+Node monorepo (`WhatsappCommunicationSystem`) — specifically from that repo's `node/src/services/call/` domain and everything it depends on. Chat, orders, templates, activities, and tickets stayed behind; this repo only ever imported the `call` and `device` Socket.IO namespaces.

**This service does not have its own database.** It connects to the same MySQL instance the original Laravel backend uses, and both apps read/write the same tables under an explicit ownership contract. **Read `TABLE_OWNERSHIP.md` before writing any code that touches `calls`, `call_connections`, `call_lifecycle_events`, `call_transfer_logs`, `call_recordings`, or `ivr_menus`** — each of those tables has exactly one designated writer (usually this service), and the doc explains why (a real production bug came from two independently-implemented writers on the same table). Communication with the Laravel side is one-directional: Laravel calls into this service over HTTP, authenticated with a shared `X-Internal-Api-Key` header (`internalAuthMiddleware.js` on inbound routes). This service makes no calls back into Laravel — see `TABLE_OWNERSHIP.md`'s `ivr_menus` row for what used to exist there and why it was removed.

**`SIP_INTEGRATION.md`** documents the SIP trunk work (Phase 2 of the roadmap below, now underway): the drachtio-server + rtpengine gateway architecture, why that stack was chosen over Janus/FreeSWITCH/Asterisk, and the full Milestone B (application-code integration) scope. Read it before touching anything under `deploy/sip-gateway/` or `src/services/call/signaling/sip/`.

`ARCHITECTURE.md` is the detailed developer guide carried over from the original codebase (folder-by-folder breakdown, call flow diagrams, architectural patterns, naming conventions). It predates the extraction, so it still has some prose mentioning the chat/orders/templates/activities/ticket namespaces that no longer exist in this repo — treat those specific mentions as stale, everything else in it is accurate and worth reading for depth beyond this file.

## Where this came from — reference these if you need context this repo doesn't have

This repo is a snapshot copy, not a fork with shared history. Two sibling local repos hold the source it was taken from and the wider system it's part of:

- `C:\Users\hzrei\Documents\Projects\PCG-MS\WhatsappCommunicationSystem` — the original monorepo: the Laravel backend (`backend/`, owns `businesses`/`users`/`client_numbers`/etc. and the `CallController.php` admin/config API), the original React frontend, and the original (not-yet-decoupled) version of this Node call server (`node/`). Check here for: the Laravel-side model/migration/route definitions for tables this service reads, how the chat/orders/templates/tickets domains work (they stayed there, not here), and the full call-center feature surface (recording retention, billing rates, agent settings UI) that this repo has no visibility into.
- `C:\Users\hzrei\Documents\Projects\PCG-MS\WhatsappCommunicationSystem-callservice` — a sibling copy of the monorepo above with Phase 1 decoupling already applied to its `node/` (the internal API auth boundary, the configurable storage path, the `ivr_menus` single-writer fix, the `calls` dual-writer fix) — **this repo (`callio`) is a direct copy of that repo's `node/` folder**, not of the original untouched one. If something here looks inconsistent with what you'd expect, check that repo's `node/` first — it's the actual source, and its changes were uncommitted working-tree edits as of this extraction, not yet merged into the original monorepo.

Files that exist in both this repo and the monorepo (`BusinessRepository.js`, `AgentRepository.js`, `ClientRepository.js`, `UserGroupRepository.js`, `NotificationRepository.js`, `FcmService.js`, `notificationLogger.js`) were duplicated on purpose so this service has no runtime dependency on the monorepo — they are two independent copies now and **will drift** as each side changes. That's an accepted trade-off, not a bug to fix.

## Roadmap — why this repo exists

This extraction is Phase 1 of a larger plan, not an end in itself:

1. **Phase 1 (done)**: decouple the call domain inside the monorepo (single-writer table contract, authenticated internal API, configurable storage path — see `WhatsappCommunicationSystem-callservice`), then extract it here as this standalone repo.
2. **Phase 2 (underway)**: add a SIP trunk channel alongside WhatsApp Calling for real PSTN phone numbers. First step was a hexagonal `signaling/` port/adapter boundary (`src/services/call/signaling/` — `SignalingAdapter` port, `webrtc/` holding the existing WebRTC implementation relocated from the old `connection/`+`api/` folders, `sip/` for the SIP adapter). Gateway choice for the SIP side: **drachtio-server + rtpengine** (not jambonz/Janus/FreeSWITCH/Asterisk — see `SIP_INTEGRATION.md` for the full comparison and why). Milestone A (the gateway itself, deployed under `deploy/sip-gateway/`) is **validated end-to-end with a real inbound call from the trunk provider** (Digitalk) — signaling and media negotiation both confirmed working. Milestone B (wiring SIP calls into `AudioBridge`/IVR/recording/assignment as a channel-agnostic customer leg, same shape WhatsApp calls already use) has not started — see `SIP_INTEGRATION.md`'s scope section.
3. **Phase 3 (planned)**: unify the two call pipelines that currently exist in the monorepo (direct 1:1 calls vs. call-center queue/transfer/monitor) into one engine, ideally before or alongside finishing the SIP channel, so a third parallel pipeline doesn't get built by accident.
4. **Phase 4 (planned, after the backend work above is solid)**: build a custom frontend for Callio — a new UI, not a copy of the monorepo's React app. No framework/stack decisions have been made yet.

## Current status

- Committed and under active development (`main` branch) — no longer a fresh extraction snapshot. Deployed to a real development server (`callio.pcg-ms.com`) with nginx reverse-proxying to a PM2 worker pool.
- The app has been booted and smoke-tested against real DB/Redis credentials on that server.
- The SIP gateway (`deploy/sip-gateway/`) is deployed on the same server and has handled a real inbound call end-to-end. No SIP-related application code exists in `src/` yet (Milestone B, not started).

## Commands

There is no automated test suite in this project (none existed in the source repo either) — verify changes manually.

```bash
cp .env.example .env    # fill in real values first — see README.md
npm install
npm run dev              # nodemon index.js, single process, auto-restart
npm start                 # node index.js, single process
pm2 start ecosystem.config.cjs   # multi-worker fleet (production shape)

npm run logs              # tail today's app logs across all workers
npm run logs:follow
npm run logs:errors

node --check <file>       # syntax-check a single file (no build step exists)
```

No lint/format tooling is configured — there's no ESLint/Prettier config in this repo.

## Architecture

### Process model

PM2 runs multiple **fork-mode** worker processes (`ecosystem.config.cjs`, count via `WORKER_COUNT`), each bound to its own port (`BASE_PORT + i`). Workers share **no in-memory state** — everything that must be visible across workers goes through Redis. An external nginx layer (not in this repo) load-balances across worker ports, using an `X-Call-ID` header for consistent-hash sticky routing so all events for one call land on the worker holding that call's WebRTC objects.

`config/envConfig.js` is the single source of truth for environment variables — never read `process.env` directly anywhere else. The one exception is `ecosystem.config.cjs` itself, which is CJS and runs before the ESM app process exists.

### Entry point and lifecycle

`index.js` is a thin orchestrator: installs logging (`AppLogService`), calls `initRedis()` then `initOptionalServices()` (`src/server/bootstrap.js`), mounts `apiRoutes`, creates the Socket.IO server, adds an admission-control middleware that rejects new connections once a worker hits `MAX_CALLS_PER_WORKER`, starts `callCleanupService` and `redisCleanupService`, and registers `SIGINT`/`SIGTERM` → `src/server/shutdown.js`. `shutdown.js` runs a strictly-ordered sequence (Socket.IO close → recording flush → worker-thread termination → peer connection close + DB finalization → S3 upload drain → Redis teardown) with a 60s hard-kill fallback — don't reorder its steps without understanding why each one is where it is (see the file's own numbered comments).

### `src/services/call/` — the core domain

Organized by concern, no files at the folder root:

- `signaling/` — the hexagonal port/adapter boundary for call signaling. `SignalingAdapter.js` is the port; `webrtc/` holds the WebRTC adapter (`Peer`, `PeerRegistry`, SDP/ICE coordinators, `WhatsAppCallApi.js` — this subfolder is where the old top-level `connection/` and `api/` folders were relocated to); `sip/` holds the SIP adapter (currently just a stub — see `SIP_INTEGRATION.md`, Milestone B not started)
- `assignment/` — agent assignment and queue management (`AgentAssignmentCoordinator` is the single entry point for anything that changes agent/queue state)
- `audio/` — audio bridging between peers, placeholder tracks, recording pipeline (`bridge/`, `dtmf/`, `recording/` + `recording/encoding/` subfolders)
- `cleanup/` — stuck-call detection (periodic scan + on-demand via the internal API) and call-center disable handling
- `constants/` — frozen enums (`CallConstants.js`) — never use raw string literals for call status/direction/etc.
- `events/` — `CallEventHandler` routes Redis-sourced events to one of 8 specialized handlers (initiation, agent, connection, whatsapp, termination, rejection, transfer, monitor)
- `ivr/` — IVR state machine, audio playback, transfer-to-queue handling
- `lifecycle/` — writes `call_lifecycle_events` for audit/analytics (fire-and-forget — must never block the call flow)
- `query/` — read-side queries (e.g. ongoing calls)
- `webhook/` — `CallWebhookProcessor`, all inbound WhatsApp webhook business logic

Three architectural patterns recur throughout this tree and the services around it:
- **Singletons**: a class is instantiated once at the bottom of its own file and exported as a lowercase named instance (`export const callManager = new CallManager()`). Import the singleton, never the class.
- **Coordinators**: own a full multi-step domain operation end-to-end so callers don't need to know the internals (e.g. `SDPCoordinator`, `ICECandidateCoordinator`, `AudioCoordinator`).
- **Handlers**: focused, non-singleton classes that process one category of event, instantiated and routed by a coordinator (e.g. `events/handlers/*` under `CallEventHandler`).

### Cross-process communication

- **Redis pub/sub** (`RedisPubSubService`) routes a call's events to the one worker that owns its peer connections. `CallOwnershipService` enforces that single-owner invariant via a distributed lock.
- **Socket.IO's Redis adapter** automatically propagates room broadcasts (`RoomManager`) to sockets on any worker — no manual routing needed there.
- **`EventBus`** (`services/core/EventBus.js`) is strictly intra-worker pub/sub. Never expect it to see events published from another worker.

### Websocket layer

`src/websocket/namespaces/index.js` only wires up `call` and `device` (everything else was left in the source monorepo). Inside the `call` namespace, `socketHandlers.js` is intentionally the thick file — it handles every client→server event directly (`call:initiate`, `call:accept`, `call:transfer`, `call:monitor:*`, etc.). `busHandlers.js` and its `handlers/{state,delivery,media,network,ivr}.js` are the other direction: `EventBus` → Socket.IO broadcast relays, registered once per worker, not per-connection.

Two-layer validation is enforced by convention: `socketHandlers.js` only checks that required fields are present (no DB calls); business rules (call exists, is in the right state, agent is available) belong in the event handlers/services layer. Don't mix the two layers.

### Error handling and logging conventions

All call-domain errors go through `emitCallError()` (`events/CallErrorEmitter.js`) — never emit the `call:error` socket event directly. Pass `callId: null` for management/query-level errors that have no specific call context.

Logs use `console.log`/`warn`/`error` with a `[Module:sub-concern]` prefix (e.g. `[Webhook:incoming]`, `[Socket]`, `[EventBus]`) — no emojis, no custom logger. Always pass the actual `error` object (not just `.message`) as the second argument so stack traces survive.

### Internal API to the Laravel backend

`src/routes/apiRoutes.js` exposes the routes Laravel calls into this service (webhook forwarding, call-center toggle, on-demand stale-call release) behind `internalAuthMiddleware` — every request must carry `X-Internal-Api-Key` matching the shared secret in both apps' env files. This service makes no calls back into Laravel — the one that used to exist (`LaravelInternalApiClient.incrementIvrMenuMetrics`, an IVR-menu metrics rollup) was removed; see `TABLE_OWNERSHIP.md`'s `ivr_menus` row.
