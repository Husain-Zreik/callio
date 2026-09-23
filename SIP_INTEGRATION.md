# SIP Trunk Integration

Status: **Milestone A in progress** (gateway deployment/validation — see
`deploy/sip-gateway/RUNBOOK.md`). No application code exists yet; this doc
exists so Milestone B doesn't have to re-derive the scope from scratch.

## Goal

Accept calls from a SIP trunk/carrier as a second "customer leg" alongside
the existing WhatsApp Business Calling leg, first slice scoped to **inbound
only — accept a PSTN call, bridge to an agent** (parity with the existing
WhatsApp inbound flow). Outbound-via-SIP is out of scope until this works.

Trunk: IP-authenticated, carrier IP `185.231.78.58`.

## Why this stack: drachtio-server + rtpengine (after considering Janus, FreeSWITCH, and Asterisk)

Node has no SIP/RTP stack — call legs today are exclusively WebRTC, built on
`@roamhq/wrtc`. Something has to speak SIP+RTP to the carrier; the question
that mattered was *where call-control logic lives*.

Four options were considered, in order:
1. **Janus Gateway** — ruled out first. Its SIP plugin is a **1:1 model** (one
   WebRTC client registers as a single SIP identity), not a fit for a
   **shared-DID trunk** with arbitrary concurrent inbound calls needing
   dialplan-style routing.
2. **FreeSWITCH** — a real PBX (dialplan + trunk gateway + WSS/WebRTC profile
   in one product), initially settled on for exactly that reason. Milestone A
   was first built against it (superseded, no longer in this repo).
3. **Asterisk** — considered as an alternative to FreeSWITCH. Its ARI
   (REST+WebSocket call control via a `Stasis()` dialplan app) is arguably a
   *better* fit than FreeSWITCH's lower-level ESL for "an external app takes
   over call control" — but both still split call-routing logic between an
   external dialplan config language and Node's own event handlers.
