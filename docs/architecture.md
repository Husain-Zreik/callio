# Callio architecture

How Callio works inside: the integration surfaces, the boundaries, the process model, the call
flows, routing, media, IVR and the startup/shutdown order.

This doc doesn't repeat [CLAUDE.md](../CLAUDE.md). The code layout ("Layout"), design rules,
patterns, commands and logging rules are there. The public contracts are
[management-api.md](management-api.md), [events.md](events.md) and
[agent-protocol.md](agent-protocol.md). The SIP channel is in [sip.md](sip.md) and the schema is
in [data-model.md](data-model.md).

## What Callio is

A contact-center call engine that any product integrates with. Customers call over a channel.
Agents answer in a browser or app over WebRTC. Callio owns everything in between: routing, IVR,
availability, transfers, monitoring, recording and the call record. Every media leg ends at
Callio, and Callio bridges them. Agents never talk to the provider, and consumers never touch
media.

| Actor | What it is |
|---|---|
| Consumer | A product using Callio. It has API keys, JWT signing keys, an event webhook and an optional lookup URL. |
| Tenant | A consumer's workspace. Everything below belongs to one tenant. |
| Agent / supervisor | A consumer's staff user (`agents.role`). Supervisors also see, monitor and assign the tenant's calls. |
| Customer | The far end of a channel. Never talks to Callio or the consumer directly. |
| Channel | A line: a WhatsApp number, or a SIP DID on a trunk. It has an inbound queue and a recording setting. |
| Queue | Members, a strategy, timers and an overflow queue. Inbound calls wait in one. |

Consumers attach their own meaning through `external_ref` / `consumer_metadata`. Callio stores
these and returns them, but never interprets them.

## Integration surfaces

### Management API

REST under `/v1` for the consumer's backend, with `Authorization: Bearer <api key>`
(`src/http/auth/apiKeyAuth.js`). The key resolves the consumer, and every route is scoped to its
tenants. The API upserts tenants, agents, queues and members, channels, IVR flows, audio assets
and push tokens by the consumer's own refs, and forces availability. It also creates outbound
call intents, queries calls, terminates them, returns recording URLs and patches refs and
metadata (`src/http/v1/managementRoutes.js`, `callRoutes.js`). Contract:
[management-api.md](management-api.md).

### Consumer events and the lookup hook

`ConsumerEventPublisher` (`src/core/events/`) turns in-process call events into consumer events.
It writes them to the `webhook_deliveries` outbox and never sends them inline. `OutboxDispatcher`
(`src/outbox/`) POSTs them to `event_webhook_url`: signed with HMAC-SHA256, at least once, with
backoff. Before an inbound call rings, `CustomerLookup` (`src/core/calls/`) can call the
consumer's `lookup_url` under a short timeout. The answer can supply a name, refs or metadata, or
reject the call. A slow consumer can delay a call but never drop it. Contract:
[events.md](events.md).

### Agent gateway

Socket.IO with the websocket transport only (`src/realtime/server.js`), plus one WebRTC peer per
agent leg. The consumer signs a short-lived HS256 JWT (`iss` consumer slug, `kid`, `sub` agent
ref, `tnt` tenant ref). `src/realtime/middleware/authMiddleware.js` verifies it and provisions
the agent on first connect. Socket handlers (`src/realtime/namespaces/call/socketHandlers.js`)
check payload shape, authorize through `CallAccess` (`src/core/calls/`) and publish a Redis call
event. The relays in `namespaces/call/handlers/*` turn `EventBus` events into room emits.
Contract: [agent-protocol.md](agent-protocol.md).

### Channel ingress

- **WhatsApp.** Meta posts to `POST /webhooks/whatsapp`, verified with `X-Hub-Signature-256`. A
  consumer whose Meta webhook points at its own backend can forward the same payload to
  `POST /v1/webhooks/whatsapp/forward` with an API key (`src/channels/whatsapp/webhookRoutes.js`).
  `WhatsAppWebhookTranslator` resolves the line from `phone_number_id` and turns `calls` and
  `statuses` into `ChannelIngress` calls.
