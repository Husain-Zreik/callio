# End-to-end tests

`npm run test:e2e` runs real calls through Callio, with WebRTC media on both
legs. There is no unit-test suite; this is how behaviour changes are verified.

```bash
docker compose -f test/e2e/docker-compose.yml up -d --wait              # MySQL 8 + Redis 7, in memory
docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d     # optional: enables the SIP suite
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
4. Checks whether the SIP gateway is up (a TCP connect to `127.0.0.1:9022`,
   drachtio's admin port). If not, `sip.test.mjs` is skipped.

For each `*.test.mjs` (sorted): truncates the call tables, sets every agent
`OFFLINE`, flushes the Redis DB, starts a fresh Callio process (waits up to
60 s for `/health`), runs the suite with `<seed.json> <callio-port>`, and stops
Callio.

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
| `TEST_DRACHTIO_SECRET` | `CHANGE_ME` | drachtio admin secret of the local SIP gateway. |
| `TEST_LOG_LEVEL` | `debug` | Callio's `LOG_LEVEL` during the suites. |

`run.mjs` also forces `CALL_TRANSFER_TIMEOUT_SECONDS=6` (so an unaccepted
transfer returns quickly), a random `CALLIO_MASTER_KEY`, local storage, and
empty AWS / OneSignal / APNs / Firebase credentials.

## Suites

| Suite | Scenarios |
|---|---|
| `calls.test.mjs` | Invalid token rejected; `session:ready` identity + ICE servers; availability over the socket; inbound WhatsApp routed ROUND_ROBIN to the longest-available agent and bridged both ways; answer moving to a reconnecting device; agent hang-up (COMPLETED/AGENT) and release; outbound intent → `call:start` → dial → answer, bridged; API terminate; agent OFFLINE after outbound; call detail API; consumer events signed and delivered once per id; provider refusing a dial (FAILED / `PROVIDER_TRIGGER_FAILED`, `call:error`); webhooks for an unowned line ignored; wrong API key rejected. |
| `routing.test.mjs` | Queue wait, then offered to the agent who became available; customer hang-up (COMPLETED/CUSTOMER); `call.queued` / `call.assigned` events; PRIORITY; RING_ALL with a decline, first accept wins, others told it was taken; supervisor monitoring (listen / whisper / barge, separate tracks), plain agent refused; transfer access check; unaccepted transfer back to the queue; transfer to another agent; IVR via API (audio asset, flow), in-band DTMF `1` into a queue, session and key press recorded. |
| `queues.test.mjs` | Ring timeout passing the offer on (missed offer logged); decline passed on and never offered back; waiting call ended by customer hang-up; lone member re-offered; max wait overflowing to another queue (logged, consumer told); max wait with no overflow ending as TIMEOUT. |
| `sdk.test.mjs` | The JS agent SDK (`sdk/agent-js`) in Node: token from `npm run agent:token`, connect, `setAvailability`; supervisor connect, `refreshSession()`; incoming Call, `accept()`, two-way audio; board and `monitor()` (listen / whisper); `hangup()`; customer hang-up; `decline()` passing the call on; reload recovering the media; another device and `switchHere()`; `startOutbound()`. |
| `react.test.mjs` | The React bindings (`sdk/agent-react`) rendered in Node: provider connects, hooks go available, show and answer the ringing call (two-way audio), mute; a supervisor's hooks show the board and monitor; hang-up clears both; unmounting disconnects. |
| `sip.test.mjs` | SIP channel provisioned via API (foreign trunk refused); inbound call as E.164, ringing, offered, 200 OK/ACK, G.711 audio both ways; agent hang-up sends BYE; caller hang-up; CANCEL while waiting; unknown number 404; max wait TIMEOUT with a final error to the carrier; IVR answering, in-band DTMF over SIP, caller giving up after the IVR (NO_ANSWER); outbound dialed through the trunk, answered, two-way audio, BYE; 486 → REJECTED/CUSTOMER; same consumer events as WhatsApp. Needs the local SIP gateway; see `docs/sip.md`. |

When you add a feature, add its scenario to a suite.
