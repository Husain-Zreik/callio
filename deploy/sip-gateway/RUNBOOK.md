# drachtio-server + rtpengine — deployment & validation runbook

**STATUS: Milestone A complete.** A real inbound call from Digitalk (the
trunk provider) went all the way through — see `../../SIP_INTEGRATION.md`'s
Milestone A section for the full trace. This runbook's checklist below is
now historical record of how that was reached (and useful as-is for
redeploying to a new server), not an open TODO.

Two additional standalone scripts exist in `test/` beyond what's described
below: `options-ping.js` (a SIP OPTIONS reachability probe — confirms the
trunk is alive without placing a call; must run from the server itself) and
`outbound-test-call.js` (exploratory outbound-call signaling test — the
trunk currently rejects outbound with `503`, not pursued further since
outbound is out of scope for this milestone; see `SIP_INTEGRATION.md`).

Milestone A of the SIP trunk integration (see `../../SIP_INTEGRATION.md` for
the full context, including why this replaced an earlier FreeSWITCH-based
plan). This runbook gets the gateway reachable by the real trunk and proves
the SIP+media path works — **independent of the real Callio application** —
before any Node integration code depends on it.

**Update: the local-testing path (section 0) has been run for real.** A raw
SIP INVITE placed against the local stack made it all the way through —
drachtio-server accepted it, `rtpengine-ng-client.js`'s `offer` command got a
genuine SDP answer back from rtpengine, `call-test.js` answered with 200 OK,
and a BYE tore the session down cleanly. That confirms the ng-protocol client
and the drachtio-srf integration logic are correct, not just plausible. One
real bug was found and fixed this way: `drachtio.conf.xml`/
`drachtio.local.conf.xml` used `<admin-tcp address="...">`, but the actual
element is `<admin>` with the bind address as its text content — the
container was crash-looping on this before the fix.

What that test did **not** cover: actual RTP audio content (it was a
signaling-only test — a UDP SIP client that never sent real RTP packets), and
anything specific to the real trunk (auth, firewall reachability, its exact
SDP quirks). Those still need the real server + a softphone/real call — the
sections below are otherwise unchanged starting points, authored without a
live instance to confirm against.

## Prerequisites

- [ ] Linux server, public static IP, Docker + Docker Compose, Node.js
      (for the validation script — this is separate from Callio's own
      Node runtime and can be a different machine if needed, though same-host
      is what this config assumes; see the loopback-binding notes in
      `drachtio/drachtio.conf.xml` / `rtpengine/rtpengine.conf` if not).
- [ ] Firewall rules open **from `185.231.78.58` only**:
  - `5060/udp` + `5060/tcp` (SIP) — add `5061/tcp` if the trunk needs TLS
  - the RTP range in `rtpengine/rtpengine.conf` (`port-min`/`port-max`,
    default `30000-30500` — narrow or widen based on expected concurrent
    call volume)
- [ ] From the provider, confirm the same open questions as before: SIP
      REGISTER vs. pure IP-auth, SRTP/TLS requirement, expected concurrent
      call volume, which DID routes here.

## 0. Local testing first (recommended, before the real server)

Everything below this section needs the real Linux server and the real
trunk. Before that, you can validate the SIP+media logic itself — most
importantly `rtpengine-ng-client.js`, the least-verified file here — on your
own machine with a free SIP softphone (e.g. MicroSIP on Windows, or Linphone
cross-platform), no trunk or public IP required.

Uses `docker-compose.local.yml` + the `*.local.*` config variants, **not**
the production files — `network_mode: host` (used in production) isn't
supported the same way on Docker Desktop for Windows/Mac, so the local
variant uses ordinary port publishing instead. See that file's header
comment for why these are kept as separate files rather than merged.

```
cd deploy/sip-gateway
docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml logs -f
```

- [ ] **Checkpoint: both containers start without config errors.**

```
cd test
npm install
DRACHTIO_SECRET=CHANGE_ME node call-test.js
```

(`CHANGE_ME` matches `drachtio.local.conf.xml`'s literal secret — no `.env`
needed for local testing, since nothing here is exposed beyond this machine.)

