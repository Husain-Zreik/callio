# Node (WebRTC) Server — Architecture & Developer Guide

## Overview

Node.js WebSocket server that manages real-time voice calls between WhatsApp clients and
business agents. It handles WebRTC signaling (SDP, ICE), call assignment, audio bridging,
recording, and presence tracking across multiple PM2 worker processes.

**Runtime**: Node.js (ESM `"type": "module"`)
**Process model**: PM2 cluster — multiple workers share no in-memory state; all shared
state lives in Redis.
**Transport**: Socket.IO over WebSocket; HTTP API for WhatsApp webhooks.

---

## Entry Points

| File | Role |
|------|------|
| `index.js` | Process entry point — thin orchestrator (~85 lines). Installs logging, calls `initRedis()` + `initOptionalServices()`, mounts routes, creates the WebSocket server, registers admission-control middleware, then listens. Registers `SIGINT`/`SIGTERM` → `shutdown()`. No business logic lives here. |
| `src/server/bootstrap.js` | Startup sequences. `initRedis()` initialises required Redis services (throws on failure, aborting startup). `initOptionalServices()` initialises degradable services — S3 storage, encoding worker, DTMF worker, stale-recording cleanup — with `Promise.allSettled` so a single failure does not abort startup. Add new optional services here. |
| `src/server/shutdown.js` | Graceful shutdown sequence invoked on `SIGINT`/`SIGTERM`. **Steps are strictly ordered** (see numbered comments in the file): Socket.IO close → recordings stop → worker bridges terminate → peer connections close + DB updates + IVR cleanup + lifecycle logs + Meta API termination → metrics stop → S3 drain → Redis teardown → storage close. Hard kill after 60 s. Do not reorder steps. |
| `config/envConfig.js` | Single source of truth for all environment variables. Loads `.env` via `dotenv`. The exported `config` object is the only place `process.env` is read. **Exception**: `ecosystem.config.cjs` calls `dotenv.config()` directly because it is PM2 infrastructure that runs before the ESM app process exists. |
| `config/dbConnection.js` | MySQL2 connection pool shared by all repositories. Pool size comes from `config.database.poolLimit` (`DB_POOL_LIMIT` in `.env`, default 10). Includes transparent stale-connection recovery — callers never handle `PROTOCOL_CONNECTION_LOST` themselves. |
| `ecosystem.config.cjs` | PM2 cluster configuration. Reads `NODE_ENV` and other tunables from `.env` via `dotenv` so the same file works across environments without code changes. |
| `.env.example` | Tracked in git (`.gitignore` has a `!.env.example` negation rule). Template for `.env` — all real values replaced with placeholders. Must stay in sync with `config/envConfig.js`. Never put real credentials here. |

---

## Folder Structure

```
node/
├── index.js                          Entry point (orchestrator only — no business logic)
├── .env.example                      Env template tracked in git — copy to .env, fill values
├── ecosystem.config.cjs              PM2 cluster config (CJS; reads NODE_ENV from .env)
├── config/
│   ├── envConfig.js                  Environment variable loader (single source of truth)
│   └── dbConnection.js               MySQL2 connection pool (pool size from DB_POOL_LIMIT)
└── src/
    ├── server/
    │   ├── bootstrap.js              Service init sequences (required + optional/degradable)
    │   └── shutdown.js               Graceful shutdown sequence (SIGINT / SIGTERM)
    ├── controllers/                  HTTP request handlers (thin layer)
    ├── routes/                       Express route definitions
    ├── middlewares/                  Socket.IO / HTTP middleware
    ├── repositories/                 Database access layer (Knex queries)
    ├── utils/                        Stateless helper functions
    ├── services/
    │   ├── core/                     Foundation classes used across all services
    │   ├── call/                     All voice-call business logic
    │   ├── redis/                    Redis service wrappers
    │   ├── notifications/            Push notification services (FCM, OneSignal)
    │   ├── storage/                  S3 storage client and stream uploader
    │   └── chat/                     Chat management stub
    └── websocket/
        ├── server.js                 Socket.IO server factory
        ├── managers/                 Socket room/broadcast management
        └── namespaces/               Per-domain socket & EventBus handler registration
            ├── call/
            │   ├── socketHandlers.js     Client → server events (validation + dispatch)
            │   ├── busHandlers.js        EventBus → Socket.IO relay (once per worker)
            │   └── handlers/             Call-specific event groups (state, delivery, media, network, ivr)
            ├── chat/
            │   ├── socketHandlers.js
            │   └── busHandlers.js
            ├── device/
            │   └── socketHandlers.js
            ├── orders/
            │   ├── socketHandlers.js     Stub — orders are receive-only on the client
            │   └── busHandlers.js
            ├── templates/
            │   ├── socketHandlers.js     Stub — templates are receive-only on the client
            │   └── busHandlers.js
            ├── activities/
            │   ├── socketHandlers.js     Stub — activity reminders are receive-only on the client
            │   └── busHandlers.js
            └── ticket/
                ├── socketHandlers.js
                └── busHandlers.js
```

