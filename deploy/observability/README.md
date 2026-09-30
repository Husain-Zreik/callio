# Observability: one shared stack per server

Every project on a server ships its logs and metrics into **one** stack,
installed in `/opt/observability`, and shows up in **one** Grafana — each
project in its own dashboard folder, its logs told apart by the `service`
label.

| Service | Does | Default port (`.env` variable) |
|---|---|---|
| **Grafana Alloy** | ships each project's log files to Loki | 12345 (`ALLOY_PORT`) |
| **Loki** | stores and indexes logs (14 days), evaluates log alerts | 3100 (`LOKI_PORT`) |
| **Prometheus** | scrapes projects' `/metrics` (15 days), evaluates metric alerts | 9090 (`PROMETHEUS_PORT`) |
| **Alertmanager** | receives the alerts, sends notifications | 9093 (`ALERTMANAGER_PORT`) |
| **Grafana** | dashboards, log exploration, alerts — behind nginx at `/grafana/` | 3300 (`GRAFANA_PORT`) |

Everything listens on 127.0.0.1 (host networking): nothing is reachable from
outside except Grafana through nginx, behind its login. The ports actually in
use are in `/opt/observability/.env` (install.sh prints them at the end).

## Layout

```
deploy/observability/            (in the Callio repo)
  install.sh                     installs/updates the stack, plugs a project in
  stack/                         the shared stack — no project knowledge
    server/                      the host itself: dashboard + alerts for the node / nginx exporters
  callio/                        Callio's pieces (the shape every project uses)
    callio.alloy                 which log files to ship
    prometheus-scrape.yml        which /metrics to scrape (.local.yml for Docker Desktop)
    prometheus-alerts.yml        metric alerts
    loki-rules.yml               log alerts
    dashboards/*.json            Grafana folder "Callio"
    build-dashboard.mjs          generates dashboards/callio-overview.json

/opt/observability/              (on the server, created by install.sh)
  docker-compose.yml  .env       .env: kept on updates (see below)
  install.sh  .stack/            a copy, for other projects to use
  alloy/base.alloy               + alloy/<project>.alloy
  prometheus/scrape.d/<project>.yml  rules.d/<project>.yml  secrets/<project>_metrics_token
  loki/rules/fake/<project>.yml
  alerts.sh                      where alerts are sent (email / Slack / Telegram)
  alertmanager/alertmanager.yml  written by alerts.sh (kept on updates); notify.env + secrets/ beside it
  grafana/dashboards/<Title>/    one Grafana folder per project
  nginx/grafana.conf             included by the site's nginx
```

`.env` holds `PROJECTS_ROOT` (the host folder Alloy mounts read-only at
`/var/www/html`), `GRAFANA_ADMIN_PASSWORD`, `GRAFANA_ROOT_URL`,
`GRAFANA_SUB_PATH` (`true` when served under `/grafana/`) and the five
`*_PORT` values. Edit it, then `cd /opt/observability && docker compose up -d`.

To change a dashboard, edit its generator and re-run it:
`node deploy/observability/callio/build-dashboard.mjs` (or
`stack/server/build-dashboard.mjs`), then re-run `install.sh`.

## Install on the server (with Callio)

```bash
cd /var/www/html/callio
git pull
sudo bash deploy/observability/install.sh
pm2 restart dev_worker_1 dev_worker_2 --update-env
```

The first run asks for the Grafana admin password and writes `.env`. It
removes the earlier `callio-observability` containers, and sets
`METRICS_TOKEN` in Callio's `.env` if it isn't set yet (hence the restart).

**Ports:** for each service, if another program holds the port, install.sh
picks the next free one and saves it in `.env` (and writes it into
`prometheus.yml` and `nginx/grafana.conf`). It stops only when an **old
observability service** (a system-installed Loki, Promtail, Grafana,
Prometheus, Alertmanager) holds one — see *Old observability services*.

**Callio's scrape targets:** `callio/prometheus-scrape.yml` lists one target
per worker. They must match `BASE_PORT` .. `BASE_PORT + WORKER_COUNT - 1` in
Callio's `.env` (they currently list the dev server's 3003 and 3004).

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

### install.sh options

| Option | Default | |
|---|---|---|
| `--project <dir>` | `callio/` when run from this repo | A project folder (layout below). |
| `--name <name>` | the folder's name | File names: `<name>.alloy`, `scrape.d/<name>.yml`, … |
| `--title <title>` | the name, capitalised | The Grafana dashboard folder. |
| `--target <dir>` | `/opt/observability` | Where the stack is installed. |
| `--grafana-url <url>` | `https://callio.pcg-ms.com/grafana/` | `GRAFANA_ROOT_URL`, first run only. |
| `--local` | | Docker Desktop, into `<repo>/.observability/`. |

## The server itself

