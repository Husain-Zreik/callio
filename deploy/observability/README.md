# Observability: Loki, Prometheus, Grafana

Callio writes JSON log files and serves Prometheus metrics; this folder runs
the tools that collect and show them:

| Service | Does | Listens on (server) |
|---|---|---|
| **Grafana Alloy** | tails `storage/logs/app/worker-*/*.log` and ships each record to Loki | 127.0.0.1:12345 (status UI) |
| **Loki** | stores and indexes the logs (14 days) | 127.0.0.1:3100 |
| **Prometheus** | scrapes each worker's `/metrics` every 15 s (15 days) | 127.0.0.1:9090 |
| **Grafana** | dashboards and log search; the *Callio — overview* dashboard is provisioned | 127.0.0.1:3300 |

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

Open Grafana from your machine through an SSH tunnel:

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
