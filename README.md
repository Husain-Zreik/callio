# Callio

A standalone contact-center call engine. Customers call in over WhatsApp
Calling (SIP/PSTN in progress); agents answer in a browser or app over WebRTC;
Callio runs everything in between — queues and routing, IVR, agent
availability, transfers, supervisor monitoring, recording and the call record.

Any product integrates with it through a documented contract; Callio has no
knowledge of any particular product.

| Document | For |
|---|---|
| [PLATFORM_ARCHITECTURE.md](PLATFORM_ARCHITECTURE.md) | How Callio is built and how products integrate with it |
| [docs/management-api.md](docs/management-api.md) | The REST API a product's backend calls |
| [docs/events.md](docs/events.md) | The events Callio sends to a product's backend |
| [docs/agent-protocol.md](docs/agent-protocol.md) | The socket + WebRTC protocol agent clients speak |
| [migrations/README.md](migrations/README.md) | The data model |
| [SIP_INTEGRATION.md](SIP_INTEGRATION.md) | The SIP trunk gateway (drachtio + rtpengine) |

## Running it

Requirements: Node 18+ (22 recommended), MySQL 8, Redis 6+.

```bash
cp .env.example .env          # set CALLIO_MASTER_KEY, DB_*, REDIS_*, WhatsApp/S3/push as needed
npm install
npm run migrate:latest        # creates Callio's schema in its own database
npm run dev                   # single process with auto-restart
# production: pm2 start ecosystem.config.cjs   (WORKER_COUNT workers on BASE_PORT+i)
```

In production, workers sit behind a load balancer that routes a call's
traffic to the worker holding its media (see `deploy/nginx/`).

## Onboarding a product

1. **Create the consumer** (operator, once per product):

   ```bash
   npm run consumer:create -- --name "Acme CRM" --slug acme \
       --webhook-url https://acme.example/callio/events
   ```

   Prints the API key, the agent-token signing key (`kid` + secret) and the
   webhook secret — shown once, store them in the product's secrets.

2. **Provision** through the [Management API](docs/management-api.md): tenants
   (e.g. one per customer business), agents, queues and members, channels
   (the WhatsApp number with its Meta phone_number_id and token), IVR flows.

3. **Point WhatsApp at Callio**: set the Meta app's webhook to
   `https://<callio>/webhooks/whatsapp` (with `WHATSAPP_APP_SECRET` and
   `WHATSAPP_VERIFY_TOKEN` configured), or forward the payloads from the
   product's backend to `/v1/webhooks/whatsapp/forward`.

4. **Connect agents**: the product's backend signs short-lived agent JWTs;
   its web/mobile client connects as in [agent-protocol.md](docs/agent-protocol.md)
   and registers push tokens through the API.

5. **Consume events** at the webhook URL ([events.md](docs/events.md)).

For local development, `npm run seed:dev -- --phone-number-id <id> --whatsapp-token <token>`
creates a `dev` consumer with a demo tenant, agents, a queue and a channel.

## Testing

```bash
docker compose -f test/e2e/docker-compose.yml up -d   # MySQL + Redis for tests
npm run test:e2e
```

The end-to-end suites run real calls with WebRTC media against a fake Meta
Graph API — see [test/e2e/README.md](test/e2e/README.md).

## Secrets on disk

`storage/firebase/` (FCM service account) and `storage/apple/` (APNs `.p8`
key) are gitignored — place the real files there, or point the env vars at
them.
