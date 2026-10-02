# Direct lines and the direct media path (plan)

**Status: plan, not started.** Starts after step 5 of
[media-architecture.md](media-architecture.md) (failover-able call ownership) is merged. Update
this doc as steps land; the contract changes go into the API, event and protocol docs in the same
change.

## Why

Callio was built as a contact center: a call reaches a business and goes to whichever agent is
free. Some consumers need **personal phone lines** instead: each of their users owns a DID,
receives calls on it in their app and places calls from it. The two known ones each bring a
carrier trunk and a DID per user.

Most of what they need already exists and is proven: carrier trunks, DID → channel resolution,
WebRTC to the app, rtpengine between WebRTC and plain RTP, VoIP push with the consumer's own
credentials, outbound with the DID as caller ID, call records, events, retention. What doesn't fit
is routing and presence, and the media is heavier than a plain 1:1 call needs. A personal line
today takes a tenant, a one-member queue and a channel per user, and:

- the user goes `OFFLINE` after every outbound call (`CallTerminator`,
  `AgentAssignmentCoordinator`), so inbound calls stop reaching them;
- auto-offline takes them offline after missed calls;
- a call to a busy user waits in a queue instead of getting busy (`486`);
- every call holds a FreeSWITCH room: two rtpengine legs, two FreeSWITCH endpoints and a
  conference, for audio that only needs relaying.

## Requirements

- **One engine, both models, chosen by data.** No consumer names, no `if consumer`. A consumer
  can mix both: a support queue and personal lines for its staff.
- **The contact-center path doesn't change.** Queue lines, rooms and every existing suite stay as
  they are.
- **The agent contract stays.** Agents still get `call:incoming` with an `sdpOffer` and answer it,
  or offer in `call:start`. The SDK doesn't need to know which media path a call uses.
- **A personal call is as reliable as a room call**: failover (step 5) covers both paths.

## Part A: line targets and presence modes (control plane)

### Model

| Setting | Values | Default |
|---|---|---|
| `channels.inbound_target` | `QUEUE`: today's behaviour. `AGENT`: ring `channels.inbound_agent_id` on all their devices | `QUEUE` |
| `channels.busy_policy` (`AGENT` lines) | `REJECT`: busy → the provider's busy (SIP `486`). `WAIT`: wait for the agent like a 1-slot queue, up to `max_wait` | `REJECT` |
| `channels.ring_timeout_seconds` (`AGENT` lines) | unanswered → `NO_ANSWER` | 30 |
| `agents.presence_mode` (tenant default in `settings.presence_mode`) | `SHIFT`: today. `ALWAYS`: reachable unless on a call; no `OFFLINE` after outbound; auto-offline doesn't apply | `SHIFT` |

An IVR flow on an `AGENT` line still takes the call first, as on a queue line, and its transfer
targets work as today.

### Work

1. Migration: the channel and agent columns above. API validation (`http/v1`), and
   `docs/management-api.md` and `docs/data-model.md`. Agent lines are created with
   `PUT /v1/tenants/{t}/channels/{ref}` `{ "inbound_target": "AGENT", "inbound_agent_ref": … }`.
2. `ChannelIngress.inboundCall`: for an `AGENT` line, claim that agent with the guarded
   `claimAgentAndAssignCall` (assignment `DIRECT`, which the protocol already has). If the claim
   fails, apply `busy_policy`: reject through `customerChannels` or wait. `QueueRouter` stays the
   only interpreter of `queues.strategy`; the line target is decided before it.
3. Timers: an agent line's ring timeout in `QueueTimeoutService` (a `Deadlines` timer, so it
   survives the owner's death) ends the call `NO_ANSWER`.
4. Presence: `CallTerminator` / `AgentAssignmentCoordinator` release an `ALWAYS` agent to
   `AVAILABLE` after outbound calls too; `AutoOfflinePolicy` skips `ALWAYS` agents (it still
   counts misses for reports).
5. Events: missed calls on agent lines are already `call.ended` with `NO_ANSWER` / `REJECTED`;
   make sure the payload names the line and the agent, so a consumer can show "missed call"
   without a lookup. Document in `docs/events.md`.
6. Per-trunk number normalisation: `sip_trunks.number_rules` (country code to prefix, digits to
   strip) applied in `sipAddress.dialledNumber` / `callerOf`, so carriers that send national
   format resolve to the stored E.164 DID. `npm run sip:trunk -- … --country 961 --strip 0`.
