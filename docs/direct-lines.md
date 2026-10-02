# Personal lines and the direct media path (plan)

**Status: A1–A4 and A6 done (2026-10-02); A5 next.** Step 5 of [media-architecture.md](media-architecture.md)
(failover-able call ownership) is done (2026-10-02), so this can start. Update this doc as steps
land; the contract changes go into the API, event and protocol docs in the same change.

## Why

Callio was built as a contact center: a call reaches a business and goes to whichever agent is
free. Some consumers need **personal phone lines** instead: each of their users owns a DID,
receives calls on it in their app and places calls from it. The two known ones each bring a
carrier trunk and a DID per user.

Most of what they need already exists and is proven: carrier trunks, DID → channel resolution,
WebRTC to the app, rtpengine between WebRTC and plain RTP, VoIP push with the consumer's own
credentials, outbound with the DID as caller ID, call records, events, retention, failover. What
doesn't fit is the contact-center shape of routing, availability and event delivery:

- **One column means two things.** `agents.availability` is both "on shift for queues"
  (`AVAILABLE`/`OFFLINE`) and "on a call" (`ON_CALL`). The workarounds follow from that: an agent
  goes `OFFLINE` after every outbound call (`CallTerminator.settle`), auto-offline takes them
  offline after missed calls, and releasing them is a guess ("no active call left",
  `releaseAgentIfIdle`, `syncAgentAvailability`).
- **No line belongs to anyone.** A channel routes to a queue or, without one, rings every
  available agent of the tenant, any of whom may accept (`QueueRouter.ringAllTargets`,
  `CallAccess.#isOffered`). Any agent may call out from any of the tenant's numbers
  (`InitiationEventHandler.createOutboundIntent`).
- **Every call event goes to the whole tenant.** `call:status`, `call:handled`,
  `call:terminated`, `call:agent_availability`, `call:agent_queue` go to `tenant:{id}`; every
  offer goes to every supervisor; `calls:sync` returns all ongoing calls unpaged. In a product
  tenant every end user's app would receive every other user's calls: a privacy leak, and at
  100k users each event fans out 100k times.
- **Every call holds a FreeSWITCH room**: two rtpengine legs, two FreeSWITCH endpoints and a
  conference, for audio that only needs relaying.

## Decisions (2026-10-02)

