#!/usr/bin/env bash
# Installs / updates the server's shared observability stack and plugs a
# project into it. Safe to re-run: stack files are refreshed, files you edit
# (.env, alertmanager/alertmanager.yml) are kept. Alert notifications
# (email / Slack / Telegram): /opt/observability/alerts.sh --help.
#
#   From the Callio repo (installs the stack + Callio):
#     sudo bash deploy/observability/install.sh
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
#
# Ports (in /opt/observability/.env): LOKI_PORT 3100, PROMETHEUS_PORT 9090,
# ALERTMANAGER_PORT 9093, GRAFANA_PORT 3300, ALLOY_PORT 12345. When another
# program holds one, the next free port is chosen and saved; when an old
# observability service holds it, the script stops and names it.
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
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
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
[ -n "$NAME" ] && [ -z "$TITLE" ] && TITLE="$(printf '%s' "${NAME:0:1}" | tr '[:lower:]' '[:upper:]')${NAME:1}"

say() { printf '\033[36m[observability]\033[0m %s\n' "$*"; }
ENVF="$TARGET/.env"
getenv() { [ -f "$ENVF" ] && grep -E "^$1=" "$ENVF" | tail -1 | cut -d= -f2- || true; }
setenv() {
    if grep -qE "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else printf '%s=%s\n' "$1" "$2" >> "$ENVF"; fi
}

# ── 1. The stack ────────────────────────────────────────────────────────────
say "stack → $TARGET"
mkdir -p "$TARGET"/{alloy,loki/rules/fake,prometheus/scrape.d,prometheus/rules.d,prometheus/secrets,alertmanager,grafana/dashboards,nginx}
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
# Where alerts are sent (email / Slack / Telegram): /opt/observability/alerts.sh
cp "$STACK/alerts.sh" "$TARGET/alerts.sh" && chmod +x "$TARGET/alerts.sh"
mkdir -p "$TARGET/alertmanager/secrets"
$LOCAL || { chown 65534:65534 "$TARGET/alertmanager/secrets"; chmod 700 "$TARGET/alertmanager/secrets"; }

# .env (kept once written)
if [ ! -f "$ENVF" ]; then
    if $LOCAL; then
        # Alloy mounts the folder holding the projects at /var/www/html.
        ROOT="$(cd "$HERE/../../.." && { pwd -W 2>/dev/null || pwd; })"
        printf 'PROJECTS_ROOT=%s\n' "$ROOT" > "$ENVF"
    else
        read -rsp "Grafana admin password (you will log in with admin / this): " GP; echo
        [ -n "$GP" ] || { echo "A password is required."; exit 1; }
        printf 'PROJECTS_ROOT=/var/www/html\nGRAFANA_ADMIN_PASSWORD=%s\nGRAFANA_ROOT_URL=%s\nGRAFANA_SUB_PATH=true\n' "$GP" "$GRAFANA_URL" > "$ENVF"
        chmod 600 "$ENVF"
    fi
    say "wrote $ENVF"
fi

# ── 2. Ports (server) ───────────────────────────────────────────────────────
OLD_SERVICES='^(prometheus|loki|promtail|grafana|grafana-server|alertmanager|prometheus-alert)'
OURS="$(docker ps --filter label=com.docker.compose.project=observability -q | wc -l)"
port_owner() { ss -ltnpH "sport = :$1" 2>/dev/null | head -1; }
in_container() { grep -qE 'docker|containerd' "/proc/$1/cgroup" 2>/dev/null; }

