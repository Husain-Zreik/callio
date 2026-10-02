# End-to-end tests

`npm run test:e2e` runs real calls through Callio and its media plane, with
WebRTC (or G.711 RTP, for SIP) on every leg. There is no unit-test suite; this
is how behaviour changes are verified.

```bash
docker compose -f test/e2e/docker-compose.yml up -d --wait                    # MySQL 8 + Redis 7, in memory
docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d --build   # the media plane: drachtio, rtpengine, FreeSWITCH
npm run test:e2e                # all suites
npm run test:e2e -- routing     # suites whose file name contains "routing"
```

## What takes part

| Piece | Where | What it does |
|---|---|---|
| Fake Meta Graph API | `lib.mjs` `fakeMeta()`, port 3990 | Receives Callio's accept / terminate / connect calls and answers like Meta, including follow-up webhooks. Dials to `UNREACHABLE_NUMBER` fail. |
| Simulated WhatsApp customers | `lib.mjs` | `wrtc` peers that post Meta-shaped webhooks and send a 440 Hz tone. |
| Simulated agents | `lib.mjs` `connectAgent()` | Socket.IO clients with consumer-signed JWTs and `wrtc` peers sending their own tones (880 / 660 Hz), so every audio check (Goertzel, `listen()`) proves who is bridged to whom. |
| Consumer event receiver | `lib.mjs` `eventReceiver()`, port 3999 | Verifies the signature of every event Callio delivers. |
| Fake S3 | `lib.mjs` `fakeS3()`, port 3995, inside `run.mjs` | Path-style S3 (head bucket, put/get/delete, multipart), in memory, signatures unchecked. Recordings upload to it and the suites read them back through the API's signed URL. |
| The media plane | `deploy/sip-gateway/docker-compose.local.yml` | drachtio (:9022), rtpengine (:22222, RTP 30000–30099), FreeSWITCH (event socket :8021). Every suite's calls run through it. FreeSWITCH reaches Callio (its audio route, event-socket callbacks on Callio's port + 1000) and the fake S3 at `host.docker.internal`. |
| Fake SIP carrier | `sipCarrier.mjs`, UDP 5070 | A minimal SIP user agent plus G.711 μ-law RTP: calls into Callio through the local gateway like a trunk, and answers the calls Callio dials out. |

## What `run.mjs` does

**One run at a time.** Every run recreates the same database and uses the
same ports, so `run.mjs` holds a lock (listening on `TEST_LOCK_PORT`, 3899)
for the whole run. A second run prints that it is waiting and starts when the
first ends (up to 15 minutes). The OS frees the lock however a run ends.

Before any suite:

1. **Logging rules over `src/`** (outside `src/infra/logging/`): fails on
   `console.*`, a log message starting with `[Prefix]`, or an emoji in a log message.
2. **Logger guarantees** — `loggingCheck.mjs` in a child process: text level
   and `service`/`env`/`host`, context propagation, redaction (deep,
   case-insensitive), HTTP-client error trimming, prefix levels, `throttle()`,
   the daily cap; it runs `loggingThreadCheck.mjs` to check worker threads
   follow level changes.
3. Drops and recreates the test database, runs `migrate:latest`, and seeds it
   with `scripts/seed-dev.js` (WhatsApp channel, SIP DID `+96170000001` on a
   trunk pointing at the fake carrier via `host.docker.internal:5070`).
4. Checks that the media plane is up (TCP connects to drachtio `127.0.0.1:9022`
   and FreeSWITCH `127.0.0.1:8021`); stops with a hint if not.

For each `*.test.mjs` (sorted): truncates the call tables, sets every agent
`OFFLINE`, flushes the Redis DB, starts a fresh Callio process (waits up to
60 s for `/health` to report `media.connected`), runs the suite with
`<seed.json> <callio-port>`, and stops Callio. Stopping Callio doesn't hang up
its media-server endpoints; flushing Redis drops its boot id, so the next
Callio's orphan sweep hangs them up at start.

After each suite it scans that suite's Callio log for
`unhandled|exception|is not a function|unknown column|doesn't exist|AGENT STUCK`
(case-insensitive); any hit fails the suite even if its checks passed. Logs
(`<suite>.callio.log`, pretty format) are kept in a temp directory printed at the end.

## Environment