- **SIP.** drachtio-server spreads new INVITEs across the workers' drachtio connections.
  `SipIngress` does four things:
  1. Resolves the channel from the dialled DID.
  2. Checks the trunk's source CIDRs.
  3. Gets a WebRTC offer from rtpengine.
  4. Calls `ChannelIngress.inboundCall`.

  CANCEL and BYE become `callEnded`. See [sip.md](sip.md).

### Push

`src/push/CallPushNotifier.js` decides who gets which push. It sends them whether or not the
agent also has a live socket: an open web tab says nothing about the phone app.

| Platform | Delivery | `type` |
|---|---|---|
| Android | FCM data message | `call.incoming`, `call.cancelled` |
| iOS | APNs VoIP (CallKit) + an FCM visible alert | `call.incoming`, `call.cancelled`; alert `call.incoming.alert` |
| Web | OneSignal | `call.incoming` |

- **Credentials:** each device is pushed with its agent's consumer's credentials
  (`consumers.push_credentials`, `src/push/PushCredentials.js`), falling back per provider to the
  platform's from env. The senders keep one Firebase app / APNs connection per credential set and
  drop the old one when a consumer replaces its credentials.
- **Fields:** `call_id`, `call_uuid`, `tenant_id`, `channel`, `customer_name`, `customer_address`.
  There is never any SDP: the app connects and sends `calls:sync`.
- **Where pushes are sent from:** the `call:incoming` and `call:offer_withdrawn` relays
  (`realtime/namespaces/call/handlers/delivery.js`), and the core on accept and reject
  (`notifyCallResolved`).

