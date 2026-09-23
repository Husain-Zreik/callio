# nginx reverse proxy for Callio

Routes public traffic on the dev server (which hosts multiple projects) to
Callio's PM2 worker pool, with the sticky-routing behavior CLAUDE.md/
TABLE_OWNERSHIP.md already document as required but never checked into this
repo (`TABLE_OWNERSHIP.md`'s "Out-of-repo nginx sticky routing" note). This
is that missing piece.

Validated: `nginx -t` confirms both files below parse as valid nginx syntax
(tested locally against nginx 1.22.0). Not yet validated: actual behavior on
the real server, or that Laravel really sends the `X-Call-ID` header this
depends on — see `callio.conf`'s own comments for both caveats.

## Files

- `callio.conf` → `/etc/nginx/sites-available/callio.conf` (symlink into
  `sites-enabled/` as usual). Two upstream pools — one consistent-hashed by
  `X-Call-ID` for the handful of per-call routes Laravel calls, one
  `least_conn` for everything else (Socket.IO, health checks, account-level
  routes). See the file's own top-of-file comment for the full reasoning.
- `websocket-upgrade-map.conf` → goes in the `http {}` context (e.g.
  `/etc/nginx/conf.d/`), **not** inside `sites-available/callio.conf` —
  nginx's `map` directive isn't valid inside a `server {}` block. **Check
  first** whether another project on this server already defines a map named
  `$connection_upgrade` (very likely, since it's the standard, widely-copied
  nginx WebSocket recipe) — a duplicate map name fails to reload:
  ```
  grep -r "connection_upgrade" /etc/nginx/
  ```
  If it already exists, skip this file and just reuse the existing map.

## Steps on the server

1. Confirm this server's actual `WORKER_COUNT` for Callio (check its `.env`
   or `pm2 ls`) and match `callio.conf`'s two `upstream` blocks to the real
   worker count/ports — it defaults to the documented dev value (2 workers,
   ports 3001–3002).
2. Place `websocket-upgrade-map.conf`'s content in the `http {}` context (or
   confirm the existing map already covers this — see above).
3. Copy `callio.conf` to `/etc/nginx/sites-available/callio.conf` (already
   set up for `callio.pcg-ms.com`).
4. `ln -s /etc/nginx/sites-available/callio.conf /etc/nginx/sites-enabled/`
5. `nginx -t` — must pass before reloading.
6. `systemctl reload nginx` (or equivalent).
7. `certbot --nginx -d callio.pcg-ms.com` — adds HTTPS + redirect
   automatically; this file is deliberately HTTP-only so certbot can do that
   rewrite itself rather than guessing cert paths here.
8. Confirm DNS for the chosen subdomain actually points at this server.

## Before trusting the X-Call-ID routing specifically

Verify Laravel's actual outgoing HTTP client code (whatever sends
`POST /api/webhook` and `POST /api/internal/calls/release-stale`) sets a
literal `X-Call-ID` header. If it doesn't — wrong name, wrong casing, or sent
in the JSON body instead of a header — the hash directive silently degrades
to routing every request to the same one worker rather than failing loudly.
Easiest check: `curl`/log the headers Callio's `internalAuthMiddleware`
actually receives on a real webhook call, or just grep Laravel's HTTP client
code for the header name it sends.
