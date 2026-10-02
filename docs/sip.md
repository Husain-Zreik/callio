# SIP channel and gateway

Callio takes PSTN calls through a SIP trunk as a second customer channel next
to WhatsApp. Two parts:

- **The gateway** (`deploy/sip-gateway/`): `drachtio-server`, which handles SIP
  signalling, and `rtpengine`, which relays media, running in Docker on the
  same host as Callio.
- **The SIP channel** (`src/channels/sip/`): the adapter that turns SIP into
  `ChannelIngress` events and implements the `CustomerChannel` port.

Status: inbound and outbound pass the local end-to-end suite with real G.711
audio. A real inbound carrier call has reached an agent through the SIP
channel with two-way audio. What is still open on a real trunk is listed
[at the end](#open-items-on-a-real-trunk).

## Why drachtio + rtpengine

`drachtio-server` only handles SIP signalling. It has no dialplan and no media,
and it passes every SIP message to the Node app (`drachtio-srf`) as an event.
`rtpengine` relays media and converts between plain RTP and WebRTC, and the
same Node app controls it over the UDP "ng" protocol. So all call logic stays
in Callio's Node code, with no second dialplan language. Janus's SIP plugin
is one identity per client, which doesn't fit a shared-DID trunk.
FreeSWITCH and Asterisk would split routing between their dialplan and
Callio.

## How a SIP call flows

**Inbound.** The carrier sends an INVITE to drachtio. Every Callio worker holds
a drachtio connection, and drachtio spreads new INVITEs across them.
`SipIngress` on the worker that receives the INVITE does this:

1. It resolves the dialled number to an active SIP channel. The number is the
   Request-URI user, or the To user if that doesn't parse.
2. It checks that the source IP is in the channel's trunk's `inbound_source_cidrs`.
3. It sends `180` and hands the call, with the carrier's SDP as it is, to
   `ChannelIngress.inboundCall`.

The worker that received the INVITE claims the call, so the call's media legs
and its SIP leg live on the same worker. The customer leg is like a WhatsApp
one on the media plane ([architecture.md → Media](architecture.md#media)):
rtpengine anchors the carrier's plain RTP (the channel's `sdpProfile.transport`
is `rtp`) and relays it to the customer's FreeSWITCH endpoint, so the room,
IVR, recording, monitoring and DTMF are the same for both channels.

When an agent accepts or the IVR answers, the media plane's answer goes back in
`200 OK`. A BYE from the carrier ends the call. In-dialog requests go back to
the worker that owns the dialog.

**Actions from other workers.** A queue timeout, cleanup or an API call can
start on any worker. `SipDialogs` records the owning worker of each leg in
Redis and sends the action to that worker over a per-worker pub/sub channel.

**Outbound.** `POST /v1/tenants/{t}/calls` on a SIP channel creates an intent.
The agent's `call:start` supplies their leg; the media plane offers the
customer leg, and Callio sends that offer in an INVITE through the channel's
trunk.

## What Callio expects from a carrier

| | |
|---|---|
| Trunk | IP-authenticated (no REGISTER). Inbound INVITEs are accepted only from the trunk's `inbound_source_cidrs`. |
| Signalling | UDP or TCP on 5060 (`drachtio.conf.xml`: `sip:*:5060;transport=udp,tcp`). TLS is not configured. |
| Dialled number | The Request-URI user, or the To user if that doesn't parse, is the channel's DID. It may be written `+961…`, `961…` or `00961…`, and all three normalise to E.164. |
| Caller | The From user. If it is a phone number (5–15 digits), the caller is stored as E.164. Otherwise the From URI is stored as a `SIP_URI` address. The display name is kept. |
| Codecs | G.711 PCMU/PCMA (FreeSWITCH also offers G.722 and Opus); the room transcodes. |
| RTP | UDP ports `port-min`–`port-max` from `rtpengine/rtpengine.conf` (20000–29999). |
| DTMF | In-band. `sipSdp.js` strips `telephone-event` from the SDP, so the carrier falls back to in-band tones, which the media server detects (it detects RFC 4733 too). |

**Callio's responses to an inbound INVITE:**

| Response | When |
|---|---|
| `404` | No active SIP channel has the dialled number (also what SIP scanners get) |
| `403` | The source IP is not in the trunk's CIDRs, or the trunk is not `ACTIVE` |
| `488` | The INVITE has no SDP offer (late offer isn't supported) |
| `180` | Accepted. The call is waiting for the IVR or an agent. |
| `200` | Answered by an agent or the IVR |
| `480` | Callio ended the call before answering it: ring timeout / max wait, rejection, or an ingress failure |
| `500` | Unexpected error while handling the INVITE |
| BYE | Callio ends an answered call (agent hang-up, termination). A carrier BYE ends the call with the customer as the terminating side. |
| CANCEL | The caller gave up while it rang. The call ends by the customer, unanswered. |

**Outbound:**

- The INVITE goes to `sip:<number>@<trunk host>:<port>;transport=<trunk transport>`
  (the number without `+`).
- `From` is `<sip:<channel DID>@<trunk host>>`.
- If the trunk has credentials, Callio answers digest challenges with them.

| Carrier response | Call |
|---|---|
| `180` / `183` | RINGING |
| `200` | Answered: the answer goes to the customer's leg and the call is `IN_PROGRESS` |
| `486` / `600` / `603` | REJECTED (by the customer) |
| `408` / `480` | NO_ANSWER |
| anything else | FAILED, with the SIP status in `failure_details` |

Callio sends CANCEL for an unanswered outbound leg it ends itself, and BYE for
an answered one.

## Code

`src/channels/sip/`, registered in `src/channels/index.js`:

| File | Role |
|---|---|
| `SipChannel.js` | The `CustomerChannel` port. `accept` (200 OK with the media plane's answer), `reject` / `terminate` (a final error, BYE or CANCEL, run on the owning worker), `initiate` (outbound INVITE through the trunk), address normalisation, channel validation, `start` / `stop`. |
| `SipIngress.js` | INVITE → `ChannelIngress.inboundCall` (channel lookup, source check, 180). CANCEL → the end of the call. |
| `SipDialogs.js` | The SIP legs this worker holds, by Call-ID. Owner records in Redis. Routes reject/terminate from other workers to the owner. |
| `sipLegs.js` | Ending a leg: forgets it, then reports the provider-side end and timing to `ChannelIngress.callEnded`. |
| `sipSdp.js` | The channel's `sdpProfile`: transport `rtp`; strips telephone-event. |
| `sipAddress.js` | DID and caller parsing (`toE164`, `dialledNumber`, `callerOf`), the user part to dial (`userPart`), the trunk's CIDR check (`sourceAllowed`). |

The drachtio connection (`src/infra/sip/Drachtio.js`) is shared with the media
plane, whose FreeSWITCH endpoints are created by INVITEs through it; the
rtpengine client is `src/infra/media/RtpEngineClient.js`.

Data: trunks are rows in `sip_trunks`. A row has host, port, transport, encrypted
credentials, `inbound_source_cidrs`, status, and `consumer_id` (NULL means a
platform trunk). A SIP channel is a `channels` row with `type = SIP`, `address`
= the DID and `sip_trunk_id`.

## Configuration

**Callio** (`.env`, read in `config/envConfig.js` → `sip`), per worker:

```
DRACHTIO_HOST=127.0.0.1        # required: the media plane uses it too
DRACHTIO_PORT=9022             # drachtio's admin port
DRACHTIO_SECRET=…              # must equal DRACHTIO_SECRET in deploy/sip-gateway/.env
RTPENGINE_HOST=127.0.0.1
RTPENGINE_NG_PORT=22222        # rtpengine's listen-ng
# rtpengine's named interfaces (interface = name/…):
# RTPENGINE_EXTERNAL_INTERFACE=external   facing carriers, WhatsApp and agents
# RTPENGINE_INTERNAL_INTERFACE=internal   facing FreeSWITCH
FREESWITCH_HOST=127.0.0.1      # and the rest of the media settings: .env.example
```

**The gateway** (`deploy/sip-gateway/`):

- `.env` (from `.env.example`): `DRACHTIO_SECRET`. drachtio-server takes it from
  its environment (compose `env_file: .env`), and it overrides the placeholder
  `secret` attribute in `drachtio/drachtio.conf.xml`. Callio's `DRACHTIO_SECRET`
  must equal it. After changing it, run
  `docker compose up -d --force-recreate drachtio` and restart Callio. If the
  two don't match, Callio logs `drachtio connection … failed: failed to
  authenticate to server` (component `infra.sip.Drachtio`).
- `drachtio/drachtio.conf.xml`: the admin port 9022 is bound to 127.0.0.1 (Callio
  runs on the same host), SIP listens on `*:5060` over UDP and TCP, and logs go
  to `/var/log/drachtio/` (the `drachtio-log` volume).
- `rtpengine/rtpengine.conf`:
  - `interface` is the address rtpengine binds and advertises in SDP, which is
    this host's public IP. Behind cloud NAT, use `private!public` so the SDP
    carries the reachable address; getting this wrong is the usual cause of
    one-way or no audio.
  - `listen-ng = 127.0.0.1:22222`.
  - `port-min` / `port-max` set the RTP range.
  - The file must contain **no comment lines**: rtpengine's parser exits
    silently on any `;` line. Notes about it belong in `docker-compose.yml`.

## Provisioning

A trunk is operator-side, like a consumer:

```bash
npm run sip:trunk -- --name <name> --host <carrier signalling host> \
  [--port 5060] [--transport UDP|TCP] \
  [--cidr <ip>/32 --cidr <range>/24 …] \
  [--username <u> --password <p>] \
  [--consumer <slug>]
```

- It prints the trunk, and SIP channels reference its `id` as `sip_trunk_id`.
  Running it again with the same `--name` (and the same `--consumer`, or none)
  updates that trunk. An update rewrites the host, port, transport and CIDRs
  from the flags given, so leaving out `--cidr` opens the trunk to any source.
  Credentials are kept unless `--username` is given.
- Without `--consumer`, it creates a **platform trunk** that every consumer's
  channels may use. With `--consumer`, only that consumer's channels may use the
  trunk, and the Management API refuses anyone else's with `400`.
- `--cidr` may be repeated, and each value is an IPv4 CIDR or a single address
  (a bare IP means /32; IPv6 is matched exactly). Only INVITEs whose source is
  in one of them are accepted (`403` otherwise). **Without `--cidr`, any source
  is accepted**, which is for development only, and the script warns. List
  every signalling IP the carrier may send from, not just the one in `--host`.
- `--username` / `--password` are digest credentials for outbound calls,
  encrypted with `CALLIO_MASTER_KEY`.

The SIP channel is created by the consumer through the Management API
(`docs/management-api.md`):

```bash
curl -X PUT https://<callio>/v1/tenants/{t}/channels/{channelRef} \
  -H "Authorization: Bearer <api key>" -H "Content-Type: application/json" \
  -d '{ "type": "SIP", "address": "+<DID>", "sip_trunk_id": <id>, "inbound_queue_ref": "<queue>" }'
```

`address` must be the DID in E.164, and `sip_trunk_id` is required.

For local development, `npm run seed:dev -- … --sip-did +<DID> [--sip-trunk-host 127.0.0.1] [--sip-trunk-port 5060]`
creates a platform trunk `dev-trunk` with no CIDRs, plus a channel `sip-main` on
the seeded queue.

To check keypad input on a real line, `npm run ivr:test -- --consumer <slug> --tenant <ref> --channel <ref>`
puts a test IVR menu on a channel (two beeps; 1 = the channel's queue, 9 = hang
up). `--off` removes it.

## When a worker stops

An answered SIP call outlives the worker that answered it (a crash, or a deploy handing calls
over — [media-architecture.md](media-architecture.md)). The carrier dialog lives in that worker's
drachtio connection, so the worker taking the call over drives it by drachtio's dialog id,
stored at answer (`callio:sip:dialog:<Call-ID>`):

- **Hang-up from Callio's side** (agent, API, timeout): a BYE inside the dialog, by its id.
- **Hang-up from the carrier:** its BYE goes to the dead worker's connection, so nobody gets it.
  The new owner sends an in-dialog `OPTIONS` every 5 s; a `481`/`408`, or two failures in a row
  (drachtio no longer has the dialog), ends the call `COMPLETED/CUSTOMER` within ~10 s.
- **Not taken over:** an inbound call still ringing (its pending INVITE transaction was that
  worker's) and an outbound call not yet answered. A deploy ends those; a crash leaves them to
  the carrier's timers and the stuck-call scan.

`sip-cluster.test.mjs` covers both hang-ups after the worker running two calls is killed.

## Deploying the gateway

**Prerequisites:** a Linux host with a public static IP, Docker and Docker
Compose, and Callio on the same host. The admin and ng ports are bound to
loopback. If Callio runs elsewhere, move them to a private address and
firewall them, because the drachtio secret controls every call.

```bash
cd deploy/sip-gateway
cp .env.example .env               # set DRACHTIO_SECRET and ESL_PASSWORD (long random values)
# edit rtpengine/rtpengine.conf: interface = external/<public IP>;internal/127.0.0.1
#   (external/<private>!<public> behind NAT)
docker compose up -d --build       # builds the FreeSWITCH image the first time
docker compose logs -f
```

The three containers (drachtio, rtpengine, FreeSWITCH) use **host networking**, because SDP carries real IPs and ports
and Docker's NAT would break them. The rtpengine service starts the binary
directly instead of the image's entrypoint, which tries `sed -i` on the
bind-mounted config and fails. FreeSWITCH listens on 127.0.0.1 only
(`MEDIA_BIND_IP`): SIP 5080/5082, RTP 10000–19999, event socket 8021. Then set
`DRACHTIO_*`, `RTPENGINE_*`, `FREESWITCH_*` and `MEDIA_*` in Callio's `.env`
(`FREESWITCH_ESL_PASSWORD` = the gateway's `ESL_PASSWORD`,
`MEDIA_ESL_ADVERTISED_ADDRESS=127.0.0.1`; FreeSWITCH fetches IVR and hold audio
from the worker that owns the call, so `MEDIA_CALLBACK_URL` stays unset) and
restart it. Each worker logs `Connected to
drachtio-server` and `Connected to FreeSWITCH`; FreeSWITCH connects back to
each worker on its HTTP port + 1000 and + 2000 (loopback).

**Firewall.** Docker publishes nothing here; the host firewall does all the
restricting:

- `5060/udp` and `5060/tcp` only from the carrier's **signalling** IPs.
- The RTP range (`port-min`–`port-max`) from **anywhere**: every leg's audio
  lands there — the carrier's media IPs, WhatsApp's media relay, and agents'
  and supervisors' browsers (WebRTC). It carries only media for sessions
  Callio set up.
- 9022, 22222 and FreeSWITCH's ports (loopback anyway) must not be reachable
  from outside.
- **Loopback must pass any 5060 allow-list.** FreeSWITCH answers drachtio's
  INVITEs (every leg's endpoint) on drachtio's port 5060 over `lo`. A rule
  that sends all 5060 traffic through an allow-list placed above
  `-i lo -j ACCEPT` drops those replies: every call then fails after 32 s
  with `408 Request Timeout` and never reaches an agent. Put
  `-A SIP -i lo -j ACCEPT` first in such a chain.

SIP scanners probe any open 5060 within minutes, sending INVITEs to random
numbers from unknown IPs. Callio answers them `404` or `403` (rate-limited
warnings, and the `callio_sip_invites_refused_total` metric), but they should be stopped at the
firewall. A new server's firewall has blocked the carrier before, so confirm
the rules with a real inbound call.

**Diagnostics:**

- `docker compose logs -f drachtio`, or the file log in the container at
  `/var/log/drachtio/drachtio.log`. Check whether the INVITE arrived at all
  and what was answered.
- `docker exec callio-rtpengine rtpengine-ctl list numsessions` should show a
  live session during a call. `rtpengine-ctl list sessions all` shows the
  packet counters. rtpengine logs to stdout (`docker compose logs rtpengine`).
- Callio's side: `npm run logs -- --component channels.sip --follow`. For
  more detail, `npm run log-level -- channels.sip=debug --for 30m`.
- No INVITE arrives: check the firewall for the carrier's signalling IPs, then
  that the carrier sends to this IP on 5060 over UDP or TCP.
- `403`: the source IP isn't in the trunk's `--cidr` list.
- Call connects but there is no audio: check rtpengine's `interface` (public IP /
  `private!public`) and the RTP range in the firewall.
- `deploy/sip-gateway/test/options-ping.js` is a dependency-free SIP OPTIONS
  probe. It checks that the carrier's signalling address answers from this
  host without placing a call:
  `TRUNK_IP=<carrier IP> [TRUNK_PORT=5060] node deploy/sip-gateway/test/options-ping.js`.

## Local testing

```bash
docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d
npm run test:e2e -- sip
```

`docker-compose.local.yml` is for Docker Desktop, where host networking isn't
available.

- It publishes ports on 127.0.0.1: 5060 UDP and TCP, 9022, 22222/udp, and RTP
  30000–30099.
- It uses the `*.local.*` configs:
  - drachtio's admin port binds 0.0.0.0 inside the container, so the published
    port reaches it.
  - rtpengine uses `interface = eth0!127.0.0.1` (bind the container interface,
    advertise 127.0.0.1) and `delete-delay = 0`, so back-to-back test calls
    don't run out of ports.
- The local secret is the literal `CHANGE_ME` in `drachtio.local.conf.xml`.
  The e2e runner uses `TEST_DRACHTIO_SECRET`, which defaults to that value.

`test/e2e/run.mjs` runs the SIP suite only when something listens on
127.0.0.1:9022. `test/e2e/sip.test.mjs` uses a fake carrier
(`test/e2e/sipCarrier.mjs`, a SIP UA that sends and receives G.711 RTP) and
covers these cases:

0. A SIP channel is provisioned through the Management API with its trunk. A
   trunk the consumer may not use is refused (`400`).
1. Inbound call: it is created on the SIP channel with the caller as E.164, and
   the carrier hears `180`. The call is offered to the agent, and accepting
   answers the carrier (`200`/ACK). Audio goes both ways over G.711 (tones
   checked on each side). An agent hang-up sends BYE and ends the call
   `COMPLETED` / `AGENT` with its duration.
2. A caller hang-up (carrier BYE) ends the call `COMPLETED` / `CUSTOMER`, and
   the agent is released.
3. CANCEL while it rings ends the call by the customer, unanswered.
4. A call to an unknown number gets `404`.
5. Queue max wait ends a ringing SIP call as `TIMEOUT`, and the carrier gets a
   final error response.
6. IVR on the SIP channel:
   - The IVR answers the call itself.
   - Pressing 1 as in-band DTMF transfers the call to the queue.
   - The caller is then bridged to the agent with audio.
   - A caller who hangs up while waiting after the IVR ends `NO_ANSWER`, not
     `COMPLETED`.
7. Outbound: an intent on the SIP channel is accepted, and Callio dials the
   customer through the trunk. The carrier ringing and answering move the call
   to `IN_PROGRESS`, audio goes both ways, and hanging up sends BYE.
8. Outbound declined with `486` ends the call `REJECTED` / `CUSTOMER`.
9. Consumers get the same events for SIP calls (`call.created`, `call.assigned`,
   `call.answered`, `call.ended`).

To try it by hand, point a softphone (MicroSIP, Linphone) directly at
`127.0.0.1:5060` with no registration, and dial the channel's DID.
`docker exec callio-rtpengine-local rtpengine-ctl list numsessions` shows the
session.

## Open items on a real trunk

Done: a real inbound carrier call reached an agent through the SIP channel with
two-way audio. IVR, in-band DTMF, transfer, hang-up from each side and a caller
giving up after the IVR have been verified on a softphone line.

1. **A real DID** from the carrier, provisioned as the channel `address`.
2. **All carrier source IPs.** Every signalling IP goes into the trunk's
   `--cidr` list and the firewall for 5060. Every media IP goes into the
   firewall for the RTP range.
3. **Hang-up both ways and the DTMF mode on the carrier.** Check that BYE works
   in both directions. Check that the carrier falls back to in-band DTMF when
   telephone-event is declined (`npm run ivr:test`). If it insists on RFC 4733,
   Callio has to take DTMF from rtpengine's DTMF events instead of from the
   audio. That is not built yet.
4. **Outbound enablement.** An early outbound test was rejected by the carrier
   with `503`, which is likely outbound not being enabled or a caller-ID
   (From) authorisation rule. It needs the carrier's side. Outbound is proven
   only against the local fake carrier.