---

## src/services/core/

Foundation layer. No business logic — only primitives that everything else builds on.

| File | Exports | Notes |
|------|---------|-------|
| `EventEmitter.js` | `class EventEmitter` | Custom in-process event emitter (`on`, `off`, `emit`, `once`). Extended by `CallManager`, `PeerEventManager`, `ChatManager`. |
| `EventBus.js` | singleton `EventBus` | Application-wide in-process pub/sub. A singleton instance of `EventEmitter`. Used for cross-service signalling **within** a single worker process. |

> **EventBus vs Redis pub/sub** — Use `EventBus` when the consumer lives in the same
> worker process (e.g. `busHandlers` reacting to a service event to broadcast via
> Socket.IO). Use `RedisPubSubService` when the consumer may be on a different worker
> (e.g. routing a call event to the worker that owns the peer connection).

---

## src/services/call/

The largest domain. Organised into focused sub-folders — no files float at the root level.

```
call/
├── assignment/                       Agent assignment and queue management
├── audio/                            Audio bridging, placeholder tracks, recording
├── cleanup/                          Stuck-call detection and periodic cleanup
├── constants/                        Frozen enum definitions
├── events/                           Call event routing and error handling
├── lifecycle/                        Call lifecycle DB logging
├── signaling/                        Hexagonal signaling port + WebRTC adapter (SIP stub) — see below
└── webhook/                          WhatsApp webhook processing
```

> **Correction (this doc previously described a `CallManager.js`/`callManager`
> singleton that no longer exists in the codebase.)** The single public entry
> point for the call domain today is **`events/CallEventHandler.js`**
> (singleton `callEventHandler`):
> - `callEventHandler.initiateCall(data)` — starts an outbound call (delegates to
>   `InitiationEventHandler`)
> - `callEventHandler.handleCallEvent(eventType, data)` — routes a Redis-sourced event to the
>   appropriate one of the 8 handlers in `events/handlers/`. Passed as a subscription callback
>   when subscribing to a call's Redis channel.
>
> Read-side queries (e.g. active calls for a business) now live separately in
> `query/CallQueryService.js`, used directly by the websocket layer rather than
> proxied through the event handler.

`CallManager` extends `EventEmitter` and is a **singleton** (`callManager`).

### assignment/

| File | Role |
|------|------|
| `AgentAssignmentCoordinator.js` | Orchestrates all assignment paths (DIRECT, QUEUED, TRANSFERRED). Owns `syncAgentAvailability`, `emitQueueUpdate`, `assignOldestUnassignedCall`, agent release logic. The single entry point for anything that changes agent or queue state. |
| `IncomingCallPayload.js` | Validated DTO for the `call:incoming` EventBus event. Ensures all three emission sites (webhook, coordinator, transfer handler) produce an identical field shape. |

### audio/

| File | Role |
|------|------|
| `AudioCoordinator.js` | Central entry point for all audio operations. Delegates to `AudioBridgeCoordinator`, `PlaceholderTrackFactory`, `RecordingCoordinator`, `DTMFCoordinator`. |
| `AudioBridge.js` | Per-call audio relay between FRONTEND / WHATSAPP / MONITOR peer connections. |
| `AudioBridgeCoordinator.js` | Owns the `Map<callId, AudioBridge>` registry and exposes bridge lifecycle ops. |
| `PlaceholderTrackFactory.js` | Creates beep/silence placeholder tracks injected before real agent audio is available. |
| `bridge/` | `MixingRelay` (PCM supervisor mixing), `SupervisorCapture` (supervisor mic sink), `CustomerSilenceWatchdog` (drop detection via PCM), `CustomerNetworkMonitor` (jitter/loss polling). Private helpers owned by `AudioBridge`. |
| `dtmf/` | `DTMFCoordinator` (teardown API), `DTMFCaptureService` (RTCAudioSink per call), `DTMFWorkerBridge` (Goertzel off-thread), `DTMFWorker`. IvrCoordinator drives start/pause/resume/stop directly on `dtmfCaptureService`; `DTMFCoordinator` is used only for final teardown by `AudioCoordinator`. |
| `recording/` | `RecordingCoordinator`, `RecordingManager`, `RecordingSession`, `AudioCaptureService`, `StereoMixBuffer` — stereo OGG/Opus recording pipeline. |
| `recording/encoding/` | `OpusEncoder` (native bindings, graceful Windows fallback), `OggMuxer` (EventEmitter-based page emitter; driven imperatively, never piped), `EncodingWorkerBridge`, `EncodingWorker`. |

