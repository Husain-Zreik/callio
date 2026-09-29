# Observability: one shared stack per server

Every project on a server ships its logs and metrics into **one** stack,
installed in `/opt/observability`, and shows up in **one** Grafana — each
project in its own dashboard folder, its logs told apart by the `service`
label.

| Service | Does | Listens on |
|---|---|---|
| **Grafana Alloy** | ships each project's log files to Loki | 127.0.0.1:12345 |
| **Loki** | stores and indexes logs (14 days), evaluates log alerts | 127.0.0.1:3100 |
| **Prometheus** | scrapes projects' `/metrics` (15 days), evaluates metric alerts | 127.0.0.1:9090 |
| **Alertmanager** | receives the alerts, sends notifications | 127.0.0.1:9093 |
| **Grafana** | dashboards, log exploration, alerts — behind nginx at `/grafana/` | 127.0.0.1:3300 |

Everything listens on 127.0.0.1 (host networking): nothing is reachable from
outside except Grafana through nginx, behind its login.

## Layout

```
deploy/observability/            (in the Callio repo)
  install.sh                     installs/updates the stack, plugs a project in
  stack/                         the shared stack — no project knowledge
  callio/                        Callio's pieces (the shape every project uses)
    callio.alloy                 which log files to ship
    prometheus-scrape.yml        which /metrics to scrape (.local.yml for Docker Desktop)
    prometheus-alerts.yml        metric alerts
    loki-rules.yml               log alerts
    dashboards/*.json            Grafana folder "Callio" (build-dashboard.mjs builds it)

/opt/observability/              (on the server, created by install.sh)
  docker-compose.yml  .env       .env: Grafana password and URL (kept on updates)
  install.sh  .stack/            a copy, for other projects to use
  alloy/base.alloy               + alloy/<project>.alloy
  prometheus/scrape.d/<project>.yml  rules.d/<project>.yml  secrets/<project>_metrics_token
  loki/rules/fake/<project>.yml
  alertmanager/alertmanager.yml  notification receivers (kept on updates — edit here)
  grafana/dashboards/<Project>/
  nginx/grafana.conf             included by the site's nginx
```

## Install on the server (with Callio)

```bash
cd /var/www/html/callio
git pull
sudo bash deploy/observability/install.sh
pm2 restart dev_worker_1 dev_worker_2 --update-env
```

The first run asks for the Grafana admin password. It also removes the
earlier `callio-observability` containers, refuses to start if another
program holds the stack's ports (see *Old observability services*), and sets
`METRICS_TOKEN` in Callio's `.env` if it isn't set yet (hence the restart).

Publish Grafana through the site's nginx — inside the HTTPS `server { }`
block of the site that should serve it, before `location / {`:

```nginx
include /opt/observability/nginx/grafana.conf;
```

then `nginx -t && systemctl reload nginx` and open
`https://callio.pcg-ms.com/grafana/` (user `admin`). Another address:
`install.sh --grafana-url https://other.example.com/grafana/` on the first run,
or edit `GRAFANA_ROOT_URL` in `/opt/observability/.env` and
`cd /opt/observability && docker compose up -d`.

Re-run `install.sh` after pulling changes to Callio's pieces or the stack.

## Add another project

Give the project a folder with the same shape as `callio/` (only the pieces it
has), for example `/var/www/html/midlr/observability/`:

```
midlr.alloy                    required for logs
prometheus-scrape.yml          if it serves /metrics
prometheus-alerts.yml          loki-rules.yml          dashboards/*.json
```

then:

```bash
sudo /opt/observability/install.sh --project /var/www/html/midlr/observability --name midlr
```

A minimal `midlr.alloy` for a Laravel app (plain-text lines, labelled so
Grafana can tell it from the rest):

```alloy
local.file_match "midlr" {
    path_targets = [{
        __path__ = "/var/www/html/midlr/storage/logs/*.log",
        service  = "midlr",
        env      = "development",
    }]
}

loki.source.file "midlr" {
    targets    = local.file_match.midlr.targets
    forward_to = [loki.write.default.receiver]   // base.alloy
}
```

Paths are the host's paths: Alloy sees `/var/www/html` read-only
(`PROJECTS_ROOT` in `.env`). Conventions for every project — labels (few
values): `service`, `env`, `host`, `level`, `component`; ids (request, user,
call …) as fields or structured metadata, never labels.

## Old observability services

The dev server had Loki, Promtail and Grafana installed as system services,
holding the same ports. Stop and disable them (their data stays in place; this
is reversible with `systemctl enable --now`):

```bash
sudo systemctl disable --now loki promtail grafana-server
```

## Using Grafana

- **Dashboards → <Project>** — e.g. *Callio — overview*: calls, HTTP, webhooks,
  event loop, memory/CPU per worker, errors by component, a filterable log panel.
- **Explore → Logs** (Grafana 11's name for *Logs Drilldown*) — pick a service,
  then split by level / component, filter by any field (`callId` …);
  **Patterns** groups repeated messages. No queries to write.
- **Explore → Metrics** — every metric as a chart; break down by label.
- **Alerting → Alert list** — source *Alertmanager*: what is firing.

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

Thresholds are starting points — tune them in `callio/prometheus-alerts.yml` /
`callio/loki-rules.yml` and re-run `install.sh`. To be **notified**, fill a
receiver (email, Slack, Telegram, webhook) in
`/opt/observability/alertmanager/alertmanager.yml`, point `route.receiver` at
it, and `cd /opt/observability && docker compose restart alertmanager`.

## Callio's data

**Logs** — one JSON record per line
(`storage/logs/app/worker-N/YYYY-MM-DD.log`; the `.error.log` copies are not
shipped). Labels: `service`, `env`, `host`, `level`, `component`; structured
metadata: `worker`, `callId`, `providerCallId`, `tenantId`, `agentId`,
`requestId`. Every 5 minutes, on shutdown and on a crash each worker logs a
`Worker snapshot` record (CPU, memory, event loop, active calls, leak counters).

**Metrics** — `GET /metrics` on each worker, bearer `METRICS_TOKEN`
(`src/infra/monitoring/metrics.js`: calls ended by reason, talk/ring time,
HTTP by route, webhook deliveries, SIP refusals, leak gauges, Node process).

```
{service="callio", level=~"warn|error"}                         problems
{service="callio"} | callId="42"                                one call
sum by (component) (count_over_time({service="callio", level="error"}[5m]))
sum by (reason) (rate(callio_calls_ended_total[5m])) * 60        calls ended per minute
```

## On a development machine (Docker Desktop)

```bash
bash deploy/observability/install.sh --local      # into .observability/ (gitignored)
```

Grafana: http://localhost:3300 (admin / admin); it scrapes a local Callio on
3001 and the e2e runner's on 3901. A local Callio connected to the local SIP
gateway takes INVITEs away from the e2e suite — stop it before
`npm run test:e2e -- sip`.
