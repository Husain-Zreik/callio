# Consumer events (v1)

Callio tells a consumer's backend what happened by POSTing events to the
consumer's `event_webhook_url`. This is how a product keeps its own records —
call history in its CRM, a "call" bubble in its chat timeline, billing,
reporting — without reading Callio's database.

## Delivery

- **Written after the change, then delivered at least once.** An event is
  written to an outbox right after the change that caused it has been
  committed, as a separate step — not in the same transaction. A failed
  write is retried for a few seconds. Once written, the event is retried
  with backoff (5s, 15s, 1m, 5m, 15m, 30m, then hourly) until your endpoint
  answers `2xx`, and given up after the 12th failed attempt.
- **Missed some?** Read them back with `GET /v1/events` and have one sent
  again with `POST /v1/events/{eventId}/redeliver`
  ([management-api.md](management-api.md#events)).
- `call.created`, `call.answered` and `call.ended` exist at most once per call.
- **Any other answer is a failed attempt**, including a timeout (10 seconds)
  and a redirect: `3xx` responses are not followed.
- **De-duplicate on `event_id`** (also in the `X-Callio-Event-Id` header). It
  is stable across retries.
- **Order is not guaranteed.** Each call event carries the full current call,
  so apply them with "latest `occurred_at` wins".
- Respond quickly and do your processing afterwards.
- While the consumer has no `event_webhook_url`, or is suspended, events are
  kept and delivered once it has one again.

## Verifying requests

```
POST <event_webhook_url>
Content-Type: application/json
User-Agent: Callio-Webhooks/1
X-Callio-Event: call.ended
X-Callio-Event-Id: 7c0b1e0c-8a45-4c1b-9d4c-0f3a6a2f9b11
X-Callio-Signature: t=1790000000,v1=5d41402abc4b2a76b9719d911017c592...
```

`X-Callio-Signature` is sent only when the consumer has a webhook secret.
`v1` is the hex HMAC-SHA256 of `"<t>.<raw request body>"` keyed with that
secret. Recompute it over the raw bytes, compare in constant time, and reject
requests whose `t` is more than 5 minutes old.

```js
const [, t, v1] = /t=(\d+),v1=([a-f0-9]+)/.exec(req.headers['x-callio-signature']);
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

## Envelope

```json
{
  "event_id": "7c0b1e0c-8a45-4c1b-9d4c-0f3a6a2f9b11",
  "event_type": "call.ended",
  "api_version": "2026-09-25",
  "occurred_at": "2026-09-25T10:05:12.000Z",
  "tenant_ref": "biz-123",
  "data": {
    "call": {
      "callId": 42,
      "callUuid": "00000000-0000-0000-0000-000000000042",
      "tenantId": 1,
      "tenantRef": "biz-123",
      "channel": "WHATSAPP",
      "channelId": 1,
      "channelAddress": "+96170000000",
      "queueId": 1,
      "direction": "INBOUND",
      "status": "TERMINATED",
      "state": null,
      "customer": { "address": "+96181030841", "addressType": "E164", "name": "Test Customer" },
      "agentId": 7,
      "agentRef": "user-7",
      "agentName": "Agent One",
      "externalRef": "crm-call-42",
      "providerCallId": "wacid.HBgL...",
      "ivrFlowId": null,
      "ringingAt": "2026-09-25T10:00:00.000Z",
      "answeredAt": "2026-09-25T10:00:06.000Z",
      "endedAt": "2026-09-25T10:05:12.000Z",
      "terminationReason": "COMPLETED",
      "terminatedBy": "CUSTOMER",
      "durations": { "ringing": 6, "call": 306, "queue": 0, "onHold": 0 },
      "failureDetails": null,
      "consumerMetadata": { "crm_contact_id": 991 },
      "createdAt": "2026-09-25T10:00:00.000Z"
    }
  }
}
```

Every `call.*` and `recording.*` event has `data.call` (the same view the
Management API returns), plus the extra fields below.
`agent.availability.changed` has no `data.call`.

## Event types

| Event | When | Extra `data` |
|---|---|---|
| `call.created` | An inbound call arrived, or an outbound intent was created | — |
| `call.queued` | Waiting in a queue for an agent, or offered to every member of a `RING_ALL` queue | offered to a `RING_ALL` queue: `assignment_type`, `offered_agent_ids`; waiting with nobody to offer it to: — |
| `call.assigned` | Offered to, or claimed for, a specific agent | `assignment_type` (`DIRECT`, `QUEUED`, `TRANSFERRED`), `offered_agent_ids` |
| `call.ringing` | The provider reports the customer's phone ringing (outbound) | — |
| `call.answered` | Inbound: an agent accepted. Outbound: the customer answered | — |
| `call.transferred` | Moved to another agent or queue | `from_agent_id`, `to_agent_id`, `to_queue_id` |
| `call.overflowed` | Waited `max_wait_seconds` and moved to the queue's overflow queue | `from_queue_id`, `to_queue_id` |
| `call.ivr.completed` | An IVR session ended | `outcome` (`transferred`/`hung_up`/`timeout`/`error`), `duration_seconds` |
| `call.ended` | Terminated or failed — see `terminationReason`, `terminatedBy`, `durations` | — |
| `recording.completed` | The call's recording is stored; fetch it with `GET /v1/calls/{id}/recording` | `recording_id`, `duration_seconds` |
| `agent.availability.changed` | An agent's availability was set (`AVAILABLE`, `ON_CALL`, `OFFLINE`) | `data` is `{ agent_ref, agent_id, availability, reason? }`; `reason: auto_offline_missed_calls` when the auto-offline policy took the agent offline |

- `call.created`, `call.answered` and `call.ended` are sent at most once per
  call.
- `call.queued` and `call.assigned` are sent again every time the call is
  re-offered: a decline or ring timeout passing it on, an overflow, a
  transfer, or a live call going back to its queue.
- `agent.availability.changed` is also sent, unchanged, when an agent's
  client resyncs its availability.

## Values

- `terminationReason`: `COMPLETED`, `CANCELLED`, `REJECTED`,
  `NO_ANSWER`, `TIMEOUT`, `AGENT_DISCONNECTED`, `AGENT_MEDIA_NOT_READY`,
  `SYSTEM_ERROR`, `NETWORK_ERROR`, `PROVIDER_ERROR`,
  `PROVIDER_TRIGGER_FAILED`, `SERVICE_MAINTENANCE`, `CUSTOMER_NETWORK_LOSS`,
  `IVR_AGENT_NO_ANSWER`.
  `COMPLETED` means the customer talked to an agent (or the IVR ended the call
  itself). A customer who hangs up before any agent answered — including while
  waiting after an IVR — is `CANCELLED` (within 5 s) or `NO_ANSWER`.
  A live call transferred to an agent who doesn't accept it in time goes back
  to its queue (inbound) — it keeps ringing agents — or ends as
  `TIMEOUT` / `SYSTEM` (outbound calls, calls without a queue).
- `terminatedBy`: `AGENT`, `CUSTOMER`, `PROVIDER`, `SYSTEM`.
- `status`: `INITIATED`, `RINGING`, `IN_PROGRESS`, `TERMINATED`, `FAILED`.
- `customer.addressType`: `E164`, `WHATSAPP_USER` (a WhatsApp user reachable
  without a phone number), `SIP_URI`.

## Lookup hook (optional, synchronous)

If the consumer has a `lookup_url`, Callio calls it before ringing anyone for
an inbound call.

```
POST <lookup_url>
Content-Type: application/json
X-Callio-Signature: t=…,v1=…
```

```json
{
  "tenant_ref": "biz-123",
  "channel": "WHATSAPP",
  "channel_address": "+96170000000",
  "customer": { "address": "+96181030841", "address_type": "E164", "name": "WhatsApp profile name" }
}
```

The signature is computed as for events, with the webhook secret; it is sent
only when the consumer has both a webhook secret and an `event_webhook_url`. Reply `2xx` within 1.5 seconds with any of:

```json
{
  "customer_name": "Jane Doe",
  "external_ref": "contact-991",
  "consumer_metadata": { "crm_contact_id": 991 },
  "action": "reject"
}
```

| Field | Effect |
|---|---|
| `customer_name` | Replaces the customer's name, if a string |
| `external_ref` | Stored on the call, truncated to 191 characters |
| `consumer_metadata` | Stored on the call, if an object |
| `action: "reject"` | Declines the call: it ends as `REJECTED` (`terminatedBy: SYSTEM`) without ringing anyone |

Anything else is ignored. A timeout, an error or a non-`2xx` answer is
ignored too — the call continues without the enrichment.
