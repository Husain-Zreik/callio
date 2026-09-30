#!/usr/bin/env bash
# Where the server's alerts are sent: email, Slack and/or Telegram. Writes
# /opt/observability/alertmanager/alertmanager.yml from the settings given here
# (kept in alertmanager/notify.env) and restarts Alertmanager. Secrets are
# asked for without echo and kept in alertmanager/secrets/ (mode 600), which
# Alertmanager reads as files — they never appear in the config.
#
#   sudo /opt/observability/alerts.sh --email ops@example.com --smtp smtp.gmail.com:587 \
#                                     --from alerts@example.com [--smtp-user alerts@example.com]
#   sudo /opt/observability/alerts.sh --slack '#alerts'          (asks for the incoming-webhook URL)
#   sudo /opt/observability/alerts.sh --telegram -1001234567890  (asks for the bot token)
#   sudo /opt/observability/alerts.sh --remove email|slack|telegram
#   sudo /opt/observability/alerts.sh --show
#   sudo /opt/observability/alerts.sh --test                     (sends a test alert now)
#
# Every alert goes to every receiver set here; critical ones repeat hourly,
# the rest every 4 h. Alerts always show in Grafana too (Alerting → Alert list).
set -euo pipefail

TARGET="${OBSERVABILITY_DIR:-/opt/observability}"
AM="$TARGET/alertmanager"
SETTINGS="$AM/notify.env"
SECRETS="$AM/secrets"
say() { printf '\033[36m[alerts]\033[0m %s\n' "$*"; }
[ -d "$AM" ] || { echo "No observability stack at $TARGET (install.sh first)"; exit 1; }
mkdir -p "$SECRETS"
touch "$SETTINGS"

get() { grep -E "^$1=" "$SETTINGS" | tail -1 | cut -d= -f2- || true; }
set_() { if grep -qE "^$1=" "$SETTINGS"; then sed -i "s|^$1=.*|$1=$2|" "$SETTINGS"; else printf '%s=%s\n' "$1" "$2" >> "$SETTINGS"; fi; }
unset_() { sed -i "/^$1=/d" "$SETTINGS"; }
secret() {   # name prompt
    local v
    read -rsp "$2: " v; echo
    [ -n "$v" ] || { echo "Nothing entered."; exit 1; }
    printf %s "$v" > "$SECRETS/$1"
    chmod 600 "$SECRETS/$1"
    chown 65534:65534 "$SECRETS/$1" 2>/dev/null || true   # Alertmanager runs as nobody
}
port() { grep -E '^ALERTMANAGER_PORT=' "$TARGET/.env" 2>/dev/null | tail -1 | cut -d= -f2- || echo 9093; }
# Alertmanager answering /-/ready within 30 s, else its last log lines and a failure.
wait_ready() {
    for _ in $(seq 1 30); do
        curl -fs "http://127.0.0.1:$(port)/-/ready" >/dev/null 2>&1 && return 0
        sleep 1
    done
    echo "Alertmanager is not answering on 127.0.0.1:$(port). Its last log lines:"
    (cd "$TARGET" && docker compose logs --tail 20 alertmanager) || true
    return 1
}

ACTION=write
while [ $# -gt 0 ]; do
    case "$1" in
        --email) set_ EMAIL_TO "$2"; shift 2 ;;
        --smtp) set_ SMTP_HOST "$2"; shift 2 ;;
        --from) set_ EMAIL_FROM "$2"; shift 2 ;;
        --smtp-user) set_ SMTP_USER "$2"; shift 2 ;;
        --slack) set_ SLACK_CHANNEL "$2"; secret slack_webhook "Slack incoming-webhook URL"; shift 2 ;;
        --telegram)
            [[ "$2" =~ ^-?[0-9]+$ ]] || { echo "--telegram takes the numeric chat id (e.g. -1001234567890)"; exit 2; }
            set_ TELEGRAM_CHAT_ID "$2"; secret telegram_bot_token "Telegram bot token (from @BotFather)"; shift 2 ;;
        --remove)
            case "$2" in
                email) for k in EMAIL_TO EMAIL_FROM SMTP_HOST SMTP_USER; do unset_ $k; done; rm -f "$SECRETS/smtp_password" ;;
                slack) unset_ SLACK_CHANNEL; rm -f "$SECRETS/slack_webhook" ;;
                telegram) unset_ TELEGRAM_CHAT_ID; rm -f "$SECRETS/telegram_bot_token" ;;
                *) echo "--remove takes email, slack or telegram"; exit 2 ;;
            esac; shift 2 ;;
        --show) ACTION=show; shift ;;
        --test) ACTION=test; shift ;;
        -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
    esac
done

if [ "$ACTION" = show ]; then
    [ -n "$(get EMAIL_TO)" ] && say "email → $(get EMAIL_TO) via $(get SMTP_HOST) from $(get EMAIL_FROM)" || say "email: off"
    [ -n "$(get SLACK_CHANNEL)" ] && say "slack → $(get SLACK_CHANNEL)" || say "slack: off"
    [ -n "$(get TELEGRAM_CHAT_ID)" ] && say "telegram → chat $(get TELEGRAM_CHAT_ID)" || say "telegram: off"
    exit 0