| Variable | Default | |
|---|---|---|
| `TEST_DB_HOST` / `PORT` / `USERNAME` / `PASSWORD` / `DATABASE` | `127.0.0.1` / `33306` / `root` / `callio` / `callio_test` | Matches the compose file. |
| `TEST_REDIS_HOST` / `PORT` / `DB` | `127.0.0.1` / `36379` / `15` | |
| `TEST_CALLIO_PORT` | `3901` | |
| `TEST_LOCK_PORT` | `3899` | The one-run-at-a-time lock. |
| `TEST_S3_PORT` | `3995` | The fake S3. |
| `TEST_DRACHTIO_SECRET` | `CHANGE_ME` | drachtio admin secret of the local SIP gateway. |
| `TEST_FREESWITCH_PASSWORD` | `CHANGE_ME` | FreeSWITCH event-socket password of the local media plane. |
| `TEST_DOCKER_HOST` | `host.docker.internal` | How the media plane's containers reach this machine. |
| `TEST_LOG_LEVEL` | `debug` | Callio's `LOG_LEVEL` during the suites. |

`run.mjs` also forces `CALL_TRANSFER_TIMEOUT_SECONDS=6` (so an unaccepted
transfer returns quickly), a random `CALLIO_MASTER_KEY`, local storage, object
storage pointed at the fake S3 (`AWS_ENDPOINT`, path-style), the media plane
(`DRACHTIO_*`, `RTPENGINE_*`, `FREESWITCH_*`, `MEDIA_*`), Callio listening on
all interfaces (`NODE_HOST=0.0.0.0`, for FreeSWITCH), and empty OneSignal /
APNs / Firebase credentials. Suites run as async child processes,
so the fake S3 in `run.mjs` keeps answering while they do.

## Suites

| Suite | Scenarios |
|---|---|
| `calls.test.mjs` | Invalid token rejected; `session:ready` identity + ICE servers; availability over the socket; inbound WhatsApp routed ROUND_ROBIN to the longest-available agent and bridged both ways; answer moving to a reconnecting device; agent hang-up (COMPLETED/AGENT) and release; outbound intent → `call:start` → dial → answer, bridged; API terminate; agent OFFLINE after outbound; call detail API; consumer events signed and delivered once per id; provider refusing a dial (FAILED / `PROVIDER_TRIGGER_FAILED`, `call:error`); webhooks for an unowned line ignored; wrong API key rejected. |
| `routing.test.mjs` | Queue wait, then offered to the agent who became available; customer hang-up (COMPLETED/CUSTOMER); `call.queued` / `call.assigned` events; PRIORITY; RING_ALL with a decline, first accept wins, others told it was taken; supervisor monitoring (the room mixed on one line, a second line answered as rejected; listen / whisper / barge / agent-private), plain agent refused; transfer access check; unaccepted transfer back to the queue; transfer to another agent; IVR via API (audio asset, flow), in-band DTMF `1` into a queue, session and key press recorded. |
| `media.test.mjs` | The media features the media-plane migration must keep ([media-architecture.md](../../docs/media-architecture.md#feature-parity)): a recorded call's customer-quality events; the recording saved, downloaded through the API, decoded, with the customer (440 Hz) on its channel and the agent (880 Hz) on the other; the agent dropping, the customer hearing the reconnect tone (600/750/900 Hz) and the call staying up, then the agent reconnecting and heard again; queue hold music after an IVR transfer while the agent rings, stopping when they answer. |
| `queues.test.mjs` | Ring timeout passing the offer on (missed offer logged); decline passed on and never offered back; waiting call ended by customer hang-up; lone member re-offered; max wait overflowing to another queue (logged, consumer told); max wait with no overflow ending as TIMEOUT. |
| `sdk.test.mjs` | The JS agent SDK (`sdk/agent-js`) in Node: token from `npm run agent:token`, connect, `setAvailability`; supervisor connect, `refreshSession()`; incoming Call, `accept()`, two-way audio; board and `monitor()` (listen / whisper); `hangup()`; customer hang-up; `decline()` passing the call on; reload recovering the media; another device and `switchHere()`; `startOutbound()`. |
| `react.test.mjs` | The React bindings (`sdk/agent-react`) rendered in Node: provider connects, hooks go available, show and answer the ringing call (two-way audio), mute; a supervisor's hooks show the board and monitor; hang-up clears both; unmounting disconnects. |
| `sip.test.mjs` | SIP channel provisioned via API (foreign trunk refused); inbound call as E.164, ringing, offered, 200 OK/ACK, G.711 audio both ways; agent hang-up sends BYE; caller hang-up; CANCEL while waiting; unknown number 404; max wait TIMEOUT with a final error to the carrier; IVR answering, in-band DTMF over SIP, caller giving up after the IVR (NO_ANSWER); outbound dialed through the trunk, answered, two-way audio, BYE; 486 → REJECTED/CUSTOMER; same consumer events as WhatsApp. Needs the local SIP gateway; see `docs/sip.md`. |

When you add a feature, add its scenario to a suite.
