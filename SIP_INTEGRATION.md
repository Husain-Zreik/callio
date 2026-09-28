# SIP Trunk Integration

Status: **Milestone A complete and validated with a real inbound call.**
Milestone B (application code, wiring SIP into the call domain) has not
started — this doc exists so it doesn't have to re-derive the scope from
scratch.

## Goal

Accept calls from a SIP trunk/carrier as a second "customer leg" alongside
the existing WhatsApp Business Calling leg, first slice scoped to **inbound
only — accept a PSTN call, bridge to an agent** (parity with the existing
WhatsApp inbound flow). Outbound-via-SIP is out of scope until this works
(an exploratory outbound signaling test was also run — see Milestone A
results below — but building real outbound support is not part of this
slice).

Trunk: IP-authenticated, carrier is **Digitalk**, signaling IP
`185.231.78.58`.

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

## Milestone A — gateway infra (complete)

**Validated with a real inbound call from Digitalk (the trunk provider):**
INVITE reached `drachtio-server` → `call-test.js` received it and logged the
Call-ID/caller info → `rtpengine` accepted the SDP offer and allocated a real
media session → `drachtio` answered with 200 OK, received the ACK, call
established → Digitalk sent BYE after ~12 seconds, call ended cleanly. Both
signaling (drachtio) and media negotiation (rtpengine) are confirmed working
against the real trunk, not just simulated locally. One real, trunk-specific
bug was found and fixed along the way: an inbound firewall rule was blocking
the carrier's traffic before this succeeded — resolved on the server
(specifics not captured in this repo; if re-deploying to a new server, don't
assume the firewall rules in `RUNBOOK.md`'s prerequisites are sufficient
as-is, verify against a real inbound attempt the way this one was).

An exploratory outbound test (`test/outbound-test-call.js`, added after this
milestone's original scope) also confirmed outbound SIP signaling reaches the
trunk, but the trunk provider rejected the call with `503 Service
Unavailable` — most likely a `From`/Caller-ID authorization requirement or
outbound not being enabled on this trunk yet. Not investigated further since
outbound is out of scope for this slice; would need the provider's input to
resolve if outbound is ever needed.

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

## Blockers found during scoping

1. **Resolved.** The DB enum question is gone: Callio has its own schema.
   `call_connections.connection_type` is the leg's *role* (`AGENT` /
   `CUSTOMER` / `MONITOR`) and the transport is `calls.channel` /
   `channels.type` (`WHATSAPP` / `SIP`), so a SIP customer leg is a
   `CUSTOMER` leg — no new leg type. `TerminatedBy.PROVIDER` covers carrier
   failures as well as Meta's.