### cleanup/

| File | Role |
|------|------|
| `CallCleanupService.js` | Background job: periodically scans Redis for stuck calls and cleans them up. Started once in `index.js` via `redisCleanupService.start()` after all services are ready. Uses distributed locking so only one PM2 worker runs the scan at a time. |

### signaling/ — Signaling Adapter Layer (Hexagonal Boundary)

Callio is meant to be a standalone calling infra, not a WebRTC-only one — the
target is to support SIP trunk/carrier signaling (Twilio, Telnyx, a generic
ITSP) alongside WebRTC. Today WebRTC is not just the transport at the edges:
`PeerRegistry` instantiates `wrtc.RTCPeerConnection` directly and SDP/ICE
handling throughout `signaling/webrtc/` assumes WebRTC's offer/answer +
trickle-ICE model. `signaling/` introduces the port/adapter boundary that
will let a future transport plug in alongside WebRTC without the call domain
depending on either directly. The WebRTC peer-connection implementation
(`Peer`, `PeerRegistry`, `SDPCoordinator`, the `ice/` subsystem, etc. — this
used to be a separate top-level `connection/` folder) now lives inside
`signaling/webrtc/`, so the adapter folder is self-contained, the same way
`signaling/sip/` will be once a real SIP implementation lands there.

**Status: scaffolding only.** `SignalingAdapter.js`/`SignalingAdapterRegistry.js`/
`sip/SipSignalingAdapter.js` are new and additive — no existing call site has
been migrated to use the port yet. All 8 handlers in `events/handlers/`, the
websocket layer, `AgentAssignmentCoordinator`, and `CallWebhookProcessor`
still call `sdpCoordinator` / `peerRegistry` / `iceCoordinator` directly
(now imported from `signaling/webrtc/` instead of the old `connection/`
path), unchanged in behavior. Wiring real call sites through the port is
future work.

