# End-to-end tests

`npm run test:e2e` runs real calls through Callio, with WebRTC media on both
legs:

- **fake Meta Graph API** (port 3990) — receives Callio's accept / terminate /
  connect calls and answers like Meta, including follow-up webhooks;
- **simulated WhatsApp customers** — `wrtc` peers that post Meta-shaped
  webhooks and send a 440 Hz tone;
- **simulated agents** — Socket.IO clients with consumer-signed JWTs and `wrtc`
  peers sending their own tones (880 / 660 Hz), so every audio check proves
  who is actually bridged to whom;
- **consumer event receiver** (port 3999) — verifies the signature of every
  event Callio delivers.

`run.mjs` drops and recreates the test database (`callio_test` by default),
migrates and seeds it, then for each `*.test.mjs` resets call state, starts a
fresh Callio process, runs the suite and stops Callio. Callio's logs are kept
in a temp directory printed at the end.

```bash
docker compose -f test/e2e/docker-compose.yml up -d
npm run test:e2e              # all suites
npm run test:e2e -- routing   # suites whose file name contains "routing"
```

Connection settings: `TEST_DB_HOST/PORT/USERNAME/PASSWORD/DATABASE`,
`TEST_REDIS_HOST/PORT/DB`, `TEST_CALLIO_PORT` (defaults match the compose file).

| Suite | Covers |
|---|---|
| `calls.test.mjs` | agent auth, inbound routing and bridging, hang-up, outbound intent → `call:start` → dial, API terminate, call detail, consumer events, isolation |
| `routing.test.mjs` | queue wait and drain, customer hang-up, PRIORITY, RING_ALL with decline and taken offers, supervisor monitoring, transfer, access checks, IVR with in-band DTMF |
| `queues.test.mjs` | ring timeout passing an offer on, a decline passed on and never offered back, a lone member re-offered, max wait overflowing to another queue, max wait ending the call as TIMEOUT |
| `sip.test.mjs` | the SIP channel through the local gateway with a fake carrier (`sipCarrier.mjs`, G.711 RTP): inbound bridged with audio both ways, hang-up from either side, CANCEL, unknown number, queue timeout, IVR with in-band DTMF, outbound answered and declined. Runs only when `deploy/sip-gateway/docker-compose.local.yml` is up; skipped otherwise. |