2. **Resolved.** drachtio-server + rtpengine's behavior against the real
   trunk is now confirmed — see Milestone A results above. Local testing
   caught and fixed two real bugs before the real-trunk test (the `<admin-tcp
   address="...">` → `<admin>` config element, and rtpengine's config
   parser crashing on any `;` comment line — both fixed in
   `deploy/sip-gateway/`), and the real inbound call caught one more
   (a firewall rule), all now resolved. Still genuinely unverified: actual
   two-way audio *content* (the real call negotiated real media sessions and
   ran for ~12s, but audio quality/correctness wasn't specifically checked),
   and outbound calling (rejected by the provider, see above — not pursued).

## Milestone B scope (not started) — the SIP channel adapter

The channel boundary SIP plugs into already exists and WhatsApp runs on it
(PLATFORM_ARCHITECTURE.md §6, "Channels are adapters"):

- `src/core/channels/CustomerChannels.js` — the `CustomerChannel` port
  (accept, reject, terminate, initiate, `sdp` profile, address rules,
  provisioning validation, optional routes) and the registry the core calls
  by `calls.channel`.
- `src/core/channels/ChannelIngress.js` — where an adapter reports provider
  events in Callio's terms: `inboundCall`, `outboundAnswered`,
  `statusChanged`, `callEnded`. Dedup, the consumer lookup, IVR vs. queue,
  offering agents, termination reasons and timing, agent release and
  auto-offline all live there once, for every channel.
- `src/channels/whatsapp/` — the reference adapter: `WhatsAppChannel` (the
  port), `WhatsAppCallApi`, `WhatsAppWebhookTranslator`, `webhookRoutes`,
  `whatsappSdp`.

The media engine, IVR, recording, DTMF, routing, the agent gateway and the
Management API need **no changes** for SIP; neither do the enums or schema
(`channels.type` and `calls.channel` already accept `SIP`,
`CustomerAddressType.SIP_URI` exists).

### Key design insight: a SIP leg is still a real Node-side WebRTC peer connection

There are two ways drachtio+rtpengine could bridge a SIP call: (1) rtpengine
relays raw RTP directly between the trunk and the agent's browser, with media
never touching Node's process at all, or (2) rtpengine converts the trunk's
plain RTP into a genuine WebRTC session that **Node itself terminates** via
`@roamhq/wrtc` — exactly like the WhatsApp customer leg. Option 2 is the one
to build: `AudioBridge`, recording, DTMF and IVR see a SIP call as just
another `CUSTOMER` `RTCPeerConnection`.

Inbound flow: drachtio-srf receives the trunk's INVITE → the adapter resolves
the dialled DID to a `channels` row (`channels.address`) → rtpengine `offer`
turns the trunk's SDP into a WebRTC offer → `channelIngress.inboundCall(channel,
{ providerCallId: <SIP Call-ID>, customer: { address, addressType: E164 | SIP_URI },
sdpOffer, ... })`. From there the core does what it does for WhatsApp; when it
answers (`SipChannel.accept(call, sdpAnswer)`), the adapter runs rtpengine
`answer` and replies 200 OK via `srf.createUAS`. BYE/CANCEL from the trunk →
`channelIngress.callEnded`; `SipChannel.terminate` sends BYE.

`PeerEventManager.handleIceCandidate` already skips trickling outbound ICE for
the `CUSTOMER` leg (the whole SDP is exchanged in one round trip), which is
what rtpengine needs too.

### New surface

```
src/channels/sip/
├── SipChannel.js            the CustomerChannel port: accept → rtpengine answer + 200 OK,
│                            reject → 486/603, terminate → BYE, initiate → INVITE via the trunk,
│                            sdp profile (if rtpengine's WebRTC SDP needs any rewrite),
│                            normalizeCustomerAddress (E.164 / SIP URI), validateChannelConfig
├── SipIngress.js            srf.invite / dialog events → ChannelIngress (DID → channel,
│                            Call-ID → providerCallId, SIP response codes → failed/errors)
├── DrachtioClient.js        owns the srf connection singleton
└── RtpEngineClient.js       promoted from deploy/sip-gateway/test/rtpengine-ng-client.js;
                             needs real test coverage before being trusted in the app
```

plus `customerChannels.register(sipChannel)` in `src/channels/index.js` and a
drachtio connection started from `server/bootstrap.js`. **No HTTP route is
needed** — drachtio-srf delivers SIP messages to Node's own process.

Open points for the implementation:
- **Media ownership.** A SIP dialog lives on the worker whose drachtio
  connection received the INVITE; `ChannelIngress` claims call ownership on
  the worker that handles `inboundCall`, which must be the same one. One
  drachtio connection per worker (drachtio-server load-balances INVITEs
  across connected apps) satisfies this; BYE for a dialog arrives on its own
  worker.
- **Failure attribution.** Map SIP final responses to `failed` / `errors`
  (e.g. 5xx/6xx from the trunk → PROVIDER, 486/603 → customer rejection via
  `statusChanged(REJECTED)`), the way the WhatsApp translator maps Meta's
  relay error codes.
- **e2e.** Add a SIP scenario to `test/e2e` (a SIP UA against the local
  gateway in `deploy/sip-gateway/docker-compose.local.yml`).