In your softphone, add an account pointing at `127.0.0.1:5060`, and dial out
**without registering first** — configure it for direct/proxyless SIP
calling if it has that option, sending the INVITE straight to
`sip:test@127.0.0.1:5060`. This isn't a workaround: it's actually how the
real trunk will behave too (an IP-authenticated trunk doesn't register with
us either, it just sends INVITEs) — so this is a faithful test of that same
behavior, not a simplification of it.

Expect the same three checkpoint lines as the real test call (section 3
below), and the same `rtpengine-ctl list numsessions` check
(`docker exec callio-rtpengine-local rtpengine-ctl list numsessions`).

- [ ] **Checkpoint: same three log lines appear for a locally-placed call, and
      rtpengine shows a live session.** If this fails, it's a bug in the code
      itself (most likely `rtpengine-ng-client.js`) — fix it here, where
      iteration is fast, before ever touching the real server.

When done: `docker compose -f docker-compose.local.yml down`.

## 1. Bring the gateway up

```
cd deploy/sip-gateway
cp .env.example .env   # fill in DRACHTIO_SECRET, EXTERNAL_IP
# Hand-edit drachtio/drachtio.conf.xml's admin-tcp secret to match .env's
# DRACHTIO_SECRET, and rtpengine/rtpengine.conf's `interface` to your real
# public IP — see each file's comments for why this isn't automatic.
docker compose up -d
docker compose logs -f
```

Watch for clean startup on both containers. drachtio-server logs to
`/var/log/drachtio/drachtio.log` inside its container (also mounted to the
`drachtio-log` volume); rtpengine logs to stdout (`log-stderr = true`).

- [ ] **Checkpoint: both containers start without config errors.**

## 2. Install and run the validation script

```
cd deploy/sip-gateway/test
npm install
DRACHTIO_SECRET=<same as .env> node call-test.js
```

It should print `connected to drachtio-server at ...` and then wait. Leave it
running for the next step.

## 3. Real test call

Have the provider (or a test phone/softphone on their network) place an
actual call into the DID that routes to this trunk.

Expected script output, in order:
1. `INVITE received — Call-ID=...`
2. `rtpengine accepted the offer, media session allocated...`
3. `call answered (200 OK sent, ACK received)...`

- [ ] **Checkpoint: all three lines appear, in order, for a real call.** This
      proves the trunk reaches drachtio-server, SIP signaling completes both
      ways, and rtpengine successfully allocates a media session — the actual
      goal of this milestone.

This does **not** prove audible two-way audio by itself (see the script's own
header comment for why an echo wasn't attempted here). Confirm RTP is
actually flowing with rtpengine's own tooling:

```
docker exec callio-rtpengine rtpengine-ctl list numsessions
```

- [ ] **Checkpoint: a live session shows up while the test call is active,
      and packet counters increase over the call's duration** (exact command/
      output format depends on the rtpengine build — check
      `rtpengine-ctl --help` inside the container if `list numsessions` isn't
      right for your version).

If no INVITE ever arrives at the script: check the firewall rule for
`185.231.78.58` first, then `drachtio/drachtio.conf.xml`'s `<contact>` port/transport
matches what the trunk actually sends.

If INVITE arrives but rtpengine's `offer` fails: cross-check
`rtpengine-ng-client.js`'s field names against rtpengine's own ng-protocol
docs (in its GitHub repo) — this is the piece most likely to need a fix.

## 4. Database check (same as before, blocking for Milestone B)

Against the real MySQL instance Callio uses:

```sql
SHOW CREATE TABLE call_connections;
```

- [ ] **Checkpoint: `connection_type` is not a strict `ENUM('FRONTEND',
      'WHATSAPP','MONITOR')`** (or a migration to widen it has been
      identified/planned in the Laravel monorepo).

## Once all checkpoints pass

Milestone B (the Node-side integration) can start from a proven foundation.
With this stack, Milestone B's shape changes from the FreeSWITCH plan: instead
of an ESL client and an external dialplan, Callio's own Node code becomes the
drachtio-srf application directly — `call-test.js`'s INVITE handler and the
`RtpEngineClient` here are a working reference for what that real
implementation will build on, not throwaway code to discard. See
`SIP_INTEGRATION.md` for the full Milestone B scope.
