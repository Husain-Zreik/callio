# SIP Trunk Integration

Status: **Milestone A** (the gateway) is validated with a real inbound call.
**Milestone B** (the SIP channel in `src/channels/sip/`) is implemented and
passes the local end-to-end suite with real audio; the run against the real
trunk is pending (see the end of this doc).

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

## Milestone B — the SIP channel (implemented; real-trunk run pending)

SIP is a customer channel like WhatsApp (PLATFORM_ARCHITECTURE.md §6,
"Channels are adapters"), in `src/channels/sip/`:

| File | Role |
|---|---|
| `SipChannel.js` | The `CustomerChannel` port: accept (rtpengine answer + 200 OK), reject / terminate (final error, BYE or CANCEL), `initiate` (INVITE through the trunk), address rules, channel validation, `start`/`stop` |
| `SipIngress.js` | INVITE → `ChannelIngress.inboundCall`: the dialled number resolves the channel, the channel's trunk vouches for the source (`inbound_source_cidrs`), rtpengine turns the offer into WebRTC; CANCEL / BYE → `callEnded` |
| `SipGateway.js` | This worker's drachtio-srf connection and rtpengine client |
| `SipDialogs.js` | The SIP legs this worker holds; routes reject/terminate from other workers to the owner (Redis) |
| `sipLegs.js` | Ending a leg: rtpengine delete, and the provider-side timing to the core |
| `RtpEngineClient.js` | rtpengine ng protocol (promoted from `deploy/sip-gateway/test/`), with the two conversions: carrier RTP ⇄ WebRTC |
| `sipSdp.js` | The channel's SDP rules: add `a=group:BUNDLE` (Callio's peers are max-bundle), drop telephone-event (see DTMF) |
| `sipAddress.js` | DID / caller parsing, the user part to dial, the CIDR check |

**Media:** rtpengine converts the carrier's plain RTP (G.711) to and from a
WebRTC session (ICE + DTLS-SRTP) that Callio's media engine terminates as the
call's `CUSTOMER` leg — so the audio bridge, IVR, recording, monitoring and
DTMF detection are the same code as for WhatsApp. Codecs pass through
(PCMU/PCMA); rtpengine doesn't transcode.

**Workers:** every worker connects to drachtio-server; drachtio spreads new
INVITEs across them and sends in-dialog requests (BYE) back to the owner. The
worker that receives an INVITE claims the call (ChannelIngress ownership), so
its media and its SIP leg are on the same worker. Actions started elsewhere
(a queue timeout, cleanup, the API) reach the owner through `SipDialogs`.

**DTMF:** Callio detects keys in the customer's audio. Carriers send DTMF
in-band or as RFC 4733 telephone-events, which a WebRTC peer consumes as
events, not audio. `sipSdp.js` leaves telephone-event out of what we accept, so
the carrier falls back to in-band DTMF. Found along the way: the detector's
power floor was tuned for 48 kHz and rejected every key at 8 kHz (G.711) —
now scaled to the sample rate (`media/dtmf/DTMFDetector.js`).

**Outbound:** `POST /v1/tenants/{t}/calls` on a SIP channel → the agent's
`call:start` → INVITE to `sip:<number>@<trunk host>:<port>` with the channel's
DID as `From`, digest credentials if the trunk has them. 180/183 → RINGING,
200 → answered, 486/600/603 → REJECTED, other failures → FAILED with the SIP
status in `failure_details`. Digitalk rejected outbound with `503` during
Milestone A, so outbound is only proven against the local fake carrier.

### Configuration

Callio, per worker (`.env`):

```
DRACHTIO_HOST=127.0.0.1        # unset = SIP disabled
DRACHTIO_PORT=9022
DRACHTIO_SECRET=…              # = DRACHTIO_SECRET in deploy/sip-gateway/.env (see below)
RTPENGINE_HOST=127.0.0.1
RTPENGINE_NG_PORT=22222
# Only when rtpengine has several named interfaces (e.g. private + public):
# RTPENGINE_CARRIER_INTERFACE=… RTPENGINE_WEBRTC_INTERFACE=…
```

Provisioning:

```bash
npm run sip:trunk -- --name digitalk --host 185.231.78.58 --cidr 185.231.78.58/32
# → prints the trunk id
curl -X PUT …/v1/tenants/{t}/channels/sip-main -d '{ "type": "SIP", "address": "+961…", "sip_trunk_id": 1, "inbound_queue_ref": "main" }'
```

A trunk without `--cidr` accepts INVITEs from any source — development only.

**The drachtio secret** that counts is `DRACHTIO_SECRET` in
`deploy/sip-gateway/.env`: the image applies it over `drachtio.conf.xml`'s
`<admin secret>`. Callio's `.env` must hold the same value; after changing
it, `docker compose up -d --force-recreate drachtio` and restart Callio. A
mismatch logs `drachtio connection … failed: failed to authenticate to server`
(component `channels.sip.SipGateway`).

**Firewall:** SIP scanners probe every public port 5060 within minutes
(INVITEs to numbers like `+3908…` from unknown IPs). Callio answers them 404
and the trunk's CIDRs reject unknown sources, but allow 5060 only from the
carrier's signaling IPs at the firewall too.

### Testing

`npm run test:e2e` runs `test/e2e/sip.test.mjs` when the local gateway is up
(`docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d`), with
a fake carrier (`test/e2e/sipCarrier.mjs`: a SIP UA plus G.711 RTP) calling
in and answering outbound calls: audio both ways, hang-up from either side,
CANCEL, unknown number (404), a queue timeout (480), IVR with in-band DTMF,
outbound answered and declined (486). The local rtpengine binds its container
interface and advertises 127.0.0.1 (`interface = eth0!127.0.0.1`), which is
how Docker Desktop's published ports reach it; production uses host
networking and the public IP.

### Still to do on the real trunk

1. Move the dev server to the new database, deploy, set the env above,
   create the Digitalk trunk (with its CIDR) and a SIP channel for the DID.
2. A real inbound call: two-way audio, hang-up both ways, IVR key presses —
   and whether Digitalk falls back to in-band DTMF when telephone-event is
   declined (if it insists on RFC 4733, Callio needs to take DTMF from the
   events instead: rtpengine can report them).
3. Outbound needs Digitalk to enable it (the `503` from Milestone A).
