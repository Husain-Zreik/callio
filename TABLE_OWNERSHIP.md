# Table Ownership — `backend/` (Laravel) vs `node/` (WebRTC call server)

Both apps connect to the same MySQL database directly (no API between them for
most of it — see the "accepted debt" section below). That's fine for reads,
but a table with two independent writers is how bugs like the one this doc
exists to prevent happen: `UserController::updateCallAvailability` used to run
its own raw `calls` UPDATE that skipped everything `node/`'s real
`CallCleanupService` does (closing WebRTC peers, releasing agents, emitting
`call:terminated`, writing lifecycle events) — a call could end up
`TERMINATED` in the DB while still ringing live on the agent's device. Two
more Laravel classes (`CallLifecycleLogger`, `CallAnalyticsService`) existed
as a second, never-wired-up writer for `call_lifecycle_events`/
`call_transfer_logs` and have been deleted for the same reason.

**Rule: each table below has exactly one writer. If you need to change data
on a table you don't own, call the owning service's API — don't write the
row directly.**

| Table | Writer(s) | Contract |
|---|---|---|
| `calls` | **node/ only** | Laravel never writes directly. Stale/zombie-call cleanup goes through `POST /api/internal/calls/release-stale` (see `CallCleanupService.releaseStaleCallsForUser`), gated behind `services.node_server.use_remote_stale_cleanup` during rollout. Laravel may still read freely (dashboards, billing, `activeCall` relation). |
| `call_lifecycle_events` | **node/ only** | `CallLifecycleEventRepository.js`. No Laravel writer should ever exist — a future Laravel need is read-only, against the current `inbound_*`/`outbound_*`/`ivr_*` enum values (renamed 2026-02-27; don't resurrect old short values like `'queued'`/`'assigned'`). |
| `call_transfer_logs` | **node/ only** | `CallTransferLogRepository.js`. |
| `call_connections`, `ivr_sessions`, `ivr_session_inputs` | **node/ only** | Already clean — no Laravel writer exists or should exist. Stated here to keep the contract explicit. |
| `call_recordings` | **Split by phase.** node/ owns capture/status transitions during a call (`RecordingRepository.js`: create/updateRecordingUrl/updateStatus/markCompleted/markFailed). Laravel owns post-call retention/legal-hold/deletion (`CallController.php`: setRetention/deleteRecording/restoreRecording/bulk variants, `PurgeExpiredRecordings.php`). | Both write `status`, from disjoint state-machine phases (node/: `recording`→`completed`/`failed`; Laravel: `completed`→`pending_deletion`→`purged`/restored). node/ must never touch `status` once Laravel has moved a row into a retention-phase status, and Laravel must never touch a row before node/ has reached a terminal capture status. Not enforced at the DB level today — treat as a contract, not a guarantee. |
| `ivr_menus` | **Laravel only.** Menu definition (`structure`, `status`, `trigger_condition`, timeouts — full CRUD via `IvrMenuController.php`). | node/ used to roll up 3 metric columns (`total_calls`, `completed_flows`, `avg_duration`) via `PATCH /api/v1/internal/ivr-menus/{id}/metrics` (`LaravelInternalApiClient`). That integration was removed — node/ no longer contributes to this table in any way, direct or via API. If those columns still need populating, Laravel (or another system) must compute them independently; `ivr_sessions`/`ivr_session_inputs` (node/-owned, see above) remain the source of truth for the underlying session-level data. |
| `call_rates_ranges` / `rates` | **Laravel only** | node/ never touches these — pure billing config. |
| `businesses`, `business_numbers`, `users`, `client_numbers`, `media_files`, `platform_settings`, `user_groups`/`user_group_members` | **Laravel owns writes.** node/ reads these directly via its own `mysql2` pool (`BusinessRepository.js`, `AgentRepository.js`, `ClientRepository.js`, `IvrRepository.js`, `UserGroupRepository.js`). | **Accepted debt, not fixed here.** Replacing these direct reads with a formal internal read-API is real work and explicitly out of scope for the current extraction pass. Documented so it isn't rediscovered as "new" scope later. |

## Other accepted-but-unfixed coupling (operational, not a table)

- **Shared S3 bucket/prefix convention.** `node/`'s `AWS_BUCKET_PREFIX` must
  match Laravel's `.env` value by hand — no in-repo enforcement is possible.
- **Out-of-repo nginx sticky routing.** Laravel sends `X-Call-ID` so nginx can
  hash-route to the correct node/ PM2 worker port; that nginx config is not
  version-controlled anywhere in this repo. Anyone moving node/'s workers
  behind a different load balancer needs to locate and port it manually.
- **Shared local/public storage disk.** `LARAVEL_STORAGE_ROOT` (see
  `node/.env.example`) makes the path configurable, but node/ and `backend/`
  still need to be on the same disk (or a shared mount) unless/until this
  becomes a Laravel file-serving endpoint instead.

## Internal API surface (server-to-server only, never a browser/mobile session)

All of the following require the shared `X-Internal-Api-Key` header (see
`node/config/envConfig.js`'s `auth.internalApiKey` and Laravel's
`InternalApiKeyMiddleware`) — the value must be identical in both `.env` files
(`NODE_INTERNAL_API_KEY` in `backend/.env`, `INTERNAL_API_KEY` in `node/.env`).

| Direction | Endpoint | Purpose |
|---|---|---|
| Laravel → node/ | `POST /api/webhook` | Forward a WhatsApp call webhook |
| Laravel → node/ | `POST /api/call-center/status` | Notify a business's call-center was disabled |
| Laravel → node/ | `POST /api/chat/status`, `/chat/message`, `/chat/read`, `/chat/merged` | Live chat page push |
| Laravel → node/ | `POST /api/orders/update`, `/api/templates/status`, `/api/activities/reminder` | Live page push (orders/templates/lead activities) |
| Laravel → node/ | `POST /api/internal/calls/release-stale` | On-demand stale-call cleanup for one agent (see `calls` row above) |

There is currently no node/ → Laravel direction on this surface — the one
endpoint that used it (`PATCH /api/v1/internal/ivr-menus/{id}/metrics`, IVR
rollup metrics) was removed; see the `ivr_menus` row above.
