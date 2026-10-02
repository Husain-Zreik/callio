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
availability, transfers, monitoring, recording and the call record. Every media leg ends on
Callio's media plane — rtpengine at the edge, FreeSWITCH rooms behind it — and Callio decides
who is in each room and who hears whom. No audio passes through Callio's Node processes. Agents
never talk to the provider, and consumers never touch media.

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

Socket.IO with the websocket transport only (`src/realtime/server.js`), plus one WebRTC peer
connection per agent leg, to rtpengine. The consumer signs a short-lived HS256 JWT (`iss` consumer slug, `kid`, `sub` agent
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
- **`sdp` profile.** An adapter's `sdp` says how its customer leg is carried (`transport`:
  `webrtc` or `rtp`) and holds its `localOffer`, `remoteOffer` and `remoteAnswer` rewrites; media
  takes it as the customer leg's `sdpProfile` (`whatsappSdp.js`, `sipSdp.js`). Media knows no
  provider.
- **Registration.** Adapters are registered in `src/channels/index.js`. `core/` and `media/`
  import no adapter.

Two small ports let the core reach agents without importing their layers. The
implementations are registered at startup:

- **`agentConnections`** (`src/core/agents/AgentConnections.js`): emit to one
  socket, cluster-wide liveness, detach a socket from a call. Registered by
  `realtime/server.js` (RoomManager). Everything else the core tells sockets
  goes out as an `EventBus` event that `realtime/` relays.
- **`callNotifications`** (`src/core/calls/CallNotifications.js`): stop other
  devices ringing when a call is answered or declined. Registered by
  `server/bootstrap.js` (CallPushNotifier).

Call policy lives in the core, and `realtime/` only relays:
`core/routing/OfferDelivery` suppresses a direct offer to an agent who already
has a ringing call. `core/calls/CustomerNetworkLossPolicy` gives a silent
customer 15 s before warning the agent and 20 s before ending the call as
`CUSTOMER_NETWORK_LOSS`.

The **media port**, `callMedia` (`src/core/media/CallMedia.js`), is the core's only way to touch
audio. It is room-shaped (participants, who hears whom) and documented in the file; the
implementation, `src/media/rooms/`, is registered at startup by `server/bootstrap.js`.
`core/media/MediaLegs.js` wraps the calls that also keep each leg's record in `call_connections`
(its SDP, agent and device; the agent offer a ringing call is re-delivered with).

## Process model

- **Workers.** PM2 runs `WORKER_COUNT` fork-mode workers on `BASE_PORT + i`
  (`ecosystem.config.cjs`). Each worker runs every surface, and workers share no memory.
- **No call-aware routing.** Any worker takes any HTTP request, webhook, socket or INVITE, and
  there is no call-aware load balancing. Callio routes to the right worker internally.
- **Call ownership.** A call's legs (their FreeSWITCH endpoints, which report back to the worker
  that made them) and its IVR session live on one worker.
  - Inbound: `ChannelIngress` claims `call:owner:<CHANNEL>:<providerCallId>` through
    `CallOwnershipService` (`src/infra/cluster/`). The winner creates the legs. The claim becomes
    permanent while the call is live.
  - Outbound: media lives on the worker whose socket sent `call:start`.
  - SIP: a leg's dialog lives on the same worker. `SipDialogs` routes reject/terminate from other
    workers to it.
- **Call inputs** (`src/infra/cluster/CallInbox.js`). The worker that sets a call's media up
  takes its lease (`callio:call:<id>:lease` = its boot id, 15 s, renewed every 5 s) and reads
  its inbox, a Redis Stream (`callio:call:<id>:inbox`). Any worker `post()`s socket actions, API
  terminates and `CallTerminator`'s close to it. An input posted while no worker holds the lease
  waits in the stream instead of being lost; a cursor records what the owner took.
  `CallEventHandler` routes each input to its handler, and handlers check `callMedia.owns` /
  `hasAgentOffer` before touching media. The lease and inbox go when the call ends.
  `callInbox.request()` is a post that waits for the owner's answer (on the requester's
  `callio:worker:<boot>:replies` channel): a queue drained on another worker with no stored
  agent offer asks the owner for one (`OFFER_AGENT`), so the agent leg is made in the call's own
  room.
