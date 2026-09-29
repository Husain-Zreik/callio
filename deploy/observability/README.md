# Observability: Loki, Prometheus, Grafana

Callio writes JSON log files and serves Prometheus metrics; this folder runs
the tools that collect and show them:

| Service | Does | Listens on (server) |
|---|---|---|
| **Grafana Alloy** | tails `storage/logs/app/worker-*/*.log` and ships each record to Loki | 127.0.0.1:12345 (status UI) |
| **Loki** | stores and indexes the logs (14 days) | 127.0.0.1:3100 |
| **Prometheus** | scrapes each worker's `/metrics` every 15 s (15 days), evaluates the metric alerts | 127.0.0.1:9090 |
| **Alertmanager** | receives the alerts (from Prometheus and Loki) and sends notifications | 127.0.0.1:9093 |
| **Grafana** | dashboards, log search, alert list; the *Callio — overview* dashboard is provisioned | 127.0.0.1:3300 |

`docker-compose.yml` is for the Callio server (host networking, everything on
127.0.0.1, host firewall untouched). `docker-compose.local.yml` is the same
stack for Docker Desktop against a local Callio.

## What Callio provides

**Logs** — one JSON record per line, e.g.

```json
{"level":"info","time":"2026-09-29T10:07:57.777Z","service":"callio","env":"development","host":"srv1","worker":2,"component":"core.calls.CallTerminator","callId":42,"msg":"Call ended — COMPLETED/AGENT (agent_or_api)"}
```

Alloy turns `service`, `env`, `host`, `level`, `component` into Loki labels
(few values each) and `worker`, `callId`, `providerCallId`, `tenantId`,
`agentId`, `requestId` into structured metadata (searchable, not indexed —
ids must never be labels). The `.error.log` files repeat the error records
and are not shipped.

**Metrics** — `GET /metrics` on each worker, bearer token `METRICS_TOKEN`
(unset = endpoint off). Series and labels: `src/infra/monitoring/metrics.js`.

## On the Callio server

```bash
cd /var/www/html/callio

# 1. A token for /metrics, shared by Callio and Prometheus
TOKEN=$(openssl rand -hex 24)
grep -q '^METRICS_TOKEN=' .env && sed -i "s/^METRICS_TOKEN=.*/METRICS_TOKEN=$TOKEN/" .env || echo "METRICS_TOKEN=$TOKEN" >> .env
printf %s "$TOKEN" > deploy/observability/prometheus/metrics_token
pm2 restart dev_worker_1 dev_worker_2 --update-env

# 2. Grafana's admin password
read -rsp "Grafana admin password: " GP; echo
echo "GRAFANA_ADMIN_PASSWORD=$GP" > deploy/observability/.env

# 3. Start the stack
docker compose -f deploy/observability/docker-compose.yml up -d
```

`prometheus/prometheus.yml` scrapes `127.0.0.1:3003` and `127.0.0.1:3004`
(BASE_PORT=3003, two workers); change the targets if those differ.

Open Grafana in the browser at `https://<domain>/grafana/` through the
site's nginx (behind Grafana's login): add
`include /var/www/html/callio/deploy/observability/nginx/grafana.conf;` to the
site's HTTPS `server { }` block, put
`GRAFANA_ROOT_URL=https://<domain>/grafana/` and `GRAFANA_SUB_PATH=true` in
`deploy/observability/.env`, recreate Grafana and reload nginx. Or, without
exposing it, through an SSH tunnel:

```bash
ssh -L 3300:127.0.0.1:3300 root@callio.pcg-ms.com
```

then http://localhost:3300 (user `admin`).

Check it's working:

```bash
curl -s -H "authorization: Bearer $(cat deploy/observability/prometheus/metrics_token)" 127.0.0.1:3003/metrics | head
curl -s 127.0.0.1:9090/api/v1/targets | grep -o '"health":"[a-z]*"'
curl -s -G 127.0.0.1:3100/loki/api/v1/query --data-urlencode 'query=sum by (level) (count_over_time({service="callio"}[1h]))'
```