Contract: [agent-protocol.md → Push](agent-protocol.md#push).

## Boundaries

The one real port is the **customer channel**:

- **`CustomerChannels`** (`src/core/channels/CustomerChannels.js`) is the port and the registry.
  The core looks an adapter up by `calls.channel`. An adapter implements `accept`, `reject`,
  `terminate`, `initiate`, `normalizeCustomerAddress` and `validateChannelConfig`, and optionally
  `registerRoutes` and `start`/`stop`.
- **`ChannelIngress`** (`src/core/channels/ChannelIngress.js`) is where adapters report provider
  events: `inboundCall`, `outboundAnswered`, `statusChanged` and `callEnded`. Every call decision
  is made here once, for all channels:
  - dedup
  - out-of-order ends (tombstones)
  - the lookup
  - IVR or queue
  - the termination reason
  - agent release
- **`sdp` hooks.** An adapter's `localOffer`, `remoteOffer` and `remoteAnswer` reach media as the
  CUSTOMER leg's `sdpProfile` (`whatsappSdp.js`, `sipSdp.js`). Media knows no provider.
- **Registration.** Adapters are registered in `src/channels/index.js`. `core/` and `media/`
  import no adapter.

Everything else is a plain import, not a port:

- **Media.** The event handlers, `ChannelIngress`, `CallTerminator`, `CallCleanupService`,
  `AgentAssignmentCoordinator` and `core/ivr/` import `media/webrtc` directly: `peerRegistry`,
  `sdpCoordinator` and `iceCoordinator`. They also import `media/bridge`, `media/dtmf` and
  `media/playback`, and `IvrCoordinator` imports `@roamhq/wrtc`. Media imports the core back:
  `PeerRegistry` imports `ivrCoordinator` and `CallErrorEmitter`.
- **Push.** `AgentEventHandler` and `RejectionEventHandler` import `callPushNotifier`.
- **Sockets.** `core/events/CallErrorEmitter.js`, `AgentEventHandler` and `MonitorEventHandler`
  import `realtime/managers/RoomManager`. Every other core-to-socket path is an `EventBus` event.
- **Policy in `realtime/`.** `handlers/delivery.js` suppresses an offer to an agent who already
  has a ringing call. `handlers/network.js` runs the customer-network-loss timers: a warning at
  15 s, the end at 20 s.

## Process model

- **Workers.** PM2 runs `WORKER_COUNT` fork-mode workers on `BASE_PORT + i`
  (`ecosystem.config.cjs`). Each worker runs every surface, and workers share no memory.
- **No call-aware routing.** Any worker takes any HTTP request, webhook, socket or INVITE, and
  there is no call-aware load balancing. Callio routes to the right worker internally.
- **Call ownership.** A call's media (wrtc peers, bridge, recording, IVR) lives on one worker.
  - Inbound: `ChannelIngress` claims `call:owner:<CHANNEL>:<providerCallId>` through
    `CallOwnershipService` (`src/infra/cluster/`). The winner creates the peers. The claim becomes
    permanent while the call is live.
  - Outbound: media lives on the worker whose socket sent `call:start`.
  - SIP: a leg's dialog lives on the same worker. `SipDialogs` routes reject/terminate from other
    workers to it.
- **Call events.** `RedisPubSubService.publishCallEvent` publishes to `callmanager:{callId}`.
  Only the media owner subscribes, from `SDPCoordinator.createSDPOffer` (AGENT leg) or
  `handleCallStart`. `CallEventHandler` routes each event to its handler, and handlers check
  `peerRegistry` before touching media. Socket actions, API terminates and `CallTerminator` all
  reach the owner this way.
- **Rooms.** The Socket.IO Redis adapter carries room emits to every worker. `EventBus` is
  strictly in-process.
- **Redis connections per worker.** The base client, plus four pub/sub clients
  (`PubSub-Publisher`, `PubSub-Subscriber`, `Adapter-Publisher`, `Adapter-Subscriber`). There is
  also `LogLevels-Subscriber`, and `SIP-Commands` when SIP is registered.
- **Admission control.** A worker holding `MAX_CALLS_PER_WORKER` calls' media refuses new sockets
  with `SERVER_AT_CAPACITY` (`index.js`).

Every worker runs these background loops:

| Loop | Every | Runs once cluster-wide? |
|---|---|---|
| `OutboxDispatcher` | poll | Yes, Redis lease |
| `QueueTimeoutService` | 2 s | Yes, lock `callio:queue-timeouts:lock` |
| `RedisCleanupService`: stale ownership keys | 5 min | Yes, lock `cleanup:lock` |
| `CallCleanupService`: stuck calls, expired outbound intents, stale recordings, orphaned local peers, IVR agent ring timeout | 30 s | No lock. Every worker scans, and `CallTerminator`'s guarded commit applies side effects once. The peer reconcile is per worker by design. |

## Inbound call

1. **Offer.** A WhatsApp `connect` webhook (`WhatsAppWebhookTranslator`) or a SIP INVITE
   (`SipIngress` + rtpengine) reaches `ChannelIngress.inboundCall`, which claims ownership.
2. **Pre-checks.** A tombstone means the end came first: record a missed call. An active call
   from the same customer is a duplicate: record CANCELLED. Otherwise run `CustomerLookup`.
3. **Route.** `QueueRouter.selectIvrFlow` runs first. With no IVR, `claimForNewCall` claims an
   agent: ROUND_ROBIN or PRIORITY only, and never ahead of older waiting calls. Callio writes the
   `calls` row and the CUSTOMER `call_connections` row (the customer's offer) and publishes
   `call.created`.
4. **IVR branch.** `sdpCoordinator.createSDPAnswer(CUSTOMER, sdpProfile)` → `channel.accept` →
   `markIvrAutoAccepted`. Supervisors get `call:incoming:supervisor`. The session starts when
   the customer leg connects ([IVR](#ivr)).
5. **Queue branch.** `createSDPOffer(AGENT)` creates the agent peer and subscribes this worker.
   `call:incoming` and a push go to the claimed agent, or to every available member (RING_ALL).
   If nobody can take it yet, Callio emits `call:waiting` and calls
   `assignOldestUnassignedCall`.
6. **Accept.** `call:accept` (with the agent's SDP answer) passes `CallAccess`, and the socket
   worker publishes `AGENT_JOINED`. On the owner, `AgentEventHandler.handleAgentJoined`:
   1. Checks queue capacity and that the agent has no other call.
   2. Claims the call (`assignCallToAgentIfEligible` + `markOnCall`; `claimHandover` for a
      transfer).
   3. Runs `iceCoordinator.setConnectionInfo` → `processSDPAnswer(AGENT)` → `markClientReady`,
      which flushes the buffered server candidates.
   4. Waits up to 5 s for the agent's mic track, and aborts the accept if none arrives.
   5. Answers the customer if nothing has yet: `createSDPAnswer(CUSTOMER, sdpProfile)` →
      `channel.accept`.
   6. Moves the call from RINGING to IN_PROGRESS (guarded) and sets `answered_at`. It then logs,
      resets the missed streak, emits `call:handled` (and `call:offer_taken` for RING_ALL), and
      sends the resolved push.
7. **Bridge.** With both peers connected, `PeerRegistry.checkAndStartBridging` starts the bridge
   and recording ([Media](#media)).

## Outbound call

1. **Intent.** `POST /v1/tenants/{t}/calls`: the consumer owns consent. `createOutboundIntent`
   writes an INITIATED row bound to one agent. `CallCleanupService` cancels intents not started
   within 2 minutes.
2. **Start.** The agent sends `call:start` (call id + SDP offer). On the socket's worker,
   `InitiationEventHandler.handleCallStart` checks ownership and state, subscribes, and runs
   `createSDPAnswer(AGENT)` → `markClientReady`. It sets the agent ON_CALL and returns the
   answer.
3. **Dial.** The socket handler publishes `CALL_INITIATE`. `triggerCustomerConnection` runs
   `createSDPOffer(CUSTOMER, sdpProfile)` → `channel.initiate` and stores the provider call id. A
   failed dial ends the call FAILED through `CallTerminator`.
4. **Answer.** The WhatsApp `connect` webhook or the SIP 200 OK reaches
   `ChannelIngress.outboundAnswered`, which publishes `CUSTOMER_ANSWER_RECEIVED`.
   `CustomerEventHandler` runs `processSDPAnswer(CUSTOMER, sdpProfile)`. RINGING, ACCEPTED,
   REJECTED and FAILED arrive through `statusChanged`.
5. **Bridge.** Bridging starts as for an inbound call. When the call ends, the agent goes
   OFFLINE, not back into the queue.

## Transfer

`call:transfer` (authorized by `CallAccess.canTransfer`) targets an agent or a queue. A
supervisor assigning an unassigned call takes the same path. On the owner,
`TransferEventHandler.handleCallTransferred`:

1. **Target.** Resolves the target and claims it (AVAILABLE → ON_CALL). A queue target picks one
   member by strategy. RING_ALL picks round-robin here, because a transfer goes to one agent.
2. **Move.** Moves the call guarded (`updateCallAgentIfCurrent` /
   `assignCallToAgentIfUnassigned`) and updates the queue. On a live call it sets `offered_at`
   (`markHandoverOffered`) and releases the old agent.
3. **Agent leg.** Closes the old AGENT peer and creates a new AGENT offer. The customer leg stays
   up.
4. **Notify.** Emits `call:terminated` (`transferred`) to the room, moves room membership, logs,
   and sends `call:incoming` (TRANSFERRED) to the target. The target's accept is inbound step 6 as
   a handover.

**Transfer timeout.** `QueueTimeoutService` treats an IN_PROGRESS call with `offered_at` as a
handover. After `CALL_TRANSFER_TIMEOUT_SECONDS` (default 30), an inbound call with a queue goes
back to it (`returnHandoverToQueue` + `passOffer`, counted as a miss). Any other call ends as
TIMEOUT.

## Termination

Every end goes through `CallTerminator` (`src/core/calls/CallTerminator.js`), in this order:

1. **Guarded commit.** `terminateCallIfNotTerminated` or `markCallFailedIfNotFinal`, optionally
   `onlyIfStatus`. A path that loses the race only closes its local media.
2. **Announce.** `call:terminated` on `EventBus`, which reaches clients, consumer events and
   push.
3. **Release the agent.** Inbound: AVAILABLE, then drain the queues. Outbound (or
   `agentAfter: 'offline'`): OFFLINE.
4. **Provider.** `terminate`, or `reject` for an unanswered inbound call.
5. **Media.** Closes local peers and publishes `CALL_TERMINATED`, so the owning worker closes its
   peers too.
6. **Record.** Lifecycle log, queue snapshot and metrics.

`settle()` is steps 2–6, for `ChannelIngress.callEnded`, which commits with the provider's own
timing. These code paths end calls:

- `TerminationEventHandler`: agent or API hang-up, ICE exhausted, customer network loss
- `ChannelIngress`
- `QueueTimeoutService`
- `IvrTerminationHandler`
- `CallCleanupService`
- `InitiationEventHandler`: dial failure

## Routing

All in `src/core/routing/`.

- **`QueueRouter`** is the only reader of `queues.strategy`. It also enforces `max_active_calls`
  and selects IVR flows.
  - `RING_ALL` offers to every available member, and the first accept wins. A call with no
    queue rings all of the tenant's agents.
  - `ROUND_ROBIN` picks the longest-available member.
  - `PRIORITY` picks the lowest `priority`, then the lowest id.
- **`CallAgentAssignmentService`** holds a per-queue Redis lock (5 s), so two workers never claim
  for one queue at once. It also keeps the round-robin order (an agent keeps their place through a
  short disconnect). The claims themselves are guarded SQL (`claimAgentIfAvailable`,
  `claimAgentAndAssignCall`).
- **`AgentAssignmentCoordinator`** is the single entry point for:
  - availability changes
  - releasing agents
  - draining queues, oldest call first
  - transfers into queues
  - passing an offer on
  - overflow
- **`QueueTimeoutService`** enforces the queue timers:
  - `ring_timeout_seconds`: an offer that rings out passes to the next member.
  - `max_wait_seconds`: the call moves to `overflow_queue_id` (at most 3 hops) or ends as
    TIMEOUT.
  - The transfer timeout (above).

  It keeps its state in the `calls` row (`offered_at`, `queued_at`, `overflow_count`), so any
  worker can take over.
- **`OfferHistory`** (Redis) records who passed on a waiting call. `declined` agents are never
  offered that call again. `missed` agents are skipped until everyone else has had it, then a new
  round starts. Overflow clears `missed`.
- **`AutoOfflinePolicy`** (`tenants.auto_offline_*`) sets an agent OFFLINE after N consecutive
  missed offers (`AgentMissedCallTracker`). It doesn't count RING_ALL misses or misses while the
  agent is on another call.

## Media

**Legs and peers.** `PeerRegistry.peerConnections` holds `callId → { AGENT, CUSTOMER, MONITOR,
context }`, all `@roamhq/wrtc` peers:

- **AGENT:** the agent's browser or app.
- **CUSTOMER:** Meta's relay, or rtpengine for SIP.
- **MONITOR:** a supervisor.

A call's peers share one `CallContext`. `Peer` holds per-leg SDP state and an `AudioTrackState`.
`PeerEventManager` wires the connection state, ICE and track events.

**SDP and ICE.**

- `SDPCoordinator` owns offers and answers for every leg and stores them in `call_connections`.
- `SDPProcessor` applies the `sdpProfile` to the CUSTOMER leg only.
- ICE servers come from `IceServers.js`: TURN REST credentials from `TURN_SECRET`, or a static
  pair. Clients get the same list in `session:ready`.
- Inbound candidates are buffered in two stages. `PreConnectionICEBuffer` holds them before the
  peer exists, and `ICECandidateManager` holds them until the remote description is set.
- Outbound candidates wait in `OutboundICECandidateBuffer` until `markClientReady`. Then
  `ICECandidateDispatcher` sends them via `EventBus` to the socket from `setConnectionInfo`.
- `PeerRegistry` warns when one leg has been connected for 8 s while the other is still stuck in
  ICE.

**Bridging.** `PeerRegistry.checkAndStartBridging` runs on every connection-ready event and on a
late customer track. An IVR call whose flow hasn't finished needs only CUSTOMER, and starts the
IVR session. Any other call waits for AGENT and CUSTOMER, then runs
`AudioCoordinator.checkAndStartBridging`:

- `AudioCoordinator` is the entry point for audio.
- `AudioBridgeCoordinator` owns `Map<callId, AudioBridge>`.
- `AudioBridge` relays AGENT ⇄ CUSTOMER via `Peer.deliverTrack` and feeds MONITOR.
- `RecordingCoordinator` starts the recording.

**Supervisor monitoring.** `call:monitor` adds a MONITOR peer (`MonitorEventHandler`). The
supervisor always hears both sides. `SupervisorCapture` copies the supervisor's mic PCM, and
`MixingRelay` mixes it into a path, 10 ms frames, allocation-free:

- **listen:** no relays.
- **whisper:** mixed into customer → agent. `call:agent:private` swaps agent → customer to
  silence, so the agent can reply privately.
- **barge:** mixed into both directions.

**Placeholders and watchdogs.**

- **Placeholder tracks.** `PlaceholderTrackFactory` fills senders that have no real track, with
  silence or the reconnecting tone. The tone is 600 → 750 → 900 Hz (0.2 s each) plus 1.2 s of
  silence, precomputed at 48 kHz.
- **Agent drop.** When the agent peer drops mid-call (`AGENT_DISCONNECTED`), the customer hears
  the tone and recording continues through it. `ConnectionEventHandler` ends the call if the
  agent isn't back within 120 s.
- **Customer drop.** `CustomerSilenceWatchdog` watches the customer track. About 3 s of all-zero
  PCM (jitter-buffer concealment) counts as a drop, and the first non-zero frame counts as a
  recovery. Each change emits `customer:media:state`, and `network.js` ends the call as
  CUSTOMER_NETWORK_LOSS at 20 s.
- **Quality.** `CustomerNetworkMonitor` polls `getStats()` (jitter, loss) and reports a 4-level
  quality to the room.

**DTMF.** `DTMFCaptureService` sinks the customer track and sends PCM to one worker thread per
process (`DTMFWorkerBridge` → `DTMFWorker`). There, `DTMFDetector` runs Goertzel with twist,
power and consecutive-window checks. It re-initialises its window when the sample rate changes:
wrtc starts at 16 kHz, then switches to 48 kHz. Digits come back as `call:dtmf` on `EventBus`.
Detection is in-band only, so `sipSdp.js` drops `telephone-event` and carriers send DTMF as
audio.

**Recording.**

- **Policy.** Recording is per channel (`channels.recording_enabled`), decided by
  `RecordingCoordinator`. `RecordingManager` holds `Map<callId, RecordingSession>`.
- **Format.** One stereo OGG/Opus file per call: customer on the left, agent on the right.
  `AudioCaptureService` captures both sides.
- **Encoding.** Mixing (`StereoMixBuffer`), `OpusEncoder` (`@discordjs/opus`) and `OggMuxer` run
  in `ENCODING_WORKER_COUNT` worker threads (`EncodingWorkerBridge`, default 2) that restart
  with backoff. Without native Opus bindings, encoding is disabled and calls go unrecorded.
- **Upload.** Pages stream to S3 (`infra/storage/StreamUploader`).
- **Agent changes.** A reconnect or a transfer replaces the agent track in the running session.

**Playback.** `IvrAudioPlayer` decodes audio to 48 kHz mono PCM: WAV directly, other formats
through ffmpeg. It pushes 10 ms frames through an `RTCAudioSource`, and IVR prompts use it.
`QueueAudioCoordinator` loops hold audio after an IVR transfer. It plays the reconnecting tone
while the file decodes and stops when the agent bridge starts.

**SIP media.** rtpengine converts the carrier's RTP to WebRTC and back (ICE + DTLS-SRTP), so a
SIP customer leg is an ordinary CUSTOMER peer. Bridge, IVR, DTMF, recording and monitoring are
the same code for both channels ([sip.md](sip.md)).

## IVR

- **Selection** (`QueueRouter.selectIvrFlow`, at arrival). Channel flows come before tenant-wide
  ones. The first flow whose `trigger_condition` holds against the inbound queue wins. The
  conditions are `ALWAYS`, `ALL_AGENTS_BUSY`, `ALL_AGENTS_OFFLINE` and `ALL_AGENTS_UNAVAILABLE`.
  The flow schema is in [management-api.md → IVR flows](management-api.md#ivr-flows).
- **`IvrEngine`** runs one session per call over the flow graph, from `ivr_start`:
  - `ivr_menu`: prompt, then wait for a digit, with timeout and invalid-input handling.
  - `ivr_play`: play, then advance.
  - `ivr_transfer`: ends the flow as `transferred`.
  - `ivr_hangup`: ends the flow as `hung_up`.
  - An unknown node type ends the flow as `error`.
- **`IvrCoordinator`** is started by `checkAndStartBridging` and owns the sessions. It puts the
  IVR audio track on the customer sender and drives `dtmfCaptureService` directly: start, pause
  while a prompt plays, resume, stop.
- **`IvrTransferHandler`** runs on `transferred`:
  1. Checks whether the target agent or queue is available.
  2. Applies the node's offline or busy action: hang up, replay, queue, or wait with busy audio.
  3. Resets `ringing_at`, calls `enterQueue` (starts `queued_at`) and pre-creates the AGENT offer
     on the owning worker.
  4. Starts queue audio and calls `AgentAssignmentCoordinator.assignTransferredCall`.
- **`IvrTerminationHandler`** handles `call:ivr_terminated`, sent for every other ending. It ends
  the call through `CallTerminator`: hang-up → COMPLETED, timeout → TIMEOUT, error →
  SYSTEM_ERROR. If the agent an IVR call was handed to never answers, `CallCleanupService` ends
  it as IVR_AGENT_NO_ANSWER.

## Startup and shutdown

**Startup** (`index.js`, `src/server/bootstrap.js`):

1. **Logging.** `infra/logging/serverLogging.js` is imported first, which opens the files and
   bridges `console.*`. Then Fastify, the access log and CORS.
2. **`initRedis()`.** The base client, then `redisPubSubService`, `presenceService` and
   `redisCleanupService`, then log-level control. A failure here aborts startup.
3. **`initOptionalServices()`.** S3, the encoding worker pool and the DTMF worker, under
   `Promise.allSettled`. A failure only disables recording or DTMF.
4. **Routes.** `registerChannels()`, then health, `/metrics`, `/v1` and each channel's routes.
5. **`createWebSocketServer()`.** The Redis adapter, `authMiddleware`, the `EventBus` relays and
   the connection handler. Then runtime gauges and admission control.
6. **`startCoreServices()`.**
   - Registers `consumerEventPublisher` and `ivrTerminationHandler`.
   - Clears this worker's stale presence.
   - Starts `redisCleanupService`, `callCleanupService`, `queueTimeoutService` and
     `outboxDispatcher`.
   - Runs each channel's `start()`. SIP connects to drachtio and rtpengine here.
7. **Listen.** Signal handlers, worker stats, then `listen`.

**Shutdown** (`src/server/shutdown.js`) runs in strict order. It has a double-run guard, and
`isShuttingDown` makes the WhatsApp webhook answer 503. A hard exit is armed first: the worker
exits after 60 s even if a step hangs. PM2's `WORKER_KILL_TIMEOUT` (default 65 s) is above it.

0. Stop `callCleanupService` (its sweep would race the peer closing below).
1. Close Socket.IO and wait 800 ms.
2. Stop recordings: flush Opus, finalize the OGG, end the upload streams. Then (2a) terminate
   the encoding and DTMF worker threads.
3. Close all peers.
   - `batchTerminateCalls` as SERVICE_MAINTENANCE, and fill in the durations.
   - Stop IVR sessions and write lifecycle logs.
   - `customerChannels.terminate` each live call, best effort.
4. Stop worker stats.
5. Wait up to 45 s for S3 uploads.
6. Stop `redisCleanupService`, `queueTimeoutService`, `outboxDispatcher` and each channel's
   `stop()`.
7. Release the cleanup lock and close pub/sub.
8. Close the Redis clients.
9. Close storage.
10. Close the MySQL pool.

Then `server.close()` and exit.

## Known gaps

- **Boundary leaks.** Listed under [Boundaries](#boundaries).