- **Rooms.** The Socket.IO Redis adapter carries room emits to every worker. `EventBus` is
  strictly in-process.
- **Redis connections per worker.** The base client, the call inbox's two (`CallInbox`,
  `CallInbox-Reader`, a blocking stream read) and Socket.IO's two (`Adapter-Publisher`,
  `Adapter-Subscriber`). There is
  also `LogLevels-Subscriber`, and `SIP-Commands` when SIP is registered. Media adds a FreeSWITCH
  event-socket connection and a listener FreeSWITCH connects back to (HTTP port + 1000).
- **Admission control.** A worker holding `MAX_CALLS_PER_WORKER` calls' legs refuses new sockets
  with `SERVER_AT_CAPACITY` (`index.js`).

Every worker runs these background loops:

| Loop | Every | Runs once cluster-wide? |
|---|---|---|
| `OutboxDispatcher` | poll | Yes, Redis lease |
| `QueueTimeoutService` | 2 s | Yes, lock `callio:queue-timeouts:lock` |
| `RedisCleanupService`: stale ownership keys | 5 min | Yes, lock `cleanup:lock` |
| `RetentionService`: old call detail, SDP, finished webhook deliveries, expired recordings ([data-model.md → Retention](data-model.md#retention)) | 1 h (`RETENTION_SWEEP_SECONDS`) | Yes, key `callio:retention:swept` with that TTL |
| `CallCleanupService`: stuck calls, expired outbound intents, stale recordings, ended calls' local media, IVR agent ring timeout | 30 s | No lock. Every worker scans, and `CallTerminator`'s guarded commit applies side effects once. The media reconcile is per worker by design. |
| `RoomMedia` orphan sweep: media-server endpoints and rtpengine legs of dead workers | 30 s, and at start | No lock: each leg is tagged with its worker's boot id, alive while that id is in Redis — and a live call's legs never go: some worker holds its lease, or it's waiting to be adopted (`callio:calls:leased`) |
| `CallAdoption` (`src/core/calls/`): live calls whose lease lapsed (their worker stopped) are taken over — the lease claimed, the room rebuilt from its Redis snapshot, the inbox read from the cursor | 2 s | One worker wins each lease (`SET NX`) |
| `Deadlines` (`src/infra/cluster/`): per-call timers in a Redis sorted set — the agent's 120 s reconnect window, the customer's network-loss warning (15 s) and end (20 s) | 0.5 s | Each due entry is claimed and removed in one script, so one worker runs it; they outlive the worker that set them |

## Inbound call

1. **Offer.** A WhatsApp `connect` webhook (`WhatsAppWebhookTranslator`) or a SIP INVITE
   (`SipIngress`) reaches `ChannelIngress.inboundCall`, which claims ownership.
2. **Pre-checks.** A tombstone means the end came first: record a missed call. An active call
   from the same customer is a duplicate: record CANCELLED. Otherwise run `CustomerLookup`.
3. **Route.** `QueueRouter.selectIvrFlow` runs first. Callio writes the `calls` row and the
   CUSTOMER `call_connections` row (the customer's offer) and publishes `call.created`. With no
   IVR, `claimForNewCall` claims an agent for the new row and assigns it in one transaction:
   ROUND_ROBIN or PRIORITY only, and never ahead of older waiting calls.
4. **IVR branch.** `mediaLegs.answerCustomer(sdpProfile)` → `channel.accept` →
   `markIvrAutoAccepted`. Supervisors get `call:incoming:supervisor`. The IVR session starts and
   plays once the caller's audio arrives ([IVR](#ivr)).
5. **Queue branch.** This worker subscribes to the call's events and `mediaLegs.offerAgent`
   creates the agent leg.
   `call:incoming` and a push go to the claimed agent, or to every available member (RING_ALL).
   If nobody can take it yet, Callio emits `call:waiting` and calls
   `assignOldestUnassignedCall`.
6. **Accept.** `call:accept` (with the agent's SDP answer) passes `CallAccess`, and the socket
   worker publishes `AGENT_JOINED`. On the owner, `AgentEventHandler.handleAgentJoined`:
   1. Checks queue capacity and that the agent has no other call.
   2. Claims the call (`assignCallToAgentIfEligible` + `holdForOwnCall`; `claimHandover` for a
      transfer).
   3. Applies the agent's answer (`mediaLegs.agentAccepted`), which waits up to 5 s for the
      agent's audio to reach rtpengine; the accept is aborted if none arrives.
   4. Answers the customer if nobody has yet: `mediaLegs.answerCustomer(sdpProfile)` →
      `channel.accept`.
   5. Moves the call from RINGING to IN_PROGRESS (guarded) and sets `answered_at`.
   6. **Bridges** it: `callMedia.bridge` puts the customer and the agent in the room and starts
      the recording ([Media](#media)). It then logs, resets the missed streak, emits
      `call:handled` (and `call:offer_taken` for RING_ALL), and sends the resolved push.

## Outbound call

1. **Intent.** `POST /v1/tenants/{t}/calls`: the consumer owns consent. `createOutboundIntent`
   writes an INITIATED row bound to one agent. `CallCleanupService` cancels intents not started
   within 2 minutes.
2. **Start.** The agent sends `call:start` (call id + SDP offer). On the socket's worker,
   `InitiationEventHandler.handleCallStart` checks ownership and state, subscribes, and answers
   the agent's offer (`mediaLegs.answerAgent`). The call holds the agent (`holdForOwnCall`,
   whatever their shift), and it returns the answer.
3. **Dial.** The socket handler publishes `CALL_INITIATE`. `triggerCustomerConnection` runs
   `mediaLegs.offerCustomer(sdpProfile)` → `channel.initiate` and stores the provider call id. A
   failed dial ends the call FAILED through `CallTerminator`.
4. **Answer.** The WhatsApp `connect` webhook or the SIP 200 OK reaches
   `ChannelIngress.outboundAnswered`, which publishes `CUSTOMER_ANSWER_RECEIVED`.
   `CustomerEventHandler` applies it (`mediaLegs.customerAnswered`) and bridges the room. RINGING,
   ACCEPTED, REJECTED and FAILED arrive through `statusChanged`.
5. When the call ends, the agent is released and back to their shift, which the call never
   changed.

## Transfer

`call:transfer` (authorized by `CallAccess.canTransfer`) targets an agent or a queue. A
supervisor assigning an unassigned call takes the same path. On the owner,
`TransferEventHandler.handleCallTransferred`:

1. **Target.** Resolves the target and claims it for the call (on shift, not busy). A queue target picks one
   member by strategy. RING_ALL picks round-robin here, because a transfer goes to one agent.
2. **Move.** Moves the call guarded (`updateCallAgentIfCurrent` /
   `assignCallToAgentIfUnassigned`) and updates the queue. On a live call it sets `offered_at`
   (`markHandoverOffered`) and releases the old agent.
3. **Agent leg.** The old agent's leg leaves the room (the customer hears the reconnect tone)
   and a new agent leg is offered. The customer stays in the room.
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
3. **Release the agent.** The call releases the agent (`releaseAgent`, only if this call holds
   them) and the queues drain. `agentAfter: 'offline'` (they never reconnected) also ends their
   shift.
4. **Provider.** `terminate`, or `reject` for an unanswered inbound call.
5. **Media.** Closes this worker's legs of the call and publishes `CALL_TERMINATED`, so the
   owning worker closes its legs too.
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
  short disconnect). The claims themselves are guarded SQL (`claimAgentAndAssignCall`,
  `claimAgentForCall`).
- **Availability and busy** are two facts on the agent row: the shift (`availability`,
  `AVAILABLE` / `OFFLINE`, set by the agent, the API or auto-offline; only queues read it) and
  the call holding them (`busy_call_id`). A claim sets `busy_call_id` only while it is NULL, so
  two routes can't claim one agent; only that call releases it. Agents report `ON_CALL` while
  held, else their shift. The cleanup loop releases agents still held by an ended call.
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

No audio passes through Callio: rtpengine terminates every external leg and FreeSWITCH mixes
each call in a room. Callio commands both (`src/media/rooms/`, behind the media port). The target
design and what comes next are in [media-architecture.md](media-architecture.md).

**Legs.** Each participant — the customer, an agent, a supervisor — is a FreeSWITCH endpoint
behind its own rtpengine leg (`RtpLegs.js`): the external side (WebRTC for agents and WhatsApp,
plain RTP for a carrier, from the channel's `sdpProfile.transport`) on rtpengine's `external`
interface, plain RTP to the endpoint on its `internal` one. Endpoints are created through
drachtio with drachtio-fsmrf (`FreeSwitch.js`); FreeSWITCH connects back to the creating worker,
which receives that endpoint's events (DTMF, playback ends).

- **Someone else offers** (the customer inbound, a supervisor, an agent reconnecting or starting
  an outbound call): rtpengine turns their offer into plain RTP, FreeSWITCH answers, rtpengine
  turns the answer back.
- **Callio offers** (a ringing agent, the customer outbound): FreeSWITCH offers, rtpengine turns
  it into the external side's offer, and their answer is applied to the endpoint.
- **ICE.** rtpengine's SDP carries its candidates, so Callio trickles none. Clients may trickle
  theirs; rtpengine learns a client's address from the client's own checks, so they aren't
  needed.

**The room** (`RoomMedia.js`). A call is the conference `callio-<boot>-<callId>` (profile
`callio`: 16 kHz mixing, no energy gate). `bridge()` puts the customer and the active agents in
it once both are up. Every operation on a call runs one at a time, and who hears whom is applied
as conference rules after each change:

| | Rule |
|---|---|
| listen | the supervisor is muted |
| whisper | the supervisor is unmuted; `relate supervisor customer nospeak` |
| barge | the supervisor is unmuted, no relation |
| agent-private (whisper only) | `relate agent customer nospeak` |

A supervisor hears the room mixed on one audio line; extra lines in their offer are answered as
rejected (`sdpLines.js`). One supervisor per call for now.

**Customer audio outside the room.** Before the customer is bridged they hear only what is
played to their endpoint: IVR prompts (`player()`) and hold music (`startHold`, the queue's hold
audio or the node's busy audio, looped; the built-in tone with none). Files are fetched by the
media server from Callio — `GET /media/audio/<signed token>/<name>` (`MediaAudio.js`), local or
object storage. With no agent left in the room (a transfer, a drop) the customer hears the
reconnect tone (600 → 750 → 900 Hz, then 1.2 s of silence) until one joins.

**DTMF.** Detection is on from the customer's endpoint creation — in-band and RFC 4733. Digits
reach the core as `call:dtmf` only while an IVR menu listens (`listenForDigits`); a long press
reported twice within 600 ms counts once.

**The agent's audio.** Accepting waits until the agent's audio reaches rtpengine (up to 5 s), so
the provider is told "accepted" only with a working uplink. An agent's socket dropping
(`AGENT_DISCONNECTED`) drops their leg; a reconnect brings a new one. `ConnectionEventHandler`
ends the call if the agent isn't back within 120 s.

**The customer leg** (`CustomerLegMonitor.js`) is polled from rtpengine every second. Fewer than
4 packets in 3 s is a drop, 3 in a second is audio again (RTP and multiplexed RTCP are counted
together; Opus in silence still sends packets). Each change emits `customer:media:state`, and
`CustomerNetworkLossPolicy` ends the call as CUSTOMER_NETWORK_LOSS at 20 s. Every 4 s the latest
RTCP-derived report (jitter, loss) becomes `call:network:quality:customer`.

**Recording** (`RoomRecorder.js`). Per channel (`channels.recording_enabled`) within the
tenant's quota. When the room is first bridged the customer's endpoint records in stereo: left
what the customer says, right what they hear. When the call ends the media server encodes it to
Ogg Opus and PUTs it to a presigned object-storage URL (`callio-recording-upload` in the
FreeSWITCH image, run with `bg_system`); Callio checks the object landed and completes the row.

**Orphans.** A worker that dies leaves its endpoints up on FreeSWITCH, still streaming into
rtpengine ports that get reused. Every leg is tagged `callio.<boot>.<callId>`; each worker
registers its boot id in Redis while it runs, and the sweep hangs up endpoints and deletes
rtpengine legs of boots that are gone, and this worker's own legs of calls it no longer holds.

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
- **`IvrCoordinator`** is started by `ChannelIngress` once the system answered the call, and
  owns the sessions. It waits (up to 5 s) for the caller's audio, plays prompts to the caller
  through `callMedia.player`, and has key presses counted only on menu nodes
  (`callMedia.listenForDigits`).
- **`IvrTransferHandler`** runs on `transferred`:
  1. Checks whether the target agent or queue is available.
  2. Applies the node's offline or busy action: hang up, replay, queue, or wait with busy audio.
  3. Resets `ringing_at`, calls `enterQueue` (starts `queued_at`) and pre-creates the agent
     leg's offer on the owning worker.
  4. Starts hold music (`callMedia.startHold`) and calls
     `AgentAssignmentCoordinator.assignTransferredCall`.
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
3. **`initOptionalServices()`.** Object storage, under `Promise.allSettled`. A failure only
   disables recording.
4. **Routes.** `registerChannels()`, then health, `/metrics`, `/v1` and each channel's routes.
5. **`createWebSocketServer()`.** The Redis adapter, `authMiddleware`, the `EventBus` relays and
   the connection handler. Then runtime gauges and admission control.
6. **`startCoreServices()`.**
   - Registers `consumerEventPublisher` and `ivrTerminationHandler`.
   - Clears this worker's stale presence.
   - Starts `redisCleanupService`, `callCleanupService`, `queueTimeoutService` and
     `outboxDispatcher`.
   - Connects to drachtio, registers the media implementation and starts it: FreeSWITCH, the
     boot heartbeat, the orphan sweep. A media server that isn't up doesn't stop the worker.
   - Runs each channel's `start()`. SIP takes INVITEs from here on.
7. **Listen.** Signal handlers (SIGINT/SIGTERM, and an IPC `shutdown` message — how PM2 stops
   a process on Windows), worker stats, then `listen`.

**Shutdown** (`src/server/shutdown.js`) runs in strict order. It has a double-run guard, and
`isShuttingDown` makes the WhatsApp webhook answer 503. A hard exit is armed first: the worker
exits after 60 s even if a step hangs. PM2's `WORKER_KILL_TIMEOUT` (default 65 s) is above it.

0. Stop `callCleanupService` (its sweep would race the media closing below).
1. Close Socket.IO and wait 800 ms. A socket closed this way (`server shutting down`) doesn't
   drop its agent's leg: the agent didn't leave, their client reconnects to another worker.
2–3. **Hand the calls over instead of ending them** (a deploy doesn't drop calls):
   `callMedia.handOver()` lets go of every room without a BYE, `ivrCoordinator.suspendAll()`
   stops the engines but keeps their sessions and saved positions, and `callInbox.handOver()`
   gives up the leases at once, so another worker adopts each call within ~2 s
   (`core/calls/CallAdoption`) — or the workers that start next, when they all restart. The
   media never stops and the provider isn't told anything.
4. Stop worker stats.
5. Wait up to 45 s for recording uploads, then disconnect from the media server.
6. Stop `redisCleanupService`, `queueTimeoutService`, `outboxDispatcher`, each channel's
   `stop()` and drachtio. SIP's `stop()` keeps answered legs for the adopting worker (their
   dialog ids are in Redis) and ends only legs still ringing, whose pending INVITE can't move.
7. Release the cleanup lock, give up the calls' leases (`callInbox.close`) and close the adapter clients.
8. Close the Redis clients.
9. Close storage.
10. Close the MySQL pool.

Then `server.close()` and exit.

## Known gaps

None tracked here. The open items on a real SIP trunk are in [sip.md](sip.md#open-items-on-a-real-trunk).