## Alerts

| Alert | From | Severity | Fires when |
|---|---|---|---|
| CallioWorkerDown | metrics | critical | a worker doesn't answer `/metrics` for 2 min |
| CallioCallsFailing | metrics | critical | ≥ 3 calls end on SYSTEM_ERROR / NETWORK_ERROR / PROVIDER_ERROR / AGENT_MEDIA_NOT_READY / CUSTOMER_NETWORK_LOSS in 15 min |
| CallioFatal | logs | critical | a `fatal` record (a worker crashed) |
| CallioAgentStuck | logs | critical | "AGENT STUCK" — an agent couldn't be released after a call |
| CallioWorkerRestarted | metrics | warning | a worker restarted (crash, memory limit, deploy) |
| CallioManyUnansweredCalls | metrics | warning | ≥ 10 calls NO_ANSWER / TIMEOUT in 30 min |
| CallioWebhookDeliveriesFailing | metrics | warning | a consumer webhook was given up on |
| CallioHttpErrors | metrics | warning | > 5 % of HTTP requests are 5xx for 10 min |
| CallioEventLoopLag | metrics | warning | event loop blocked > 100 ms (p99) for 5 min |
| CallioMemoryHigh | metrics | warning | a worker above 900 MB for 10 min (PM2 restarts at 1 GB) |
| CallioStateRetainedAtIdle / CallioNativeAudioLeak | metrics | warning | call state or native audio objects left with no calls for 15 min (a leak) |
| CallioErrorLogsHigh | logs | warning | a component logs > 20 errors in 10 min |
| CallioLogRecordsDropped / CallioLogCapReached | metrics / logs | warning | logging protected the service (stalled disk, daily cap) |

Rules: `prometheus/alerts.yml` and `loki/rules/fake/callio.yml` — thresholds
are starting points; tune them to real traffic. Alerts show in Grafana
(Alerting → Alert list, Alertmanager) without any setup. To be **notified**,
fill a receiver (email, Slack, Telegram, webhook) in
`alertmanager/alertmanager.yml`, set `route.receiver` to it, and
`docker compose -f deploy/observability/docker-compose.yml restart alertmanager`.

## Worker snapshots

Every 5 minutes, on shutdown and on a crash each worker logs one
`Worker snapshot` record (component `infra.monitoring.WorkerStatsService`):
CPU, memory, event-loop delay, active calls and recordings, and the leak
counters (native audio objects, per-call state retained, timers, threads).
The same numbers are `/health` and, over time, the leak gauges in Prometheus.

```bash
npm run -s logs -- --component infra.monitoring --since 1h
```

## Querying

Logs (Grafana → Explore → Loki):

```
{service="callio", env="development"}                          everything
{service="callio", level=~"warn|error"}                         problems
{service="callio", component=~"channels.sip.*"}                 one part of the system
{service="callio"} | callId="42"                                one call
{service="callio"} | json | status >= 500                       any JSON field
sum by (component) (count_over_time({service="callio", level="error"}[5m]))
```

Metrics (Grafana → Explore → Prometheus):

```
sum by (reason) (rate(callio_calls_ended_total[5m])) * 60        calls ended per minute, by outcome
histogram_quantile(0.95, sum by (le) (rate(callio_call_duration_seconds_bucket[1h])))
sum(callio_media_calls_active)                                   calls with media now
sum(increase(callio_webhook_deliveries_total{result="failed"}[1h]))
max(callio_nodejs_eventloop_lag_p99_seconds)                     worker responsiveness
```

## Local (Docker Desktop)

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > deploy/observability/prometheus/metrics_token
# put the same value in .env as METRICS_TOKEN, then start Callio (npm run dev)
docker compose -f deploy/observability/docker-compose.local.yml up -d
```

Grafana: http://localhost:3300 (admin / admin). A local Callio connected to
the local SIP gateway takes INVITEs away from the e2e suite — stop it before
`npm run test:e2e -- sip`.
