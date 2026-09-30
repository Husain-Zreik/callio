# nginx reverse proxy

Template for putting Callio's PM2 workers behind nginx. Checked with `nginx -t`.

| File | Goes in | What it is |
|---|---|---|
| `callio.conf` | `/etc/nginx/sites-available/callio.conf` | The site: one `least_conn` upstream over the worker ports; `/socket.io/` (websocket upgrade, 1 h timeouts), `/v1/`, `/webhooks/`, `/health`, `/metrics` (local only), and a default location. |
| `websocket-upgrade-map.conf` | the `http {}` context (e.g. `/etc/nginx/conf.d/`) | The `$connection_upgrade` map. Skip it if the server already defines one: `grep -r connection_upgrade /etc/nginx/`. |

No sticky routing is needed: any worker accepts any request or socket; call
events reach the worker that owns the call over Redis, and Socket.IO's Redis
adapter delivers room emits everywhere (see the comment in `callio.conf`).

## Install

1. Set the `upstream` servers to the workers' ports: `BASE_PORT` ..
   `BASE_PORT + WORKER_COUNT - 1` from Callio's `.env` (`ecosystem.config.cjs`;
   check with `pm2 ls`).
2. Replace `callio.example.com` with the site's domain.
3. Add the upgrade map to the `http {}` context, unless it already exists.
4. Copy `callio.conf` to `sites-available/` and symlink it into `sites-enabled/`.
5. `nginx -t && systemctl reload nginx`.
6. `certbot --nginx -d <domain>` adds TLS and the HTTPS redirect.
7. Optional: Grafana under `/grafana/` — `include /opt/observability/nginx/grafana.conf;`
   in the HTTPS `server {}` block (`deploy/observability/README.md`).

The file on a deployed server is not kept in sync with this template: certbot
rewrites it, and each server has its own ports and domain. Compare before
copying over a live one.
