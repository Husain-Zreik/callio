# Media architecture (target)

**Status: steps 1–4 done (branch `media-plane`).** Calls' media runs on rtpengine +
FreeSWITCH rooms behind the media port; how it works today is in
[architecture.md → Media](architecture.md#media). This doc is the target and the order of
work; update it as steps land.

## Why

Before this work a call's audio was decoded, processed and re-encoded in Node, on the same event
loop as the API, the agent sockets and routing:

- `AudioBridge` relays AGENT ⇄ CUSTOMER by handing one peer's received track to the other, so
  libwebrtc runs two jitter buffers, two decoders and two Opus encoders per call, even Opus ⇄
  Opus.
- Recording, the customer silence watchdog, DTMF, whisper/barge mixing, playback and the
  placeholder tones move 10 ms PCM frames through JS: about 300 callbacks a second for a
  recorded call, more with a supervisor.
- An API burst or a GC pause adds jitter to every call on the worker, and a native wrtc crash or
  a memory-limit restart drops them all.
- `MAX_CALLS_PER_WORKER` defaults to 10. Inbound placement is whichever worker wins the claim,
  not the least loaded one.
- Media capacity can't grow without growing the API, and the other way round.

## Requirements

- **No feature is lost.** Everything in [Feature parity](#feature-parity) keeps working, and the
  e2e suite proves it. With no live users there is one implementation, not a fallback: the suite
  is the gate.
- **Calls are rooms.** A call will be shared by several agents and supervisors, not one agent
  plus one monitor. The media port and the data model are participant-first from the start.
- **The external contract stays.** The agent protocol (agents still exchange SDP with Callio over
  the socket), the Management API, consumer events, channel adapters behind `customerChannels`,
  queues and routing, the outbox. Recordings stay stereo OGG/Opus.

## Planes

| Plane | Components | Scales by |
|---|---|---|
| Control | Callio: routing, call state, Management API, agent sockets, events | Stateless workers |
| SIP signalling | drachtio servers, with DNS SRV or a SIP load balancer in front | Nodes |
| Media edge | rtpengine pool: ICE, DTLS-SRTP, NAT, codecs for every external leg (WhatsApp relay, agents, carrier) | Nodes |
| Media processing | FreeSWITCH pool driven through `drachtio-fsmrf`, no dialplan: rooms, mixing, audibility, playback, recording, DTMF | Nodes |
| NAT traversal | coturn for agents behind strict NATs (`IceServers.js`, `TURN_SECRET`) | Nodes |
| State | MySQL (source of truth), Redis (leases, presence, hot cache, call input streams) | Vertical, then replicas |
| Async | Redis Streams for call inputs, the webhook outbox for consumer events | Partitions |
| Storage | S3 for recordings and audio assets | Managed |

**No Node process touches audio.** Sockets carry only control messages and SDP.

FreeSWITCH was rejected in [sip.md](sip.md#why-drachtio--rtpengine) because call logic would
split between its dialplan and Callio. With `drachtio-fsmrf` there is no dialplan: FreeSWITCH is
a media resource that Node commands (create an endpoint from this SDP, join it to a room, change
who hears it). All call logic stays in Callio.

## Call ownership and inputs

- **One owner per live call**, holding a Redis lease (`CallOwnershipService`, as today). The owner
  processes the call's inputs one at a time and commands media through the port. It holds no
  media state.
- **Inputs go through a Redis Stream per call**, keyed by call id: socket actions, API calls,
  channel events, media events. Pub/sub (`publishCallEvent` today) is at-most-once, so a
  restarting owner would miss events. A stream lets the next owner read what it hasn't
  processed.
- **Failover.** When an owner's worker dies, another worker takes the lease, rebuilds the call
  from MySQL and continues from the stream. The room keeps running on its FreeSWITCH node, so
  the call survives a control-worker crash. Agents' sockets reconnect to any worker; the SDK
  already resyncs on reconnect.
- **Cross-call races stay guarded in SQL.** Serialising one call's inputs doesn't serialise two
  calls claiming the same agent, queue draining or overflow. `claimAgentAndAssignCall`,
  `markOnCall`, `withdrawOffer` and the other guarded `UPDATE … WHERE <expected state>` stay.
- No actor framework: the lease, the stream and rebuild-from-DB are enough.

**What survives a control worker's death (spike, 2026-10-02, local media plane):**

- A FreeSWITCH endpoint created through drachtio-fsmrf **survives** its worker being killed:
  the channel and its conference membership stay (the fsmrf event socket closing doesn't hang
  it up). Today the orphan sweep is what kills it, once the worker's boot key expires.
- Another worker can drive the dead worker's SIP dialogs by drachtio's dialog id
  (`stackDialogId`, through the agent's in-dialog request path): a **re-INVITE** (what
  `ep.modify` does) and a **BYE** both get `200 OK`. Conference commands work by name and
  channel uuid from any event-socket connection.
- In-dialog requests **from the far end** (a carrier's BYE, FreeSWITCH hanging up) go only to
  the drachtio connection that owned the dialog; after its death no worker sees them. A new
  owner learns of a SIP customer's hang-up from the media (rtpengine stops counting packets) or
  FreeSWITCH channel events, not from the BYE.
- Not adoptable: the fsmrf `Endpoint` objects (DTMF listener, `ep.join`/`ep.play`), the
  carrier dialog's srf object. Their replacements: keypad digits from FreeSWITCH events
  filtered by channel uuid, `conference`/`uuid_*` commands, in-dialog requests by dialog id.

## Media port

The core's only way to touch media. Room-shaped:

| Operation | Does |
|---|---|
| `createRoom(node)` | A room on a chosen media node |
| `addParticipant(roomId, sdp, role)` → `answer` | Anchors the leg on rtpengine, joins it to the room |
| `removeParticipant(roomId, participantId)` | Leaves the room, releases the leg |
| `setAudibility(roomId, matrix)` | Who hears whom (FreeSWITCH `relate`, mute, deaf) |
| `play(target, asset)` | A file to one participant or the whole room; `stop` ends it |
| `record(roomId, layout)` | Stereo: customer on one channel, the room mix on the other |
| `collectDtmf(participantId)` | RFC 4733 and in-band digits, as media events |
| `stats(participantId)` | Per-leg RTCP (loss, jitter) from rtpengine |

The features are data on top of it:

| Feature | In the port |
|---|---|
| 1:1 call | customer + agent, both hear each other |
| Listen | supervisor joins; nobody hears them |
| Whisper | agents hear the supervisor; the customer doesn't |
| Barge | everyone hears the supervisor |
| Agent-private | the agent is heard by supervisors only |
| Transfer | add the new agent, then remove the old one (warm transfer: both briefly) |
| Hold music, IVR prompts, reconnect tone | `play` |
| Agent drop | the agent participant leaves; the customer gets `play(reconnect tone)` until they rejoin or the 120 s limit |
| Multi-party | more agent and supervisor participants |

## Data model

| Table | Holds |
|---|---|
| `calls` | The call: tenant, channel, direction, status, timestamps, refs, media node |
| `call_participants` | Replaces `call_connections`: role, kind (`CUSTOMER` / `AGENT` / `SUPERVISOR` / `IVR`), media node, `joined_at`, `left_at`, leave reason |
| `call_lifecycle_events` | Grows into the append-only call log the timeline, reports and consumer events derive from |

Queues, agents, channels, trunks and the DID inventory stay separate aggregates.

**Primary agent.** `calls.agent_id` and `CallView`'s agent mean "the" agent today. With several
agents a call keeps a primary agent (who answered, or who holds it after a transfer) for that
field, and the other participants are added to the contract. Documented in
[management-api.md](management-api.md), [events.md](events.md) and
[agent-protocol.md](agent-protocol.md) when multi-party lands.

## Media placement

- An rtpengine + FreeSWITCH **pair** is chosen per call by load (later by region) and stored on
  the call. The pair is placed together, on the same host or LAN, because every call crosses
  both.
- Full nodes refuse new calls; the caller gets a clean busy/unavailable, not a half-set-up call.

## Failure behaviour (v1)

| Fails | Result |
|---|---|
| Control worker | Calls continue; another worker takes the lease and continues from the stream |
| rtpengine node | Its calls drop, unless it runs with Redis-backed sessions **and** a floating IP (keepalived / VIP) for a standby to take over, because remote ends keep sending to the IP in the SDP |
| FreeSWITCH node | Its rooms and calls drop. Re-anchoring legs on rtpengine to a new node is possible later, not in v1 |
| drachtio node | Its SIP dialogs drop; new calls go to the other nodes through SRV / the load balancer |

## Feature parity

Each is covered by `test/e2e`, with audio heard or read back, not just state:

| Feature | Suite |
|---|---|
| WhatsApp and SIP audio, inbound and outbound | `calls`, `sip` |
| Transfer, reconnect, device switch | `calls`, `routing`, `sdk` |
| IVR prompts + in-band DTMF | `routing`, `sip` |
| Listen / whisper / barge / agent-private | `routing` |
| Customer network loss | `routing` |
| Recording content (customer left, agent right) | `media` |
| Hold music after an IVR transfer | `media` |
| Reconnect tone when the agent drops, and recovery | `media` |
| Call-quality events | `media` |

**DTMF:** `sipSdp.js` strips `telephone-event` so carriers send in-band tones. FreeSWITCH detects
both, so that flips to accepting RFC 4733.

## Order of work

1. **e2e checks** for the gaps above (`media.test.mjs`). Done.
2. **Participants data model and the room-shaped port contract**, designed together. Done:
   `call_participants`, `core/media/CallMedia.js`.
3. **rtpengine + FreeSWITCH implementation:** a spike (one WhatsApp and one SIP call), then the
   features until the suite passes. Done: `src/media/rooms/`, the local media plane in
   `deploy/sip-gateway/docker-compose.local.yml`.
4. **Delete the wrtc media code** (`src/media/webrtc|bridge|dtmf|recording|playback`). The test
   harness keeps `wrtc` for its simulated customers and agents. Done: `wrtc` and `@discordjs/opus`
   are dev dependencies now; `ffmpeg-static` and the in-Node recording upload are gone.
5. **Failover-able call ownership**, with call inputs on Redis Streams.
6. **Multi-party calls** and the primary-agent contract.

Steps 2–4 break media until the suite passes again, and the dev server runs `main`, so they
happen on a branch (or worktree) and merge green.

## Answered by the spike and step 3

- **Real calls on the dev server (2026-10-02):** an inbound WhatsApp call (Meta's relay accepts
  rtpengine's SDP, `a=ice-lite` kept) and an inbound SIP call, each answered in a browser agent
  with two-way audio.

- **Ogg Opus:** the image's `mod_opusfile` is read-only. Recordings are stereo WAV on the media
  server, encoded with `opusenc` and uploaded by presigned PUT from there
  (`callio-recording-upload`).
- **`relate`** covers whisper, barge and agent-private as the e2e checks expect.
- **Supervisors** hear the room mixed on one audio line (a contract change, in
  agent-protocol.md); a second line in their offer is answered as rejected.
- **Drop detection** is a packet rate from rtpengine (RTP and multiplexed RTCP are counted
  together), not silence.
- **Orphans:** a worker that dies leaves its media-server endpoints up and streaming into
  reused rtpengine ports; legs are tagged with the worker's boot id and swept.
- **Offers to carriers are G.711 only.** A FreeSWITCH endpoint that offered Opus and is
  answered G.711 in the re-INVITE stops sending the room (it echoes the caller). Legs Callio
  offers to a SIP carrier come from a second profile, `drachtio_mrf_g711`, over a second
  connection per worker; agents and WhatsApp keep Opus first.
- **Local Docker:** rtpengine's two logical interfaces share one address, or Docker's published
  ports can deliver a packet to the other interface's socket with the same port number.

## Still open

- **The production media plane** is in `deploy/sip-gateway/docker-compose.yml` (FreeSWITCH
  on host networking, bound to loopback; rtpengine's `external`/`internal` interfaces) and
  `docs/sip.md → Deploying the gateway`; first deployed to the dev server with this merge.
- **Trickled client ICE** is ignored (rtpengine learns the client from its checks); forwarding
  it to rtpengine would help clients behind strict NATs without TURN.
- **Latency** of the two hops (rtpengine → FreeSWITCH → rtpengine) on one host — measure on the
  dev server.