| File | Role |
|------|------|
| `SignalingAdapter.js` | The port. Abstract base class (`extends EventEmitter`) — every method throws `NotImplementedError` unless overridden. Method shapes mirror the public APIs of `SDPCoordinator`, `PeerRegistry`, and `ICECandidateCoordinator` almost verbatim (each method's JSDoc names which existing method it mirrors), since those three singletons are already the single entry point every external caller goes through. Emits `connectionReady` / `trackReceived` / `connectionFailed`. |
| `SignalingAdapterRegistry.js` | Resolves which adapter owns a connection. Always returns the WebRTC adapter today (every `ConnectionType` value is WebRTC) — the seam a future transport dispatch would branch on once a non-WebRTC connection type exists. Not imported anywhere yet. |
| `webrtc/WebRTCSignalingAdapter.js` | Concrete adapter for today's (only) transport. Pure facade — every method is a one-line delegation to its siblings below (`sdpCoordinator` / `peerRegistry` / `iceCoordinator`); re-emits `PeerEventManager`'s `connectionReady` / `trackReceived` under the port's event names. No logic duplicated. Singleton `webRTCSignalingAdapter`. |
| `webrtc/Peer.js` | Per-connection WebRTC peer wrapper. Holds `pc`, SDP state, WhatsApp flags (`whatsappTriggering`, `whatsappTriggered`, `whatsappConnected`), and an `AudioTrackState` instance. |
| `webrtc/AudioTrackState.js` | Per-connection audio state: `hasRealTrack` flag, placeholder sender queue, track buffer. Owned by `Peer`. |
| `webrtc/CallContext.js` | Shared call metadata (one instance per call). Holds `callId`, `businessId`, `userId`, `direction`, caller/callee info. All `Peer` instances for the same call share one `CallContext`. |
| `webrtc/PeerRegistry.js` | In-memory registry: `Map<callId, { FRONTEND, WHATSAPP, MONITOR, context }>`. Owns peer creation, retrieval, and cleanup. **Worker-local** — each PM2 worker has its own registry. Its `checkAndStartBridging()` is the point where a raw `whatsappPc` first crosses into `ivr/` (see boundary leaks below). |
| `webrtc/PeerConfig.js` | Static ICE server configuration (STUN/TURN). |
| `webrtc/PeerEventManager.js` | Wires `RTCPeerConnection` event listeners (`connectionstatechange`, `icecandidate`, `track`). Emits `connectionReady` / `trackReceived` on the EventBus. Singleton. |
| `webrtc/SDPCoordinator.js` | Entry point for all SDP operations. Coordinates the full SDP offer/answer flow and subscription to call events. |
| `webrtc/SDPProcessor.js` | Pure SDP manipulation: `createOffer`, `createAnswer`, `setRemoteDescription`, WhatsApp SDP processing. No side effects. |
| `webrtc/WhatsAppCallApi.js` | HTTP client to Meta's Graph API — the remote signaling channel for the WHATSAPP leg specifically: ships a locally-generated SDP offer/answer to Meta and retrieves Meta's SDP in return (`initiateWhatsAppCall`, `acceptWhatsAppCall`, `rejectWhatsAppCall`, `terminateWhatsAppCall`). Conceptually the counterpart to what a SIP adapter's INVITE/200 OK exchange will need to do. Moved here from a standalone `call/api/` folder — it's WhatsApp/Meta-specific, not a generic "call API". |
| `webrtc/ice/ICECandidateCoordinator.js` | Central coordinator for ICE candidates (both inbound and outbound). Must call `setConnectionInfo(callId, type, socketId)` before SDP answer creation, and `markClientReady(callId)` after — this flushes buffered outbound candidates to the correct socket. |
| `webrtc/ice/ICECandidateManager.js` | Manages inbound ICE candidates with two-stage buffering (pre-connection and post-connection). |
| `webrtc/ice/ICECandidateDispatcher.js` | Dispatches outbound ICE candidates via `EventBus` → `busHandlers` → `RoomManager`. |
| `webrtc/ice/OutboundICECandidateBuffer.js` | Buffers outbound candidates until client signals readiness. |
| `webrtc/ice/OutboundICECandidateManager.js` | Coordinates buffering and flushing of outbound candidates. |
| `webrtc/ice/PreConnectionICEBuffer.js` | Buffers inbound candidates that arrive before peer connection creation. |
| `sip/SipSignalingAdapter.js` | Stub adapter for a SIP trunk/carrier. Every method throws, with a doc comment describing intended SIP semantics (INVITE/200 OK/ACK carrying SDP, no trickle ICE — `addRemoteCandidate` is a documented no-op once implemented since SIP trunks negotiate RTP endpoints directly in SDP). Singleton `sipSignalingAdapter`. |

**Known boundary leaks, not fixed by this scaffolding pass** (documented here
as accepted debt, same convention as `TABLE_OWNERSHIP.md`):
- `events/handlers/AgentEventHandler.js` (`#waitForFrontendAudioTrack`) calls
  `pc.getReceivers()` directly on a raw `RTCPeerConnection` pulled off a
  `Peer` — a business-logic leak past the `PeerRegistry`/`SDPCoordinator`
  abstraction.
- `ivr/` (`IvrCoordinator.js`, `QueueAudioCoordinator.js`,
  `IvrTransferHandler.js`) imports `@roamhq/wrtc` directly and
  receives/mutates the raw `whatsappPc` — a second, parallel WebRTC-coupled
  subsystem alongside `signaling/webrtc/` and `audio/`.
- `AudioBridge`'s control plane (`relayTrack`, `setConnections`,
  `getReceivers`/`getSenders`, `pc.connectionState` checks) and
  `AudioCoordinator.addPlaceholderTrack` / `AudioBridgeCoordinator._getTrackFromConnection`
  assume both call legs are literal `RTCPeerConnection`s. By contrast, the
  *data plane* downstream of `RTCAudioSink.ondata` — `MixingRelay._mixInto`,
  `AudioCaptureService` → `StereoMixBuffer` → `OpusEncoder`,
  `DTMFCaptureService` — is already pure `Int16Array`/`Buffer` PCM with zero
  wrtc awareness. That seam is where a future `MediaPort` would slot in for a
  SIP/RTP audio source; not built yet.

### constants/