7. e2e suite `lines`:
   - an inbound call on an agent line rings that agent's devices and connects;
   - busy + `REJECT` → the carrier gets `486`; busy + `WAIT` → it connects once the agent is free;
   - no answer → `NO_ANSWER`, and the `call.ended` event names the line and the agent;
   - an `ALWAYS` agent places an outbound call, then receives an inbound one;
   - missed calls don't take an `ALWAYS` agent offline;
   - a carrier sending the DID in national format reaches the line.

Part A needs no media changes and unblocks personal lines on the room path.

## Part B: the direct media path

### Idea

A plain 1:1 call (customer + one agent, no recording, no IVR, no supervisor) doesn't need a
room. rtpengine alone can bridge the two legs: the customer's SDP is offered through rtpengine to
the agent, translated between plain RTP and WebRTC (ICE, DTLS-SRTP), and the agent's answer goes
back through it to the provider. That's one rtpengine session per call and no FreeSWITCH.

- **SIP:** browsers support PCMU/PCMA, so the agent leg can use the carrier's G.711 and
  rtpengine only re-encrypts, without transcoding.
- **WhatsApp:** Opus on both sides, so it's just relayed.

### Which path a call takes

`channels.media_mode`: `ROOM` (today), `DIRECT`, `AUTO`. `AUTO` picks `DIRECT` when the line has
no IVR flow and recording is off. It's stored on the call (`calls.media_mode`) when the call is
created, and never changes during the call in v1.

On a `DIRECT` call, actions that need a room are refused with a new `CallErrorCodes` code
(`MEDIA_FEATURE_UNAVAILABLE`), documented in agent-protocol.md: monitoring, whisper/barge,
transfer, hold music. Part C lifts that.

### Behind the port

The core keeps talking to `callMedia`. `src/media/` gets a second implementation, and a
dispatcher picks it by the call's `media_mode`:

| Port operation | `DIRECT` implementation |
|---|---|
| `offerAgent(call)` | rtpengine `offer` of the customer's stored SDP, flags for WebRTC → the agent's `sdpOffer`. Several devices ring with the same offer, and only the accepting one is answered. |
| `agentAccepted(call, agentId, sdpAnswer)` | rtpengine `answer`; waits for the agent's audio (packet counters) |
| `answerCustomer(call, sdpOffer, profile)` | returns the answer rtpengine produced for the provider side once the agent answered. The core already calls it after the accept (`AgentEventHandler`). |
| `answerAgent` / `offerCustomer` / `customerAnswered` (outbound, reconnect) | the agent's offer → rtpengine `offer` towards the provider (G.711 for carriers) → the provider's answer → rtpengine `answer` back to the agent. A reconnect is a re-offer with ICE restart. |
| `bridge` | nothing: the legs are already joined |
| `dropAgent` | grace period without a tone (nothing plays on a direct call), then the existing 120 s limit |
| `customerAudio`, quality, drop detection | `CustomerLegMonitor` already reads rtpengine's counters; unchanged |
| `adopt` / `handOver` | the rtpengine call id and tags, plus the dialogs, in the call's Redis snapshot (as `RoomSnapshot`). Simpler than a room: no FreeSWITCH endpoints to rebind. |
| `player`, `listenForDigits`, `startHold`, supervisors | refused (`MEDIA_FEATURE_UNAVAILABLE`) |

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
   concurrent calls, to know what the direct path actually buys.

### Work after the spike

1. `calls.media_mode`, `channels.media_mode` (migration, API, docs).
2. `src/media/direct/` implementing the port; the dispatcher in `src/media/index` (or wherever
   the room implementation is registered at startup).
3. Adoption and hand-over for direct calls, added to `cluster.test.mjs` and `deploy.test.mjs`.
4. e2e: `lines` runs inbound and outbound SIP and WhatsApp in both media modes, with audio
   checked both ways. Room-only actions on a direct call return `MEDIA_FEATURE_UNAVAILABLE`.
5. `docs/architecture.md → Media`, `media-architecture.md` (planes, failure behaviour).

## Part C (later, only when needed)

- **Upgrade a direct call to a room mid-call**, for transfer, monitoring or on-demand recording:
  re-anchor both rtpengine legs onto new FreeSWITCH endpoints with a re-offer. This removes the
  `MEDIA_FEATURE_UNAVAILABLE` cases.
- **Personal-line features:** voicemail (a room with a recorder when the line is busy or
  unanswered), call forwarding, do-not-disturb, call waiting, and calls between two users of the
  same consumer without going out to the carrier.

## Order

1. Part A (control plane), merged green. Personal lines then work on the room path.
2. The Part B spike, then its work, merged green with both media modes in the suite.
3. Part C items as consumers ask for them.

Media placement across nodes (media-architecture.md) continues alongside; the direct path makes
each node carry more calls but doesn't replace it.