When the host runs a node exporter (:9100) or an nginx exporter (:9113),
install.sh also installs `stack/server/`: scrape jobs for whichever exporters
are up, the *Server* dashboard folder, and the alerts `ServerExporterDown`,
`ServerDiskAlmostFull`, `ServerMemoryAlmostFull`, `ServerCpuSaturated`,
`NginxDown`.

## Add another project

Give the project a folder with the same shape as `callio/` (only the pieces it
has), for example `/var/www/html/myapp/observability/`:

```
myapp.alloy                    required for logs
prometheus-scrape.yml          if it serves /metrics
prometheus-alerts.yml          loki-rules.yml          dashboards/*.json
metrics-token-from             one line: the path of the project's .env holding METRICS_TOKEN
```

then:

```bash
sudo /opt/observability/install.sh --project /var/www/html/myapp/observability --name myapp
```

With `metrics-token-from`, install.sh reads `METRICS_TOKEN` from that `.env`
(generating one if it's empty) and writes it to
`prometheus/secrets/<name>_metrics_token` for the scrape's `credentials_file`.

A minimal `myapp.alloy` for an app writing plain-text log files (labelled so
Grafana can tell it from the rest):

```alloy
local.file_match "myapp" {
    path_targets = [{
        __path__ = "/var/www/html/myapp/storage/logs/*.log",
        service  = "myapp",
        env      = "development",
    }]
}

loki.source.file "myapp" {
    targets    = local.file_match.myapp.targets
    forward_to = [loki.write.default.receiver]   // base.alloy
}
```

Paths are the host's paths under `PROJECTS_ROOT`. Conventions for every
project — labels (few values): `service`, `env`, `host`, `level`, `component`;
ids (request, user, call …) as fields or structured metadata, never labels.

## Old observability services

If Loki, Promtail, Grafana or Prometheus were installed as system services,
install.sh names them and stops. Disable them (their data stays in place;
reversible with `systemctl enable --now`):

```bash
sudo systemctl disable --now loki promtail grafana-server
```

## Using Grafana

- **Dashboards → *project folder*** (e.g. *Callio*, *Server*) — *Callio —
  overview*: calls, HTTP, webhooks, event loop, memory/CPU per worker, errors
  by component, a filterable log panel.
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
| CallioManyUnansweredCalls | metrics | warning | ≥ 10 calls NO_ANSWER / TIMEOUT / IVR_AGENT_NO_ANSWER in 30 min |
| CallioWebhookDeliveriesFailing | metrics | warning | a consumer webhook was given up on |
| CallioHttpErrors | metrics | warning | > 5 % of HTTP requests are 5xx for 10 min |
| CallioEventLoopLag | metrics | warning | event loop blocked > 100 ms (p99) for 5 min |
| CallioMemoryHigh | metrics | warning | a worker above 900 MB for 10 min (PM2 restarts at 1 GB) |
| CallioStateRetainedAtIdle / CallioNativeAudioLeak | metrics | warning | call state or native audio objects left with no calls for 15 min (a leak) |
| CallioErrorLogsHigh | logs | warning | a component logs > 20 errors in 10 min |
| CallioLogRecordsDropped / CallioLogCapReached | metrics / logs | warning | logging protected the service (stalled disk, daily cap) |

Server alerts: see *The server itself*. Thresholds are starting points — tune
them in `callio/prometheus-alerts.yml` / `callio/loki-rules.yml` (or
`stack/server/prometheus-alerts.yml`) and re-run `install.sh`.

### Notifications

Alerts always show in Grafana (**Alerting → Alert list**). To be told as
well, pick one or more receivers with `alerts.sh`. Secrets are asked for
without echo and kept in `alertmanager/secrets/` (mode 600), never in the
config:

```bash
# Email (SMTP; for Gmail use an app password):
sudo /opt/observability/alerts.sh --email ops@example.com --smtp smtp.gmail.com:587 --from alerts@example.com
# Slack (an incoming webhook for the channel):
sudo /opt/observability/alerts.sh --slack '#callio-alerts'
# Telegram (a bot from @BotFather, added to the group; the group's chat id):
sudo /opt/observability/alerts.sh --telegram -1001234567890

sudo /opt/observability/alerts.sh --test      # a test alert, arrives in ~30 s
sudo /opt/observability/alerts.sh --show      # what's set
sudo /opt/observability/alerts.sh --remove slack
```

Every alert goes to every receiver that's set; critical ones repeat hourly,
the others every 4 h, and a *resolved* message follows. The script checks the
generated config with Alertmanager's own `amtool` before switching to it.
An `alertmanager.yml` edited by hand before is kept as
`alertmanager.yml.before-alerts-sh`.

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

Grafana: http://localhost:3300 (admin / admin); fixed default ports, no port
probing. It scrapes a local Callio on 3001 and the e2e runner's on 3901
(`callio/prometheus-scrape.local.yml`). A local Callio connected to the local
SIP gateway takes INVITEs away from the e2e suite — stop it before
`npm run test:e2e -- sip`.