| File | Exports |
|------|---------|
| `CallConstants.js` | `ConnectionType`, `CallStatus`, `AgentAvailability`, `CallDirection`, `AssignmentType`, `TerminationReason`, `TerminatedBy` — all `Object.freeze`'d. **Never use raw string literals for these values anywhere in the codebase.** |

### events/

| File | Role |
|------|------|
| `EventTypes.js` | Frozen enum of Redis pub/sub event type strings (e.g. `AGENT_JOINED`, `CALL_TERMINATED`). Used as keys when publishing/subscribing via `RedisPubSubService`. |
| `CallErrorCodes.js` | Frozen enum of all call-domain error codes. Mirrored to the frontend at `resources/js/react/services/call/CallErrorCodes.js` — keep them in sync. |
| `CallErrorEmitter.js` | **Single source of truth for all call-domain errors.** Every error must go through `emitCallError({ callId, code, message, socket?, socketId? })`. Always emits the `call:error` Socket.IO event. Use `callId: null` for management-level errors (no call context). |
| `CallEventHandler.js` | Routes incoming Redis events to the correct specialised handler. Owns instances of all 8 handlers. Singleton via `callEventHandler`. |
| `handlers/` | Eight specialised handlers — one per lifecycle concern. Each is a plain class (no singleton export) instantiated by `CallEventHandler`. |

**Handlers:**

| Handler | Handles |
|---------|---------|
| `InitiationEventHandler` | Outbound call creation: SDP answer, ICE coordinator setup, WhatsApp trigger |
| `AgentEventHandler` | Agent-triggered events: agent joined, SDP offer from agent, ICE candidates |
| `ConnectionEventHandler` | Connection state changes, reconnect timeout logic |
| `WhatsAppEventHandler` | WhatsApp-side events: SDP answer received, WhatsApp SDP processing |
| `TerminationEventHandler` | Call termination: peer cleanup, recording stop, agent release |
| `RejectionEventHandler` | Call rejection by agent or client |
| `TransferEventHandler` | Call transfer between agents |
| `MonitorEventHandler` | Supervisor monitoring: join/leave monitor connection |

### lifecycle/

| File | Role |
|------|------|
| `CallLifecycleLogger.js` | Logs call lifecycle events to the DB (`call_lifecycle_events` table) for audit/analytics. Called from multiple handlers and the webhook processor. Fire-and-forget pattern (`.catch(() => {})`) — logging must never block the call flow. |

### webhook/

| File | Role |
|------|------|
| `CallWebhookProcessor.js` | All WhatsApp webhook business logic. Class with private `_` methods for each concern: ownership gate, connect handling, incoming/outgoing flow, terminate flow, status updates, agent selection, push notifications. Instantiated as singleton `callWebhookProcessor`. |

---

## src/services/redis/

All Redis services extend or use `RedisBaseService` (the low-level client wrapper).

`RedisClient.js` passes `db: config.redis.db` to ioredis so all clients connect to the
logical database selected by `REDIS_DB` in `.env` (default `0`). Use a dedicated db number
(e.g. `REDIS_DB=2`) to isolate node's keys from Laravel's Redis usage and avoid
accidental key collisions.

| File | Role |
|------|------|
| `RedisClient.js` | Singleton client manager. Tracks all created clients to prevent leaks. Passes `db`, `host`, `port`, `password` to every ioredis instance it creates. |
| `RedisBaseService.js` | Foundation: raw Redis `get`/`set`/`del`/`expire`/`hget` etc. All other services use this. |
| `RedisPubSubService.js` | Cross-worker pub/sub. Publishes call events via `publishCallEvent(callId, eventType, data)`. Each worker subscribes to the channels of calls it owns. Owns **4 dedicated ioredis connections** — `PubSub-Publisher`, `PubSub-Subscriber`, `Adapter-Publisher`, `Adapter-Subscriber` — so call event publishes, Socket.IO adapter broadcasts, and base Redis ops never compete on the same TCP pipe. |
| `CallStateCache.js` | Fast-access call metadata cache (avoids repeated DB lookups across workers). |
| `CallOwnershipService.js` | Distributed locking for call ownership. Ensures one worker processes a given call's events at a time. |
| `CallAgentAssignmentService.js` | Agent assignment locks and round-robin pick state. |
| `PresenceService.js` | Tracks online users and their active socket IDs across workers. |
| `RedisCleanupService.js` | Periodic cleanup of orphaned call data. Uses distributed locking. |
| `AgentMissedCallTracker.js` | Per-agent counter of consecutive missed (NO_ANSWER) inbound calls. Increments atomically via a Redis pipeline (`INCR` + `EXPIRE` in one round trip). Resets on accept or after the auto-offline threshold triggers. Keys expire after 24 h. |
| `RedisUtilityService.js` | Cross-cutting helpers that span multiple Redis service concerns. |

