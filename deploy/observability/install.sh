#!/usr/bin/env bash
# Installs / updates the server's shared observability stack and plugs a
# project into it. Safe to re-run: stack files are refreshed, files you edit
# (.env, alertmanager/alertmanager.yml) are kept.
#
#   From the Callio repo (installs the stack + Callio):
#     sudo deploy/observability/install.sh
#   Another project later (its folder has the same layout as callio/ here):
#     sudo /opt/observability/install.sh --project /var/www/html/midlr/observability --name midlr
#   A development machine (Docker Desktop), into <repo>/.observability:
#     bash deploy/observability/install.sh --local
#
# A project folder may contain (all optional):
#   <name>.alloy               log files to ship (forward to loki.write.default.receiver)
#   prometheus-scrape.yml      scrape jobs (prometheus-scrape.local.yml for --local)
#   prometheus-alerts.yml      metric alert rules
#   loki-rules.yml             log alert rules
#   dashboards/*.json          Grafana dashboards (folder named after --title or the name)
#   metrics-token-from         path to the project's .env holding METRICS_TOKEN
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL=false
TARGET=/opt/observability
PROJECT_DIR=""
NAME=""
TITLE=""
GRAFANA_URL="https://callio.pcg-ms.com/grafana/"

while [ $# -gt 0 ]; do
    case "$1" in
        --local) LOCAL=true; shift ;;
        --target) TARGET="$2"; shift 2 ;;
        --project) PROJECT_DIR="$2"; shift 2 ;;
        --name) NAME="$2"; shift 2 ;;
        --title) TITLE="$2"; shift 2 ;;
        --grafana-url) GRAFANA_URL="$2"; shift 2 ;;
        -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
    esac
done

# The stack's own files: next to this script in the repo (stack/), or the copy
# kept in the installed stack (.stack/) when run as /opt/observability/install.sh.
if [ -d "$HERE/stack" ]; then STACK="$HERE/stack"; else STACK="$HERE/.stack"; fi
[ -d "$STACK" ] || { echo "Stack files not found next to $0"; exit 1; }

# Default project: Callio, when run from its repo.
if [ -z "$PROJECT_DIR" ] && [ -d "$HERE/callio" ]; then
    PROJECT_DIR="$HERE/callio"; NAME="callio"; TITLE="Callio"
fi
if $LOCAL && [ "$TARGET" = /opt/observability ]; then TARGET="$(cd "$HERE/../.." && pwd)/.observability"; fi
[ -n "$PROJECT_DIR" ] && [ -z "$NAME" ] && NAME="$(basename "$PROJECT_DIR")"
[ -z "$TITLE" ] && TITLE="$(printf '%s' "${NAME:0:1}" | tr '[:lower:]' '[:upper:]')${NAME:1}"

say() { printf '\033[36m[observability]\033[0m %s\n' "$*"; }

# ── 1. The stack ────────────────────────────────────────────────────────────
say "stack → $TARGET"
mkdir -p "$TARGET"/{alloy,loki/rules/fake,prometheus/scrape.d,prometheus/rules.d,prometheus/secrets,alertmanager,grafana/dashboards,nginx,.stack}
if $LOCAL; then
    cp "$STACK/docker-compose.local.yml" "$TARGET/docker-compose.yml"
    cp "$STACK/prometheus/prometheus.local.yml" "$TARGET/prometheus/prometheus.yml"
else
    cp "$STACK/docker-compose.yml" "$TARGET/docker-compose.yml"
    cp "$STACK/prometheus/prometheus.yml" "$TARGET/prometheus/prometheus.yml"
fi
cp "$STACK/loki/loki.yml" "$TARGET/loki/loki.yml"
cp "$STACK/alloy/base.alloy" "$TARGET/alloy/base.alloy"
cp "$STACK/nginx/grafana.conf" "$TARGET/nginx/grafana.conf"
rm -rf "$TARGET/grafana/provisioning" && cp -r "$STACK/grafana-provisioning" "$TARGET/grafana/provisioning"
[ -f "$TARGET/alertmanager/alertmanager.yml" ] || cp "$STACK/alertmanager/alertmanager.yml" "$TARGET/alertmanager/alertmanager.yml"
# Keep a copy of the stack and this script with the installation, for other projects.
if [ "$STACK" != "$TARGET/.stack" ]; then
    rm -rf "$TARGET/.stack" && cp -r "$STACK" "$TARGET/.stack"
    cp "$0" "$TARGET/install.sh" && chmod +x "$TARGET/install.sh"
fi

