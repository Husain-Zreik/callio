# Callio

A standalone contact-center call engine. Customers call in over WhatsApp
Calling or a SIP carrier trunk (PSTN); agents answer in a browser or app over
WebRTC; Callio runs everything in between — queues and routing, IVR, agent
availability, transfers, supervisor monitoring, recording and the call record.

Any product integrates with it through a documented contract; Callio has no
knowledge of any particular product.

## Documentation

| Document | For |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How Callio works inside and how products plug into it |
| [docs/management-api.md](docs/management-api.md) | The REST API a product's backend calls |
| [docs/events.md](docs/events.md) | The events Callio sends to a product's backend |
| [docs/agent-protocol.md](docs/agent-protocol.md) | The socket + WebRTC protocol agent clients speak |
| [sdk/agent-js/README.md](sdk/agent-js/README.md) | The JavaScript agent SDK |
| [docs/sip.md](docs/sip.md) | SIP trunks: carrier requirements, gateway, deployment |
| [docs/data-model.md](docs/data-model.md) | The database schema |
| [docs/logging.md](docs/logging.md) | Logs and metrics |
| [test/e2e/README.md](test/e2e/README.md) | The end-to-end test suites |

## Running it

Requirements: Node 18+ (22 recommended), MySQL 8, Redis 6+.

```bash
cp .env.example .env          # set CALLIO_MASTER_KEY, DB_*, REDIS_*, WhatsApp/SIP/S3/push as needed
npm install
npm run migrate:latest        # creates Callio's schema in its own database
npm run dev                   # single process with auto-restart
# production: pm2 start ecosystem.config.cjs   (WORKER_COUNT workers on BASE_PORT+i)
```

In production the workers sit behind nginx ([deploy/nginx/](deploy/nginx/)).
Any worker can take any request: call events reach the worker that holds a
call's media over Redis. SIP needs the gateway in
[deploy/sip-gateway/](deploy/sip-gateway/) ([docs/sip.md](docs/sip.md)).

## Onboarding a product

1. **Create the consumer** (operator, once per product):

   ```bash
   npm run consumer:create -- --name "Acme CRM" --slug acme \
       --webhook-url https://acme.example/callio/events
   ```

   Prints the API key, the agent-token signing key (`kid` + secret) and the
   webhook secret — shown once, store them in the product's secrets.

2. **Provision** through the [Management API](docs/management-api.md): tenants
   (e.g. one per customer business), agents, queues and members, channels, IVR
   flows. A channel is a WhatsApp number (Meta phone_number_id and token) or a
   SIP number (DID) on a trunk the operator created with `npm run sip:trunk`.

3. **Connect the channel**:
   - WhatsApp: set the Meta app's webhook to `https://<callio>/webhooks/whatsapp`
     (with `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` configured), or
     forward the payloads from the product's backend to
     `/v1/webhooks/whatsapp/forward`.
   - SIP: the carrier sends the DID's calls to the SIP gateway
     ([docs/sip.md](docs/sip.md)).

4. **Connect agents**: the product's backend signs short-lived agent JWTs; its
   client connects with the [agent SDK](sdk/agent-js/README.md) or the
   [protocol](docs/agent-protocol.md) directly, and registers push tokens
   through the API.

5. **Consume events** at the webhook URL ([events.md](docs/events.md)). The product can change the URL, pick the event types it wants and rotate the secret itself with `PUT /v1/webhook` ([management-api.md](docs/management-api.md#webhook)).

For local development, `npm run seed:dev -- --phone-number-id <id> --whatsapp-token <token> [--sip-did +961…]`
creates a `dev` consumer with a demo tenant, agents, a queue and channels, and
`npm run demo:agent` serves a working agent page.

## Testing

```bash
docker compose -f test/e2e/docker-compose.yml up -d --wait            # MySQL + Redis
docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d   # optional: the SIP suite
npm run test:e2e
```

The suites run real calls with WebRTC media against a fake Meta Graph API and a
fake SIP carrier — see [test/e2e/README.md](test/e2e/README.md).

## Secrets on disk

`storage/firebase/google-services.json` (FCM service account) and
`storage/apple/` (APNs `.p8` key) are gitignored — place the real files there,
or point the env vars at them.