---

## src/repositories/

Pure database access. Each repository is a class instantiated as a singleton. No business
logic — only Knex queries and data mapping.

| File | Table(s) |
|------|----------|
| `CallRepository.js` | `calls` |
| `CallConnectionRepository.js` | `call_connections` |
| `AgentRepository.js` | `users` (agents, managers, availability) |
| `BusinessRepository.js` | `businesses`, `business_numbers` |
| `ClientRepository.js` | `clients`, `phone_numbers` |
| `RecordingRepository.js` | `recordings` |
| `CallLifecycleEventRepository.js` | `call_lifecycle_events` |
| `CallTransferLogRepository.js` | `call_transfer_logs` |
| `NotificationRepository.js` | `notification_subscriptions` |

---

## src/controllers/

Thin HTTP handlers. Parse the request, acknowledge immediately (for webhooks), then delegate
to a service. No business logic in controllers.

| File | Route | Delegates to |
|------|-------|--------------|
| `callWebhookController.js` | `POST /api/webhook` | `callWebhookProcessor.process()` |
| `chatWebhookController.js` | `POST /api/chat/status` | EventBus directly |
| `chatMessageController.js` | `POST /api/chat/message` | EventBus directly |
| `chatReadController.js` | `POST /api/chat/read` | EventBus directly |
| `orderController.js` | `POST /api/orders/update` | EventBus directly |
| `templateController.js` | `POST /api/templates/status` | EventBus directly |
| `activityController.js` | `POST /api/activities/reminder` | EventBus directly |
| `healthController.js` | `GET /health` (infra probe) | `workerStatsService`, `encodingWorkerBridge`, `dtmfWorkerBridge` |
| `healthController.js` | `GET /api/health` (detailed) | Full service diagnostics — for ops dashboards and support, not PM2/nginx |

`GET /health` returns 200/503 and is intended for PM2, nginx upstreams, and load-balancer
probes. It is lightweight and synchronous. `GET /api/health` returns detailed per-service
status and is async — never use it as a load-balancer probe.

---

## src/websocket/

### server.js

Factory function `createWebSocketServer(httpServer)`. Responsibilities:
1. Creates `Socket.IO` server with Redis adapter (cross-worker room broadcasts)
2. Sets `io` on `RoomManager`
3. Applies `authMiddleware`
4. Calls `registerAllEventBusListeners()` once per worker
5. On each `connection`: tracks presence, joins business room, registers socket listeners

### managers/RoomManager.js

Wraps all Socket.IO emit/broadcast operations. **Never emit directly via `io` or `socket`
outside this manager.** Key methods:

| Method | Scope |
|--------|-------|
| `emitToSocket(socketId, event, data)` | Single socket |
| `emitToUser(userId, event, data)` | All sockets of one user |
| `broadcastToCall(callId, event, data)` | All sockets in a call room |
| `broadcastToBusiness(businessId, event, data)` | All sockets in a business room |
| `joinCallRoom` / `leaveCallRoom` | Call room membership |
| `joinBusinessRoom` | Business room membership (on connect) |
| `addUserToCallRoom(userId, callId)` | Adds all sockets of a user to a call room |

Because the Socket.IO Redis adapter is active, all broadcasts automatically propagate to
sockets connected on other workers.

### namespaces/

Namespaces: `call/`, `chat/`, `device/`, `orders/`, `templates/`, `activities/`, `ticket/`.
Each has two files (`device/` is the one exception — client-initiated events only, no
server-sourced broadcasts to relay, so it has no `busHandlers.js`):

| File | When registered | Role |
|------|----------------|------|
| `socketHandlers.js` | Per connection (once per socket) | Handles events sent by the client. Validates input, then delegates to services or publishes to Redis. No business logic. |
| `busHandlers.js` | Once per worker process | Handles `EventBus` events emitted by services. Translates them into Socket.IO broadcasts via `RoomManager`. |