if ! $LOCAL; then
    # The first layout ran from the Callio repo as project "callio-observability".
    if [ -n "$(docker ps -a --filter label=com.docker.compose.project=callio-observability -q)" ]; then
        say "removing the earlier callio-observability containers"
        docker compose -p callio-observability down --remove-orphans >/dev/null 2>&1 || true
    fi
    BLOCKED=""
    for spec in LOKI_PORT:3100 PROMETHEUS_PORT:9090 ALERTMANAGER_PORT:9093 GRAFANA_PORT:3300 ALLOY_PORT:12345; do
        VAR="${spec%%:*}"; PORT="$(getenv "$VAR")"; PORT="${PORT:-${spec##*:}}"
        line="$(port_owner "$PORT")"
        [ -z "$line" ] && { setenv "$VAR" "$PORT"; continue; }
        prog="$(printf '%s' "$line" | sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\1/p')"
        pid="$(printf '%s' "$line" | sed -n 's/.*users:(("[^"]*",pid=\([0-9]*\).*/\1/p')"
        if [ "$OURS" != 0 ] && in_container "$pid"; then setenv "$VAR" "$PORT"; continue; fi   # our running stack
        if printf '%s' "$prog" | grep -qE "$OLD_SERVICES" && ! in_container "$pid"; then
            unit="$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ')"
            { [ -z "$unit" ] || [ "$unit" = - ]; } && unit="$prog"
            BLOCKED="$BLOCKED\n  :$PORT is held by the old '$prog' service (pid $pid) — stop it: sudo systemctl disable --now $unit"
            continue
        fi
        NEXT=$((PORT + 1)); while [ -n "$(port_owner "$NEXT")" ]; do NEXT=$((NEXT + 1)); done
        say "port $PORT is used by '$prog' (pid $pid) — $VAR=$NEXT instead (saved in $ENVF)"
        setenv "$VAR" "$NEXT"
    done
    if [ -n "$BLOCKED" ]; then printf "Stop the old observability services first:%b\n" "$BLOCKED"; exit 1; fi

    # Files that can't read .env get the chosen ports written in.
    sed -i "s|127.0.0.1:9093|127.0.0.1:$(getenv ALERTMANAGER_PORT)|" "$TARGET/prometheus/prometheus.yml"
    sed -i "s|127.0.0.1:3300|127.0.0.1:$(getenv GRAFANA_PORT)|" "$TARGET/nginx/grafana.conf"
fi

# ── 3. Projects ─────────────────────────────────────────────────────────────
install_project() {   # dir name title
    local dir="$1" name="$2" title="$3" scrape
    say "project $name ← $dir"
    [ -f "$dir/$name.alloy" ] && cp "$dir/$name.alloy" "$TARGET/alloy/$name.alloy"
    scrape="$dir/prometheus-scrape.yml"
    $LOCAL && [ -f "$dir/prometheus-scrape.local.yml" ] && scrape="$dir/prometheus-scrape.local.yml"
    [ -f "$scrape" ] && cp "$scrape" "$TARGET/prometheus/scrape.d/$name.yml"
    [ -f "$dir/prometheus-alerts.yml" ] && cp "$dir/prometheus-alerts.yml" "$TARGET/prometheus/rules.d/$name.yml"
    [ -f "$dir/loki-rules.yml" ] && cp "$dir/loki-rules.yml" "$TARGET/loki/rules/fake/$name.yml"
    if [ -d "$dir/dashboards" ]; then
        rm -rf "$TARGET/grafana/dashboards/$title" && mkdir -p "$TARGET/grafana/dashboards/$title"
        cp "$dir"/dashboards/*.json "$TARGET/grafana/dashboards/$title/"
    fi
    return 0
}

# The server itself, when its exporters run on the host (node :9100, nginx :9113).
if ! $LOCAL && { [ -n "$(port_owner 9100)" ] || [ -n "$(port_owner 9113)" ]; }; then
    install_project "$STACK/server" server Server
    {
        echo "# The host's exporters (written by install.sh)."
        echo "scrape_configs:"
        [ -n "$(port_owner 9100)" ] && printf "  - job_name: node\n    static_configs:\n      - targets: ['127.0.0.1:9100']\n"
        [ -n "$(port_owner 9113)" ] && printf "  - job_name: nginx\n    static_configs:\n      - targets: ['127.0.0.1:9113']\n"
        true
    } > "$TARGET/prometheus/scrape.d/server.yml"
fi

if [ -n "$PROJECT_DIR" ]; then
    install_project "$PROJECT_DIR" "$NAME" "$TITLE"

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

# ── 4. Start / refresh ──────────────────────────────────────────────────────
say "starting"
(cd "$TARGET" && docker compose up -d --remove-orphans)
(cd "$TARGET" && docker compose restart alloy prometheus loki >/dev/null)
if $LOCAL; then
    say "done — Grafana: http://localhost:3300"
else
    say "done — Grafana: $(getenv GRAFANA_ROOT_URL)  (nginx: include $TARGET/nginx/grafana.conf)"
    say "ports: loki $(getenv LOKI_PORT), prometheus $(getenv PROMETHEUS_PORT), alertmanager $(getenv ALERTMANAGER_PORT), grafana $(getenv GRAFANA_PORT), alloy $(getenv ALLOY_PORT)"
fi