fi

if [ "$ACTION" = test ]; then
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; end="$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)"
    wait_ready || exit 1
    curl -fsS -X POST "http://127.0.0.1:$(port)/api/v2/alerts" -H 'Content-Type: application/json' -d "[{
        \"labels\": {\"alertname\": \"TestNotification\", \"severity\": \"warning\", \"env\": \"$(hostname)\"},
        \"annotations\": {\"summary\": \"Test alert from $(hostname)\", \"description\": \"Sent by alerts.sh --test. If you see this, notifications work.\"},
        \"startsAt\": \"$now\", \"endsAt\": \"$end\"}]" >/dev/null
    say "test alert sent — it arrives within ~30 s (group_wait), and clears in 5 min"
    exit 0
fi

# Email: the SMTP password is asked the first time (or when the user changes).
if [ -n "$(get EMAIL_TO)" ]; then
    for k in SMTP_HOST EMAIL_FROM; do [ -n "$(get $k)" ] || { echo "Email needs --smtp host:port and --from address"; exit 2; }; done
    [ -n "$(get SMTP_USER)" ] || set_ SMTP_USER "$(get EMAIL_FROM)"
    [ -s "$SECRETS/smtp_password" ] || secret smtp_password "SMTP password for $(get SMTP_USER)"
fi

# ── alertmanager.yml ────────────────────────────────────────────────────────
[ -f "$AM/alertmanager.yml" ] && [ ! -f "$AM/alertmanager.yml.before-alerts-sh" ] && cp "$AM/alertmanager.yml" "$AM/alertmanager.yml.before-alerts-sh"
RECEIVER=grafana-only
{ [ -n "$(get EMAIL_TO)" ] || [ -n "$(get SLACK_CHANNEL)" ] || [ -n "$(get TELEGRAM_CHAT_ID)" ]; } && RECEIVER=notify
{
    echo "# Written by alerts.sh from alertmanager/notify.env — change it with alerts.sh, not here."
    echo "route:"
    echo "  receiver: $RECEIVER"
    echo "  group_by: [alertname, env]"
    echo "  group_wait: 30s"
    echo "  group_interval: 5m"
    echo "  repeat_interval: 4h"
    echo "  routes:"
    echo "    - matchers: [severity=\"critical\"]"
    echo "      receiver: $RECEIVER"
    echo "      repeat_interval: 1h"
    echo ""
    echo "receivers:"
    echo "  - name: grafana-only"
    if [ "$RECEIVER" = notify ]; then
        echo "  - name: notify"
        if [ -n "$(get EMAIL_TO)" ]; then
            echo "    email_configs:"
            echo "      - to: '$(get EMAIL_TO)'"
            echo "        from: '$(get EMAIL_FROM)'"
            echo "        smarthost: '$(get SMTP_HOST)'"
            echo "        auth_username: '$(get SMTP_USER)'"
            echo "        auth_password_file: /etc/alertmanager/secrets/smtp_password"
            echo "        send_resolved: true"
        fi
        if [ -n "$(get SLACK_CHANNEL)" ]; then
            echo "    slack_configs:"
            echo "      - api_url_file: /etc/alertmanager/secrets/slack_webhook"
            echo "        channel: '$(get SLACK_CHANNEL)'"
            echo "        send_resolved: true"
            echo "        title: '[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}'"
            echo "        text: '{{ range .Alerts }}{{ .Annotations.summary }} — {{ .Annotations.description }}{{ \"\\n\" }}{{ end }}'"
        fi
        if [ -n "$(get TELEGRAM_CHAT_ID)" ]; then
            echo "    telegram_configs:"
            echo "      - bot_token_file: /etc/alertmanager/secrets/telegram_bot_token"
            echo "        chat_id: $(get TELEGRAM_CHAT_ID)"
            echo "        parse_mode: ''"
            echo "        send_resolved: true"
            echo "        message: '[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}{{ range .Alerts }}{{ \"\\n\" }}{{ .Annotations.summary }} — {{ .Annotations.description }}{{ end }}'"
        fi
    fi
} > "$AM/alertmanager.yml.new"

# MSYS_NO_PATHCONV: Git Bash (a Windows dev box) would rewrite the /etc path.
if ! CHECK="$(cd "$TARGET" && MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps --entrypoint amtool alertmanager check-config /etc/alertmanager/alertmanager.yml.new 2>&1)"; then
    printf '%s\n' "$CHECK"
    echo "Alertmanager rejected the generated config — nothing changed ($AM/alertmanager.yml.new kept for a look)."
    exit 1
fi
mv "$AM/alertmanager.yml.new" "$AM/alertmanager.yml"
(cd "$TARGET" && docker compose restart alertmanager >/dev/null)
wait_ready || exit 1
say "alerts go to: $([ "$RECEIVER" = notify ] && echo "$(get EMAIL_TO) $(get SLACK_CHANNEL) $( [ -n "$(get TELEGRAM_CHAT_ID)" ] && echo "telegram:$(get TELEGRAM_CHAT_ID)")" || echo "Grafana only")"
[ "$RECEIVER" = notify ] && say "check it: sudo $TARGET/alerts.sh --test"
exit 0