`orders/`, `templates/`, and `activities/` are receive-only on the client — their
`socketHandlers.js` is an intentionally empty stub kept only so every namespace follows the
same two-file shape. Laravel pushes these updates via HTTP (see `*SocketService` in
`app/Services/` on the Laravel side): `OrderSocketService` → `POST /api/orders/update`,
`TemplateSocketService` → `POST /api/templates/status`, `ActivitySocketService` →
`POST /api/activities/reminder`. Each controller does `EventBus.emit(...)`, and that
namespace's `busHandlers.js` relays it — `orders`/`templates` broadcast to the business room
(`roomManager.broadcastToBusiness`), `activities` targets the assignee's user room
(`roomManager.emitToUser`) since a reminder belongs to one agent, not the whole business.

The `call/` namespace also has a `handlers/` subdirectory that splits incoming socket events
by concern, keeping `socketHandlers.js` thin:

| File | Handles |
|------|---------|
| `handlers/state.js` | `call:success`, `call:error` bus relay |
| `handlers/delivery.js` | Call delivery events: `call:incoming`, `call:ringing_reconnect_deliver` |
| `handlers/media.js` | SDP and ICE candidate exchange |
| `handlers/network.js` | Reconnect and network quality events |
| `handlers/ivr.js` | IVR DTMF input and session events |

`namespaces/index.js` re-exports `registerAllSocketListeners(socket)` and
`registerAllEventBusListeners()` which are called from `server.js`.

---

## src/utils/

| File | Exports |
|------|---------|
| `notificationLogger.js` | `notifyLog(message, data)` — conditional logging for notification events (gated by config flag). Used only by notification services. |
| `generalHelpers.js` | `normalizeNumber(num)` — strips leading `+` from phone numbers. |
| `metaApiHelper.js` | `graphUrl(version)` — builds the WhatsApp Graph API base URL. |

---

## Architectural Patterns

### Singleton exports

Every class that manages shared state is instantiated once at the bottom of its file and
exported as a named lowercase instance:

```js
class CallManager extends EventEmitter { ... }
export const callManager = new CallManager();
```

Import the singleton instance, never the class:
```js
import { callManager } from '../CallManager.js';   // correct
import CallManager from '../CallManager.js';        // wrong — never instantiate externally
```

### Coordinator pattern

Coordinators are the single entry point for a multi-step domain operation. They own the
full flow and sequence of steps so no caller needs to know the internals:

- `AgentAssignmentCoordinator` — all agent state changes
- `SDPCoordinator` — SDP offer/answer flow end-to-end
- `ICECandidateCoordinator` — ICE candidate lifecycle
- `AudioCoordinator` — audio bridge + placeholder + recording operations

### Manager pattern

Managers own a collection of instances and their lifecycle:

- `AudioBridgeCoordinator` — `Map<callId, AudioBridge>`
- `PeerRegistry` — `Map<callId, { FRONTEND, WHATSAPP, MONITOR, context }>`
- `RecordingManager` — `Map<callId, RecordingSession>`
- `RoomManager` — Socket.IO room operations

### Handler pattern (events/handlers/)

Each handler is a focused class that processes one category of Redis-sourced call events.
Handlers are never singletons — they are instantiated by `CallEventHandler` which acts as
the router. Adding a new event type means creating a new handler class and registering it
in `CallEventHandler`.

---

## Naming Conventions

| Type | Convention | Example |
|------|-----------|---------|
| Class-exporting files | PascalCase | `CallManager.js`, `PeerRegistry.js` |
| Function-exporting files | camelCase | `socketHandlers.js`, `apiRoutes.js` |
| Singleton instance exports | camelCase (lowercase first) | `callManager`, `peerRegistry` |
| Private class methods | `_` prefix | `_handleIncomingCall()`, `_findAvailableAgent()` |
| Redis event types | `SCREAMING_SNAKE_CASE` (via `EventTypes`) | `EventTypes.AGENT_JOINED` |
| Socket.IO event names | `domain:action` (kebab) | `call:incoming`, `call:agent_queue`, `template:status_update`, `activity:reminder` |
| Enum values in constants | `SCREAMING_SNAKE_CASE` | `CallStatus.IN_PROGRESS` |

---

## Cross-Worker Communication Model

```
Worker A                          Redis                          Worker B
───────                          ─────                          ────────
publishCallEvent(callId, type)──▶ channel: callmanager:{callId} ──▶ subscribed handler
                                                                      │
                                                                      ▼
                                                               CallEventHandler
                                                               → specific Handler

broadcastToBusiness(biz, event)──▶ Socket.IO Redis Adapter ──▶ all sockets on all workers
```

- **Redis pub/sub** routes call-specific events to the one worker that holds the peer
  connection for that call.
