# Logging and observability

All logging code is in `src/infra/logging/`. **`policy.js` holds the rules**
(levels, field names, redaction keys, PII fields, reserved components);
`config/envConfig.js` → `logging` holds the settings (`.env.example`, section
LOGGING).

## Writing log lines

- **Never `console.*` in `src/`.** Each module takes a component logger named
  `<layer>.<area>.<File>`:

  ```js
  import { logger } from '../../infra/logging/logger.js';
  const log = logger('channels.sip.SipIngress');
  ```

  `logger.js` is the logging module the rest of `src/` imports (plus
  `policy.js` for its constants; `server/bootstrap.js` also wires
  `LogLevelControl.js`).
- **Fields first, then a short message:**
  `log.warn({ callId, providerCallId, err }, 'rtpengine offer failed')`.
  - Ids are always fields, named from `policy.FIELDS` (`callId`,
    `providerCallId`, `tenantId`, `agentId`, `queueId`, `channelId`,
    `socketId`, …), never inside the text.
  - No `[Prefix]`, no emojis.
  - Errors go in `err` (the object) so stacks survive. An expected outcome
    (a SIP 486) is a field, not an `err`.
- The e2e runner fails on `console.*`, `[Prefix]` messages and emojis in `src/`.

## Levels

| Level | Use for |
|---|---|
| `error` | Someone needs to look |
| `warn` | Unexpected, handled. Expected teardown races (`core/calls/endedDuringWork.js`) are warn, not error |
| `info` | A lifecycle step: call offered/answered/ended, leg connected, bridge started/stopped, agent connected, worker started |
| `debug` | Internal steps: peers, SDP/ICE, tracks, relays, pub/sub, ownership |
| `trace` | Per packet / frame |

A call should read as a handful of `info` lines. Anything that can repeat many
times a second goes through `throttle()`.

## Context

Call events (`RedisPubSubService`), socket events (`connectionHandler`) and HTTP
requests (`http/accessLog.js`) bind `callId` / `tenantId` / `agentId` /
`requestId` with `runWithLogContext`. Records written inside carry them without
naming them.

## What is recorded, and reading it

- Components log at `LOG_LEVEL`, overridden per prefix with
  `LOG_LEVELS=media=warn,channels.sip=debug` (longest prefix wins), or live on
  every worker with `npm run log-level -- channels.sip=debug --for 30m`
  (`--reset` to undo).
- stdout can show less than is recorded (`LOG_STDOUT_LEVEL`). Under PM2, stdout
  is off by default and PM2's own log files go to `/dev/null`.
- Files: `storage/logs/app/worker-N/YYYY-MM-DD.log` and `.error.log`, JSON.
- Read them with `npm run logs`:
  `npm run logs -- --call 42 --level warn --component channels.sip`
  (`--level info..warn` or `debug,error`, `--where queueId=3`, `--follow`,
  `--since 15m`, `--stats`, `--json`). Shortcuts: `logs:follow`, `logs:errors`,
  `logs:warn`, `logs:stats`.
- CLI scripts that import `src/` log to stderr only and write no files.

## Secrets and PII

- Secrets are redacted by key name (any case, 4 levels deep), always.
- `err` keeps only type, message, stack and codes. For HTTP-client errors it
  also keeps method, URL without query, status and a short redacted body. It
  never keeps configs, headers or sockets.
- `LOG_MASK_PII=true` masks phone numbers.

## Cost and safety

- A disabled call costs ~65 ns; a written record ~4–6 µs (async, batched writes).
- In per-frame / per-packet code, log on a cadence or once, and wrap anything
  that builds a record in `if (log.isLevelEnabled('debug'))`.
- A stalled disk drops records past a 16 MB buffer. Past `LOG_MAX_DAILY_MB` a
  worker keeps only warn and above for the rest of the day. Both are reported
  as `infra.logging` warnings.

## Metrics and the observability stack

- Records carry `service`, `env`, `host` and a text `level`, ready for Loki.
- `GET /metrics` (bearer `METRICS_TOKEN`) serves Prometheus metrics from
  `src/infra/monitoring/metrics.js`. Labels stay low-cardinality (channel,
  direction, reason, route template), never ids.
- Worker resource and leak snapshots (`infra.monitoring.WorkerStatsService`) are
  log records and Prometheus gauges, not separate files.
- `deploy/observability/` is the server's shared stack (Alloy, Loki, Prometheus,
  Alertmanager, Grafana) and Callio's pieces for it: see
  [deploy/observability/README.md](../deploy/observability/README.md).