4. **drachtio-server + rtpengine** — settled on. `drachtio-server` does SIP
   signaling *only* (no dialplan, no media at all) and hands every SIP
   message to a Node app (`drachtio-srf`) as an event; `rtpengine` does RTP
   relay/transcoding (including WebRTC↔plain-RTP), controlled by that same
   Node app over its UDP "ng" protocol. There is no external dialplan
   language — **all call logic lives in Node**, the same way `CallEventHandler`
   already owns all WhatsApp call logic today. This is a materially better
   architectural fit for Callio specifically than any option with a built-in
   dialplan, at the cost of more custom code (no free IVR/routing engine) and
   a smaller community than FreeSWITCH/Asterisk. Real-world precedent for this
   exact pattern for a similar goal: Jambonz (open-source "build your own
   programmable voice platform") is built on drachtio + rtpengine.

## Milestone A — gateway infra (this pass)

Deployment artifacts only, zero changes to `src/`/`config/`, **except** a
standalone validation script under `deploy/sip-gateway/test/` with its own
`package.json` — unlike FreeSWITCH, drachtio-server has no built-in call
handling at all, so even proving the trunk can reach it requires *some* code.
That script is not imported by anything in `src/` and is not Callio
application code. See `deploy/sip-gateway/`:
- `docker-compose.yml` + `.env.example` — drachtio-server + rtpengine
  containers, host networking (SIP/RTP need real IPs in SDP, not Docker
  NAT'd ones)
- `drachtio/drachtio.conf.xml` — SIP listen config + the admin-tcp control
  channel Node connects to
- `rtpengine/rtpengine.conf` — RTP port range + NAT/external-IP config
  (`drachtio/` and `rtpengine/` are equal sibling subfolders — signaling and
  media are separate concerns, kept visually separate even though they
  deploy as one stack)
- `test/call-test.js` + `test/rtpengine-ng-client.js` — the validation app:
  answers a real inbound call via `drachtio-srf`, allocates a media session
  via `rtpengine`'s ng protocol. Explicitly **not** a discardable throwaway —
  if Milestone A's checkpoints pass, this is a working reference for
  Milestone B's real implementation, not code to delete.
- `RUNBOOK.md` — the validation checklist gating Milestone B (real test call
  through the trunk, rtpengine media-session confirmation, and the DB schema
  check — see below)

## Blockers found during scoping (must resolve before/during Milestone B)

1. **Possible DB enum constraint.** `call_connections.connection_type` is
   written as an opaque string everywhere in this repo (see
   `src/repositories/CallConnectionRepository.js`), but the actual MySQL
   column definition lives in the Laravel monorepo — no migrations exist in
   this repo to inspect. If it's a strict `ENUM('FRONTEND','WHATSAPP',
   'MONITOR')`, a new `SIP` value can't be persisted until that's migrated on
   the other side. Check via `SHOW CREATE TABLE call_connections;` against
   the real DB (RUNBOOK.md checkpoint 5). The same question applies to
   `TerminatedBy` if that enum is also DB-backed anywhere (see below).
2. **drachtio-server + rtpengine's behavior against this specific trunk is
   still unverified** — that part needs the real server + real carrier.
   However, the signaling+media logic itself has now been verified locally:
   a raw SIP INVITE placed against the local stack went all the way through
   `rtpengine-ng-client.js`'s `offer` command to a real rtpengine-generated
   SDP answer, `call-test.js` answered it, and BYE tore it down cleanly (see
   `deploy/sip-gateway/RUNBOOK.md`'s updated section 0). One real config bug
   was found and fixed this way (`<admin-tcp address="...">` → `<admin>`).
   What's still unverified: actual RTP audio content, and anything specific
   to the real trunk (auth mode, firewall reachability, its SDP quirks).

## Milestone B scope (not started) — application-code blast radius

Full inventory done via codebase research; condensed here. The key finding:
most of the audio/connection plumbing is **generic "customer leg" logic that
just happens to be spelled WHATSAPP**, not genuinely WhatsApp-specific — the
real Meta-specific surface is much narrower than it first appears.

### Key design insight: a SIP leg is still a real Node-side WebRTC peer connection

There are two ways drachtio+rtpengine could bridge a SIP call: (1) rtpengine
relays raw RTP directly between the trunk and the agent's browser, with media
never touching Node's process at all, or (2) rtpengine transcodes the
trunk's plain RTP into a genuine WebRTC session that **Node itself
terminates** via `@roamhq/wrtc` — exactly like it already does for FRONTEND
and WHATSAPP. Option 2 is the one to build: it means `AudioBridge`,
`AudioCoordinator`, recording, DTMF, and IVR need **zero changes**, because
from their point of view a SIP call is just another `RTCPeerConnection`.

Concretely, the inbound flow becomes: drachtio-srf receives the trunk's
INVITE → `peerRegistry.getOrCreateConnection(callId, ConnectionType.SIP)` (the
exact same method WHATSAPP uses) creates a real Node-side wrtc peer → the SDP
offer for it is created via `sdpCoordinator.createSDPOffer` (same method,
same code) → that offer, plus the trunk's inbound SDP, both go into
`rtpengine`'s `offer` ng-command, which hands back an SDP describing
rtpengine's own media address → `sdpCoordinator.processSDPAnswer` feeds that
into Node's wrtc peer (again, the exact same call WHATSAPP's inbound flow
already makes) → drachtio-srf's `srf.createUAS` answers the trunk with
whatever SDP is needed on that side. `SDPCoordinator`/`PeerRegistry`/`Peer`
are reused verbatim; only the "remote signaling channel" (drachtio-srf +
rtpengine, in place of Meta's Graph API) is new.

One concrete piece of existing code this reveals: `PeerEventManager.js`'s
`handleIceCandidate` currently skips forwarding outbound ICE candidates when
`connectionType === ConnectionType.WHATSAPP`, because Meta's Graph API has no
trickle-ICE channel — the whole SDP is exchanged in one round-trip. rtpengine
works the same way (candidates embedded in the SDP, not trickled), so
`ConnectionType.SIP` needs the same skip. Small, additive, and good evidence
this design fits an existing precedent rather than inventing a new one.

### Generic logic hardcoded to `ConnectionType.WHATSAPP` (needs a small resolver/helper, not a rewrite)

~20+ call sites across:
- `src/services/call/signaling/webrtc/PeerEventManager.js` — `handleIceCandidate`'s
  `connectionType !== ConnectionType.WHATSAPP` skip (see design insight above —
  found only once the "SIP leg = real wrtc peer" model was worked out, not
  part of the original inventory)
- `src/services/call/signaling/webrtc/PeerRegistry.js` — `checkAndStartBridging`,
  the `trackReceived` retry condition, `_scheduleIceStallWarning`,
  `closePeerConnection`'s "customer leg still up" checks
- `src/services/call/audio/AudioCoordinator.js` — `checkAndStartBridging`'s
  `whatsappData` param, `handleTrackReceived`'s FRONTEND/WHATSAPP toggle,
  `handleFrontendDisconnected`'s reconnect-beep relay target
- `src/services/call/audio/AudioBridge.js` — the largest concentration:
  `whatsappConnection`/`whatsappTracks`/`_whatsappMixingRelay` fields,
  `setConnections`, `relayTrack`'s fromType/toType branching (this is also
  where `CustomerSilenceWatchdog`/`CustomerNetworkMonitor` get wired up —
  both already generically named), whisper/barge mute logic,
  `_relayWhatsAppTrackToFrontend`, `_relayExistingTracksToMonitor`
- `src/services/call/audio/AudioBridgeCoordinator.js` — `checkAndStartBridging`
  param naming, `getTracksForRecording`/`getCustomerTrackForDTMF`

None of this touches Meta Graph API semantics — it's wrtc-level track routing
between "the frontend connection" and "the customer connection." Recommended
approach: introduce `ConnectionType.SIP` plus a small helper (e.g.
`CUSTOMER_LEG_TYPES` set / `resolveCustomerConnectionType(callConnections)`)
rather than a full field-rename across `AudioBridge.js` — lower regression
risk on the currently-working WhatsApp path. Full rename can be a later
cleanup once SIP is proven.

### Genuinely WhatsApp/Meta-specific (needs a parallel SIP implementation, not generalization)

- `src/services/call/signaling/webrtc/WhatsAppCallApi.js` — the Graph API
  HTTP client (`initiateWhatsAppCall`/`acceptWhatsAppCall`/
  `rejectWhatsAppCall`/`terminateWhatsAppCall`). A SIP leg's equivalent plays
  the same *role* (the "remote signaling channel" a call's customer leg is
  negotiated through) but isn't shaped like an HTTP client — it's
  `DrachtioClient` (accepting via `srf.createUAS`, rejecting via
  `res.send(486)`, hanging up via `dialog.destroy()`) plus `RtpEngineClient`
  (getting rtpengine to bridge the trunk's RTP into the real Node-side wrtc
  peer connection `PeerRegistry`/`SDPCoordinator` already create — see the
  design insight above). Needs its own modules, not a generalization of this
  file.
- `src/services/call/webhook/CallWebhookProcessor.js` — `process()`'s
  top-level payload parsing is Meta webhook-envelope-specific
  (`metadata.phone_number_id`, `calls[]`, `statuses[]`). Everything
  *downstream* of parsing (`CallRepository.create`, `CallConnectionRepository.create`
  with a parameterized `connection_type`, `sdpCoordinator.createSDPOffer` for
  FRONTEND, the `call:incoming` ring fan-out) is already generic and reusable.
  Recommended approach: extract a shared "create+route inbound call"
  function parameterized by connection type + a normalized payload shape,
  called from two thin adapters — today's Meta-webhook adapter, and a new
  drachtio-srf `invite` handler (see `test/call-test.js` for the reference
  shape: Call-ID/From-tag extraction, rtpengine offer, `srf.createUAS`).
- `src/services/call/events/handlers/WhatsAppEventHandler.js` — reacts
  specifically to `WHATSAPP_ANSWER_RECEIVED`, published after Meta's
  outbound-answer webhook. A SIP leg's equivalent would need its own event
  type, driven by drachtio-srf's own dialog/response events rather than a
  Redis-relayed webhook, not a rename of this handler (since WhatsApp
  outbound must keep working).
- Numeric Meta error-code classification in `CallWebhookProcessor` (errors
  138019/138020/138021 → `TerminatedBy.WHATSAPP`) — SIP failure
  classification would use SIP response codes instead; not reusable, only a
  pattern to mirror.

### Already fully generic, zero changes needed

`ConnectionEventHandler.js`, `TransferEventHandler.js`, `MonitorEventHandler.js`
— none reference `WHATSAPP` at all; ICE-candidate routing, transfer, and
monitor/whisper/barge logic already operate on whatever `connectionType` is
passed in.

### Enum changes likely needed

- `ConnectionType` (`src/services/call/constants/CallConstants.js`): add `SIP`.
  Additive/safe at the JS level — the risk is entirely the DB column (see
  Blockers above).
- `TerminatedBy`: currently has a literal `WHATSAPP` member meaning
  "provider-side failure." Decide whether to add `TerminatedBy.SIP` (correct,
  but every `TerminatedBy.WHATSAPP` call site needs to become conditional on
  which customer-leg type failed) or reuse `WHATSAPP` for SIP failures too
  (semantically wrong, lower effort). Same DB-enum risk applies if this
  column is also strictly typed.
- `AssignmentType`, `RoutingStrategy`, `InitiatorType`, `CallStatus`,
  `CallDirection`, `TerminationReason` — all already transport-agnostic, no
  changes needed.
- `CallContext.js`'s `wacid`/`setWacid()` are WhatsApp-specific but not worth
  renaming to something generic — lower risk to just leave them unused/null
  for SIP calls than to rename a field touched by `Peer.js`,
  `InitiationEventHandler.js`, and `CallRepository.updateWacid`.

### New surface needed

```
src/services/call/signaling/
├── SignalingAdapter.js            (existing, unchanged)
├── SignalingAdapterRegistry.js    (existing — resolve() gets a real branch for ConnectionType.SIP)
├── webrtc/                        (existing — PeerRegistry/SDPCoordinator/Peer/etc. reused verbatim)
└── sip/
    ├── SipSignalingAdapter.js     (fills in the existing stub, still extends SignalingAdapter)
    ├── SipCallCoordinator.js      (NEW — facade: inbound INVITE → peerRegistry.getOrCreateConnection(callId, ConnectionType.SIP)
    │                                → sdpCoordinator.createSDPOffer → rtpengine.offer() → sdpCoordinator.processSDPAnswer
    │                                → srf.createUAS to answer the trunk)
    ├── DrachtioClient.js          (NEW — owns the srf connection singleton, wires srf.invite/dialog events)
    └── RtpEngineClient.js         (NEW — promoted from deploy/sip-gateway/test/rtpengine-ng-client.js, not a rewrite —
                                     needs real test coverage before being trusted in the app)
```

Design patterns used, matching ARCHITECTURE.md's existing documented
conventions rather than introducing new ones: `SipCallCoordinator` is a
**Coordinator** (single entry point for a multi-step flow, same role as
`SDPCoordinator`/`AgentAssignmentCoordinator`); `DrachtioClient`/
`RtpEngineClient`/`SipCallCoordinator`/`SipSignalingAdapter` are all
**Singleton exports** (instantiated once, lowercase instance name); the whole
`sip/` folder is the **Adapter** side of the `SignalingAdapter` **port**
established in the earlier hexagonal-boundary work.

**No new HTTP route/controller needed** — unlike the WhatsApp-webhook or
FreeSWITCH/ESL-event models, drachtio-srf delivers SIP messages directly to
Node's own process via `DrachtioClient`'s `srf.invite(...)` handler. The
"entry point" for an inbound SIP call is that handler itself, not a route
Node exposes.

Event-handler dispatch in `AgentEventHandler`/`InitiationEventHandler`/
`TerminationEventHandler`/`RejectionEventHandler` to call `sip/`'s modules
instead of `WhatsAppCallApi` when a call's customer leg is SIP.