- **Socket.IO Redis Adapter** automatically propagates room broadcasts to sockets on
  any worker — no manual routing needed.
- **EventBus** is strictly intra-worker. Never subscribe to EventBus and expect events
  from another worker.

---

## Validation Rules

**Two-layer validation:**

| Layer | Location | Validates |
|-------|----------|-----------|
| Input validation | `socketHandlers.js` | Presence of required fields (`callId`, `sdpOffer`, etc.). No DB calls. Errors emitted immediately back to sender. |
| Business validation | Event handlers / services | Domain rules requiring DB or Redis lookup (call exists, call is in correct state, agent is available, etc.). |

Never mix layers — socket listeners must not query the DB, and handlers must not re-validate
primitive field presence.

---

## Error Handling Convention

All call-domain errors must go through `emitCallError`:

```js
import { emitCallError } from '../events/CallErrorEmitter.js';

// Per-call error (has a callId):
emitCallError({ callId, code: CallErrorCodes.ACCEPT_FAILED, message: 'reason', socket });

// Management error (no call context):
emitCallError({ callId: null, code: CallErrorCodes.MISSING_BUSINESS_CONTEXT, message: 'reason', socket });
```

- Always emits the `call:error` Socket.IO event — the frontend listens to exactly one event.
- `callId: null` signals a management/query-level error; the frontend will show a toast
  without resetting call state.
- Never emit `call:error` directly via `socket.emit` or `EventBus.emit` — always use
  `emitCallError`.

---

## Logging Convention

Format: `[Module:sub-concern] Description`

```js
console.log('[Webhook:incoming] Handling call wacid=...');
console.error('[Webhook:terminate] Agent release error for call ...');
console.warn('[Socket] Agent availability sync error:', error);
```

Rules:
- All logs in the call domain use `console.log` / `console.warn` / `console.error` — no
  emojis, no custom logger.
- Error logs always pass the `error` object as the second argument (not just
  `error.message`) so the full stack trace is preserved.
- Socket-layer logs use prefix `[Socket]`. EventBus-relay logs use `[EventBus]`. Webhook
  logs use `[Webhook:*]`. WebSocket infrastructure uses `[WS]`.

---

## Call Flows (Reference)

### Inbound call (WhatsApp → agent)

```
WhatsApp ──▶ POST /api/webhook
              │
              ▼
        CallWebhookProcessor._handleIncomingCall()
              │ creates call record, creates WHATSAPP connection record
              │ creates FRONTEND SDP offer (SDPCoordinator.createSDPOffer)
              │ subscribes this worker to Redis channel for callId
              ▼
        EventBus.emit('call:incoming', IncomingCallPayload)
              │
              ▼
        busHandlers → RoomManager.emitToUser(userId, 'call:incoming')
              │
              ▼ (agent accepts)
        socket 'call:accept' → Redis AGENT_JOINED
              │
              ▼
        AgentEventHandler → SDPCoordinator.createSDPAnswer()
              │               ICECandidateCoordinator.setConnectionInfo()
              │               ICECandidateCoordinator.markClientReady()
              ▼
        AudioCoordinator bridges FRONTEND ↔ WHATSAPP audio
```

### Outbound call (agent → WhatsApp)

```
Agent ──▶ socket 'call:initiate'
              │
              ▼
        CallManager.initiateCall() → InitiationEventHandler.handleCallInitiate()
              │ creates call record
              │ creates FRONTEND peer connection + SDP answer
              │ ICECandidateCoordinator.setConnectionInfo() + markClientReady()
              │ subscribes this worker to Redis channel for callId
              ▼
        Redis CALL_INITIATE → InitiationEventHandler.handleCallInitiated()
              │ triggers WhatsApp API call (WhatsAppCallApi)
              ▼
        WhatsApp ──▶ POST /api/webhook (connect, BUSINESS_INITIATED)
              │
              ▼
        CallWebhookProcessor._handleOutgoingCall()
              │ publishes WHATSAPP_ANSWER_RECEIVED to Redis
              ▼
        WhatsAppEventHandler → processes SDP answer → bridges audio
```

### Call termination

```
Any termination source (agent socket, WhatsApp webhook, disconnect)
              │
              ▼
        Redis CALL_TERMINATED
              │
              ▼
        TerminationEventHandler
              │ closes peer connections
              │ stops recording + uploads to S3
              │ releases agent availability
              │ emits queue update
              ▼
        EventBus 'call:terminated' → busHandlers → broadcast to business room
```
