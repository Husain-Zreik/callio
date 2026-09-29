# Consumer events (v1)

Callio tells a consumer's backend what happened by POSTing events to the
consumer's `event_webhook_url`. This is how a product keeps its own records —
call history in its CRM, a "call" bubble in its chat timeline, billing,
reporting — without reading Callio's database.

## Delivery

- **At least once.** Every event is written to an outbox in the same step as
  the change that caused it and retried with backoff (5s, 15s, 1m, 5m, 15m,
  30m, then hourly) until your endpoint answers `2xx`, up to 12 attempts.
- **De-duplicate on `event_id`** (also in the `X-Callio-Event-Id` header). It
  is stable across retries.
- **Order is not guaranteed.** Each event carries the full current call, so
  apply them with "latest `occurred_at` wins".
- Respond quickly (within 10 seconds) and do your processing afterwards.

## Verifying requests

```
POST <event_webhook_url>
Content-Type: application/json
X-Callio-Event: call.ended
X-Callio-Event-Id: 7c0b1e0c-8a45-4c1b-9d4c-0f3a6a2f9b11
X-Callio-Signature: t=1790000000,v1=5d41402abc4b2a76b9719d911017c592...
```

`v1` is the hex HMAC-SHA256 of `"<t>.<raw request body>"` keyed with your
webhook secret. Recompute it over the raw bytes, compare in constant time, and
reject requests whose `t` is more than 5 minutes old.

```js
const [, t, v1] = /t=(\d+),v1=([a-f0-9]+)/.exec(req.headers['x-callio-signature']);
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

The same signature header is sent on lookup-hook requests.

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

## Event types

| Event | When | Extra `data` |
|---|---|---|
| `call.created` | An inbound call arrived, or an outbound intent was created | — |
| `call.queued` | Waiting in a queue for an agent (also: offered to everyone in a `RING_ALL` queue) | `assignment_type`, `offered_agent_ids` |
| `call.assigned` | Offered to, or claimed for, a specific agent | `assignment_type`, `offered_agent_ids` |
| `call.ringing` | The provider reports the customer's phone ringing (outbound) | — |
| `call.answered` | Media connected between customer and agent | — |
| `call.transferred` | Moved to another agent or queue | `from_agent_id`, `to_agent_id`, `to_queue_id` |
| `call.overflowed` | Waited `max_wait_seconds` and moved to the queue's overflow queue | `from_queue_id`, `to_queue_id` |
| `call.ivr.completed` | An IVR session ended | `outcome` (`transferred`/`hung_up`/`timeout`/`error`), `duration_seconds` |
| `call.ended` | Terminated or failed — see `terminationReason`, `terminatedBy`, `durations` | — |
| `recording.completed` | The call's recording is stored; fetch it with `GET /v1/calls/{id}/recording` | `recording_id`, `duration_seconds` |
| `agent.availability.changed` | An agent became `AVAILABLE`, `ON_CALL` or `OFFLINE` | `agent_ref`, `agent_id`, `availability`, `reason?` |

`call.created`, `call.answered` and `call.ended` are sent at most once per call.

## Values

- `terminationReason`: `COMPLETED`, `CANCELLED`, `REJECTED`, `BUSY`,
  `NO_ANSWER`, `TIMEOUT`, `AGENT_DISCONNECTED`, `AGENT_MEDIA_NOT_READY`,
  `SYSTEM_ERROR`, `NETWORK_ERROR`, `PROVIDER_ERROR`,
  `PROVIDER_TRIGGER_FAILED`, `SERVICE_MAINTENANCE`, `CUSTOMER_NETWORK_LOSS`,
  `IVR_AGENT_NO_ANSWER`.
  `COMPLETED` means the customer talked to an agent (or the IVR ended the call
  itself). A customer who hangs up before any agent answered — including while
  waiting after an IVR — is `CANCELLED` (within 5 s) or `NO_ANSWER`.
- `terminatedBy`: `AGENT`, `CUSTOMER`, `PROVIDER`, `SYSTEM`.
- `customer.addressType`: `E164`, `WHATSAPP_USER` (a WhatsApp user reachable
  without a phone number), `SIP_URI`.

## Lookup hook (optional, synchronous)

If the consumer has a `lookup_url`, Callio calls it before ringing anyone for
an inbound call:

```json
POST <lookup_url>
{ "tenant_ref": "biz-123", "channel": "WHATSAPP", "channel_address": "+96170000000",
  "customer": { "address": "+96181030841", "address_type": "E164", "name": "WhatsApp profile name" } }
```

Reply within 1.5 seconds with any of:

```json
{ "customer_name": "Jane Doe", "external_ref": "contact-991",
  "consumer_metadata": { "crm_contact_id": 991 }, "action": "reject" }
```

`action: "reject"` declines the call. A timeout or error is ignored — the call
continues without the enrichment.