- **Scalable from the start**, whatever the number of users or concurrent calls: no tenant-wide
  scan or broadcast on the call path, the direct media path and media placement are part of this
  plan (see [Scale](#scale)).
- **Consumers:** midlr stays a contact center. PCG eSIM and Aravas are personal-line products:
  each end user gets a DID on the product's own carrier trunk and places and receives calls on it
  in the product's app. Their apps are **Flutter**, on the Dart agent SDK (`sdk/agent-dart`).
- **One tenant per product, one agent per end user**, one personal line per DID. "Agent" stays
  the technical term (about 300 uses across the API, protocol, events and both SDKs): an agent is
  any person who answers calls, including a product's end user.
- **Line ownership is per line, not a per-consumer or per-tenant type.** Which DID rings which
  user has to be stored per line anyway, so a tenant "type" would add a flag on top of the same
  data and spread `if tenant is personal` branches through the code. Per line, a tenant can mix
  both (a support queue next to its users' personal lines), and the behaviour follows from one
  fact. What differs per tenant (who sees the board, which monitor modes) is tenant settings.
- **Availability and busy are separate.** Shift status only matters to queues; personal lines
  only ask "is the owner on a call". No presence-mode setting.
- **The media setup is chosen from what a call can need**, not configured per line.
- **The board is a subscription.** Nobody receives other people's calls without subscribing, and
  only roles the tenant allows may.
- **Recording isn't needed now** but may be later; turning it on moves new calls to rooms with no
  rework.
- **User-to-user calls**, call waiting and voicemail wait for Part C.
- **An internal dashboard per product** sees all of the product's calls and **listens** to them
  live — listen only, no whisper or barge. End users never see it. Its users are **supervisors**
  of the product's tenant; end users are agents and only ever get their own calls.
- **Listening to a direct call** needs a copy of its audio, not a mix: rtpengine can fork a
  session's media to a third party (subscribe requests) without FreeSWITCH. The spike checks it
  (Part B item 7); the fallback is Part C's direct → room upgrade.

## What a product integrates

Once, when the product is set up: a consumer, its push credentials, a SIP trunk, and a tenant with
`settings: { "team_view": false, "monitoring": { "modes": ["listen"] } }`; dashboard users are
`SUPERVISOR` agents of that tenant.

At each user's signup, two calls from the product's backend:

```
PUT /v1/tenants/{t}/agents/{userRef}          { name }
PUT /v1/tenants/{t}/channels/{lineRef}        { type: "SIP", address: "+961…", sip_trunk_ref, owner_agent_ref: "{userRef}" }
```

The app signs in with an agent token, registers its push token, and receives and places calls
through the SDK exactly as a contact-center agent does.

## Requirements

- **One engine, both models, chosen by data.** No consumer names, no `if consumer`, no tenant
  "type".
- **The contact-center path keeps working.** Every existing suite stays green; the one visible
  change is listed under A1.
- **The agent contract stays.** Agents still get `call:incoming` with an `sdpOffer` and answer it,
  or offer in `call:start`. The SDK doesn't need to know which media path a call uses.
- **A personal call is as reliable as a room call**: failover (step 5) covers both paths.

## Part A: the control plane

### A1. Availability and busy, separately

| Column | Means | Written by |
|---|---|---|
| `agents.availability` | on shift for queues: `AVAILABLE` / `OFFLINE` | the agent, the API, auto-offline |
| `agents.busy_call_id` (new, nullable, indexed) | the call holding the agent | claims and releases, guarded |

- **Claims** set `busy_call_id` with `WHERE busy_call_id IS NULL` (plus `availability =
  'AVAILABLE'` for queue claims) in the same guarded transaction as today's
  `claimAgentAndAssignCall`; `markOnCall` and `call:start` likewise. The row is the lock that
  serialises two routes claiming one agent, as `ON_CALL` is today. `call:start`'s busy check
  becomes the claim itself, so two simultaneous outbound starts can't both pass.
- **Releases** are exact: `UPDATE agents SET busy_call_id = NULL WHERE id = ? AND busy_call_id =
  <this call>`, replacing `releaseAgentIfIdle` / `releaseAgentOfflineIfIdle`. Cleanup clears a
  `busy_call_id` whose call has ended (guarded the same way), replacing
  `syncAgentAvailability`'s stuck-`ON_CALL` repair.
- **Removed:** `OFFLINE` after outbound calls and after a failed accept (`CallTerminator.settle`,
  `AgentEventHandler`). An outbound call never touches availability, so the agent is back to
  whatever they were. **This is the one contact-center behaviour that changes**: an agent who was
  `AVAILABLE` and places a call is `AVAILABLE` again afterwards, not `OFFLINE`. Document in
  agent-protocol.md.
- `setAvailability` no longer refuses during a call: going `OFFLINE` mid-call takes the agent out
  of queues for the next call.
- **The contract keeps `ON_CALL`**: the reported status is `ON_CALL` while `busy_call_id` is set,
  else `availability`, in the API, `call:agent_availability` and `agent.availability.changed`.
  The `ON_CALL` value leaves the column's enum in a later migration once nothing writes it.
- Migration: add the column, backfill from active calls, turn `ON_CALL` rows into `AVAILABLE`
  with `busy_call_id` set.

### A2. Line ownership and the inbound router

- `channels.owner_agent_id` (nullable, FK agents, indexed). Empty: a **shared line** (queue /
  IVR, today's behaviour). Set: a **personal line** of that agent. A line has an owner or an
  `inbound_queue_id`, never both (API validation). Personal-line settings:
  `channels.ring_timeout_seconds` (default 30, at most 60: the stuck-call cleanup ends any call
  still ringing after a minute). The API takes `owner_agent_ref`.
- `core/routing/InboundRouter` decides a new call's first destination, so `ChannelIngress` stops
  mixing routing into intake: **owner**, **IVR**, **queue**, or **no route**. `QueueRouter` stays
  the only interpreter of `queues.strategy`.
- **Personal line:** claim the owner (`busy_call_id IS NULL`, ignoring `availability`), set
  `calls.agent_id`, offer `DIRECT` to all their sockets and devices (push).
  - Busy → the call is rejected as busy: `customerChannels.reject(call, { reason: 'busy' })`;
    SIP answers `486` (today's `reject` sends `480`), WhatsApp rejects. Ends `REJECTED`.
  - The owner has no connected socket and no push token → `NO_ANSWER` at once, no ringing.
  - Decline → `REJECTED` (as today for a call without a queue).
  - Ring timeout → a `Deadlines` entry (`infra/cluster/Deadlines.js`), so it survives the
    owner's worker; ends `NO_ANSWER` and releases the owner.
  - No IVR on personal lines in v1 (voicemail is Part C).
- **Shared line without an active queue and without IVR → no route**: rejected, `warn` logged.
  The "ring every agent of the tenant" fallback is removed, and `CallAccess` lets only the
  offered or assigned agent act on a call without a queue.
- IVR triggers count a queue's members; without a queue there are no agents to count (only
  `ALWAYS` and `ALL_AGENTS_UNAVAILABLE` hold), instead of loading every agent of the tenant.
- **Outbound:** from a personal line only its owner may call (`403 line_not_owned` on
  `POST /v1/tenants/{t}/calls`); shared lines as today.
- Auto-offline only changes `availability`, so it only affects queues, and only counts misses on
  queue offers.

### A3. Events by audience, the board as a subscription

- **A call's own events** (`call:status`, `call:handled`, `call:terminated`, …) go to the call
  room: the agents offered or on the call, and its monitors.
- **The board** (every call of the tenant, team availability, queue snapshots, offers for
  supervisors) goes only to **board subscribers**, through Socket.IO rooms:
  `board:{tenant}` (everything), `board:{tenant}:channel:{id}`, `board:{tenant}:agent:{id}`,
  `board:{tenant}:queue:{id}`. An event is emitted to the rooms it belongs to in one
  `io.to([...])`, so a socket in several gets it once, across workers via the Redis adapter.
- **Who may subscribe:** supervisors always; agents when the tenant's `settings.team_view` is
  true (default `true`, so contact centers keep today's team view). Personal-line products set it
  to `false`.
- **Default subscription:** on connect the server subscribes a socket that may see the board to
  the whole tenant, so today's clients (midlr's app listens to `call:status`,
  `call:agent_queue`, `call:agent_availability` without subscribing) keep working. A client
  narrows or pages with `board:subscribe { channels?, agents?, queues? }` and
  `board:calls { filter, cursor, limit }` (replacing the unpaged `calls:sync` board part).
  Aggregated counters (`board:counters`: calls by state, agents by status) are pushed, throttled,
  instead of the dashboard rebuilding them from every event.
- Queue snapshots on connect/disconnect/availability only for the queues the agent is in.
- agent-protocol.md and the JS/Dart SDKs: subscribe, page, counters.

### A4. Monitoring modes per tenant

`settings.monitoring.modes` (default `["listen","whisper","barge"]`), enforced in
`MonitorEventHandler` when monitoring starts and when the mode changes; a refused mode is a
`call:error` with a new code, documented in agent-protocol.md.

### A5. Per-trunk number normalisation

`sip_trunks.number_rules` (country code, digits to strip) applied in `sipAddress.dialledNumber` /
`callerOf`, so carriers that send national format resolve to the stored E.164 DID.
`npm run sip:trunk -- … --country 961 --strip 0`.

### A6. Events for missed calls

Missed calls on personal lines are `call.ended` with `NO_ANSWER` / `REJECTED` (busy or declined,
told apart by a reason); the payload names the line and the agent, so a product can show "missed
call" without a lookup. Document in events.md.

### A7. Tests

New suite `lines`:

- an inbound call on a personal line rings all of the owner's devices and connects;
- the owner busy → the carrier gets `486`, the call ends `REJECTED`/busy, the event says so;
- no answer → `NO_ANSWER` after the ring timeout, also when the owning worker dies mid-ring;
- the owner offline in the shift sense still receives calls on their line;
- the owner places an outbound call, then receives an inbound one; another agent can't call out
  from the line;
- missed calls don't change the owner's availability;
- a tenant with `team_view: false`: an agent never receives another agent's call events; a
  supervisor does, filtered by line, with counters;
- a listen-only tenant's supervisor listens, whisper/barge are refused;
- a carrier sending the DID in national format reaches the line;
- a shared line with no queue rejects the call.

The existing suites change where they assert `OFFLINE` after outbound (A1) or rely on a line
without a queue ringing everyone (A2).

Part A needs no media changes: personal lines work on the room path once it's merged.

## Part B: the direct media path

### Idea

A plain 1:1 call (customer + one agent, no recording, no IVR, nothing mixed into it) doesn't need
a room. rtpengine alone can bridge the two legs: the customer's SDP is offered through rtpengine
to the agent, translated between plain RTP and WebRTC (ICE, DTLS-SRTP), and the agent's answer
goes back through it to the provider. That's one rtpengine session per call and no FreeSWITCH.

- **SIP:** browsers support PCMU/PCMA, so the agent leg can use the carrier's G.711 and
  rtpengine only re-encrypts, without transcoding.
- **WhatsApp:** Opus on both sides, so it's just relayed.

### Which path a call takes

Nothing to configure. When a call is created the core works out what it **can** need, from data
that already exists, and passes it to the media port:

| Needs a room | From |
|---|---|
| IVR or hold audio | the line/queue's IVR flow; a queue (waiting, hold music) |
| recording | `channels.recording_enabled` |
| whisper or barge | the tenant's `settings.monitoring.modes` |
| transfer | shared lines (personal lines don't transfer) |

None of them → **direct**; otherwise a **room**. In practice: personal lines of a listen-only
tenant without recording are direct, contact-center calls are rooms. The choice is kept in the
call's Redis state (`CallState`), never changes during a call in v1, and actions that would need a
room can't arise on a direct call by construction (a safety net refuses them with
`MEDIA_FEATURE_UNAVAILABLE`).

### Behind the port

The core keeps talking to `callMedia`. `src/media/` gets a second implementation, and a dispatcher
picks it by the call's topology. Several port methods receive only a `callId` (`player`,
`listenForDigits`, `close`, `dropAgent`, …), so the dispatcher reads the topology from
`CallState` by id:

| Port operation | Direct implementation |
|---|---|
| `offerAgent(call)` | rtpengine `offer` of the customer's stored SDP, flags for WebRTC → the agent's `sdpOffer`. Several devices ring with the same offer, and only the accepting one is answered. |
| `agentAccepted(call, agentId, sdpAnswer)` | rtpengine `answer`; waits for the agent's audio (packet counters) |
| `answerCustomer(call, sdpOffer, profile)` | returns the answer rtpengine produced for the provider side once the agent answered. The core already calls it after the accept (`AgentEventHandler`). |
| `answerAgent` / `offerCustomer` / `customerAnswered` (outbound, reconnect) | the agent's offer → rtpengine `offer` towards the provider (G.711 for carriers) → the provider's answer → rtpengine `answer` back to the agent. A reconnect is a re-offer with ICE restart. |
| `bridge` | nothing: the legs are already joined |
| `dropAgent` | grace period without a tone (nothing plays on a direct call), then the existing 120 s limit |
| `customerAudio`, quality, drop detection | `CustomerLegMonitor` reads rtpengine's counters; a direct session's sides are the customer and the agent, so the monitor is told which tag is the customer's |
| `adopt` / `handOver` | the rtpengine call id and tags, plus the dialogs, in the call's Redis snapshot (as `RoomSnapshot`). Simpler than a room: no FreeSWITCH endpoints to rebind. |
| `addSupervisor` in `listen` | an rtpengine subscription to the call's session: a copy of both directions to the supervisor's WebRTC leg; nothing flows back into the call |

### Spike first (the open questions)

1. A carrier's G.711 offer → rtpengine → a browser that answers PCMU over DTLS-SRTP, two-way
   audio, through the local media plane; then the same on the dev server against the real
   carrier.
2. WhatsApp's offer (Opus, `a=ice-lite` kept per `whatsappSdp`) bridged straight to a browser.
3. One offer to two devices; one answers, the other's ICE never starts; no stray rtpengine
   branch remains.
4. Whether `drachtio/rtpengine:latest` is built with transcoding. Only needed if some agent
   can't do G.711; the plan assumes not.
5. The answer order for inbound SIP: we can only send the `200 OK` after the agent answers. That's
   already true on the room path, and confirms that nothing upstream needs the customer answer
   earlier.
6. Measure, on the dev server: CPU and latency per call for room vs direct, at 50 and 200
   concurrent calls. Needs a load generator (simulated carrier calls and WebRTC agents at volume),
   which doesn't exist yet: part of the spike.
7. Listening to a direct call: an rtpengine subscription (`subscribe request` / `subscribe
   answer`) delivers the customer and the agent to a supervisor's browser. Likely as two audio
   streams, where today's supervisor contract gives one mixed line; if rtpengine can't mix them,
   decide between two lines on direct calls (a contract addition, the SDKs follow) and the
   direct → room upgrade.

### Work after the spike

1. The needs computation in the core, passed to `callMedia` when the call's media starts;
   `calls.media_topology` recorded for reports (migration, docs).
2. `src/media/direct/` implementing the port; the dispatcher where the room implementation is
   registered at startup (`server/bootstrap.js`).
3. Adoption and hand-over for direct calls, added to `cluster.test.mjs` and `deploy.test.mjs`.
4. e2e: `lines` runs inbound and outbound SIP and WhatsApp on the direct path with audio checked
   both ways; turning recording on puts the next call in a room.
5. `docs/architecture.md → Media`, `media-architecture.md` (planes, failure behaviour), and
   CLAUDE.md's "No media in the core" rule (the port is no longer only room-shaped).

## Part C (later, only when needed)

- **Upgrade a direct call to a room mid-call**, for on-demand recording or whisper: re-anchor
  both rtpengine legs onto new FreeSWITCH endpoints with a re-offer.
- **Personal-line features:** call waiting (a busy owner gets the second call instead of `486`),
  voicemail (a room with a recorder when the line is busy or unanswered), call forwarding,
  do-not-disturb, and calls between two users of the same product without going out to the
  carrier.

## Scale

"Scalable from the start" means no single machine, tenant-wide scan or broadcast caps a product:

- **Control plane:** any worker takes any request, and a worker's calls survive its death or a
  deploy (step 5). Workers scale horizontally.
- **Many agents in one tenant** (a product's whole user base): the call path looks agents up by
  id and lines by DID, never by scanning the tenant (A2 removes the ring-everyone fallback and the
  IVR trigger scan); busy is one guarded row update; push goes to the agent's devices only.
- **Events:** a call's events reach its participants; the board reaches only subscribers, in
  rooms narrowed by line, agent or queue, with paging and aggregated counters (A3).
- **Media:** the direct path (Part B) cuts a plain call to one rtpengine session, no FreeSWITCH.
  Media placement (media-architecture.md: rtpengine + FreeSWITCH pairs, one chosen per call by
  load) spreads calls over several media hosts.

## Order

1. **Part A** in the order A1 → A2 → A3 → A4–A6, each merged green. Personal lines then work on
   the room path, and the dashboard can be built against the board subscription.
2. **The Part B spike** (including the load generator), then its work, merged green.
3. **Media placement** across nodes, alongside Part B: the direct path makes each node carry more
   calls but doesn't replace spreading them.
4. **Part C** as products need it; the direct → room upgrade first if the spike shows rtpengine
   subscriptions can't serve the dashboard's listening.