# .env (kept once written)
if [ ! -f "$TARGET/.env" ]; then
    if $LOCAL; then
        # Alloy mounts the folder holding the projects at /var/www/html.
        ROOT="$(cd "$HERE/../../.." && { pwd -W 2>/dev/null || pwd; })"
        printf 'PROJECTS_ROOT=%s\n' "$ROOT" > "$TARGET/.env"
    else
        read -rsp "Grafana admin password (you will log in with admin / this): " GP; echo
        [ -n "$GP" ] || { echo "A password is required."; exit 1; }
        printf 'PROJECTS_ROOT=/var/www/html\nGRAFANA_ADMIN_PASSWORD=%s\nGRAFANA_ROOT_URL=%s\nGRAFANA_SUB_PATH=true\n' "$GP" "$GRAFANA_URL" > "$TARGET/.env"
        chmod 600 "$TARGET/.env"
    fi
    say "wrote $TARGET/.env"
fi

# ── 2. The project ──────────────────────────────────────────────────────────
if [ -n "$PROJECT_DIR" ]; then
    say "project $NAME ← $PROJECT_DIR"
    [ -f "$PROJECT_DIR/$NAME.alloy" ] && cp "$PROJECT_DIR/$NAME.alloy" "$TARGET/alloy/$NAME.alloy"
    SCRAPE="$PROJECT_DIR/prometheus-scrape.yml"
    $LOCAL && [ -f "$PROJECT_DIR/prometheus-scrape.local.yml" ] && SCRAPE="$PROJECT_DIR/prometheus-scrape.local.yml"
    [ -f "$SCRAPE" ] && cp "$SCRAPE" "$TARGET/prometheus/scrape.d/$NAME.yml"
    [ -f "$PROJECT_DIR/prometheus-alerts.yml" ] && cp "$PROJECT_DIR/prometheus-alerts.yml" "$TARGET/prometheus/rules.d/$NAME.yml"
    [ -f "$PROJECT_DIR/loki-rules.yml" ] && cp "$PROJECT_DIR/loki-rules.yml" "$TARGET/loki/rules/fake/$NAME.yml"
    if [ -d "$PROJECT_DIR/dashboards" ]; then
        rm -rf "$TARGET/grafana/dashboards/$TITLE" && mkdir -p "$TARGET/grafana/dashboards/$TITLE"
        cp "$PROJECT_DIR"/dashboards/*.json "$TARGET/grafana/dashboards/$TITLE/"
    fi

    # The project's /metrics token (Callio: METRICS_TOKEN in its .env; created if missing).
    ENV_FILE=""
    [ -f "$PROJECT_DIR/metrics-token-from" ] && ENV_FILE="$(cat "$PROJECT_DIR/metrics-token-from")"
    [ "$NAME" = callio ] && ENV_FILE="$(cd "$HERE/../.." && pwd)/.env"
    if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
        TOKEN="$(grep -E '^METRICS_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
        if [ -z "$TOKEN" ]; then
            TOKEN="$(openssl rand -hex 24 2>/dev/null || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
            if grep -qE '^METRICS_TOKEN=' "$ENV_FILE"; then sed -i "s/^METRICS_TOKEN=.*/METRICS_TOKEN=$TOKEN/" "$ENV_FILE"
            else printf '\nMETRICS_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"; fi
            say "set METRICS_TOKEN in $ENV_FILE — restart the project so /metrics uses it"
        fi
        printf %s "$TOKEN" > "$TARGET/prometheus/secrets/${NAME}_metrics_token"
        if ! $LOCAL; then chown 65534:65534 "$TARGET/prometheus/secrets/${NAME}_metrics_token"; chmod 600 "$TARGET/prometheus/secrets/${NAME}_metrics_token"; fi
    fi
fi

# ── 3. Start / refresh ──────────────────────────────────────────────────────
if ! $LOCAL; then
    # The first layout ran from the Callio repo as project "callio-observability".
    if [ -n "$(docker ps -a --filter label=com.docker.compose.project=callio-observability -q)" ]; then
        say "removing the earlier callio-observability containers"
        docker compose -p callio-observability down --remove-orphans >/dev/null 2>&1 || true
    fi
    # Ports the stack needs must be free (or already ours).
    OURS="$(docker ps --filter label=com.docker.compose.project=observability -q | wc -l)"
    BUSY=""
    for p in 3100 9090 9093 3300 12345; do
        line="$(ss -ltnpH "sport = :$p" 2>/dev/null | head -1)"
        if [ -n "$line" ] && [ "$OURS" = 0 ]; then BUSY="$BUSY\n  :$p  $line"; fi
    done
    if [ -n "$BUSY" ]; then
        printf "Ports the stack needs are in use:%b\nStop those first (README.md, 'Old observability services').\n" "$BUSY"
        exit 1
    fi
fi
say "starting"
(cd "$TARGET" && docker compose up -d --remove-orphans)
(cd "$TARGET" && docker compose restart alloy prometheus loki >/dev/null)
say "done — Grafana: $($LOCAL && echo http://localhost:3300 || echo "$GRAFANA_URL")"
