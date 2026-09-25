// src/http/routes/index.js
// Every HTTP surface Callio exposes (PLATFORM_ARCHITECTURE.md §3):
//   /health, /v1/health            probes (unauthenticated)
//   /webhooks/whatsapp             Meta ingress (signature)
//   /v1/webhooks/whatsapp/forward  forwarded Meta payloads (API key)
//   /v1/...                        Management API (API key)
import { handleWorkerHealth, handleHealth } from '../controllers/healthController.js';
import whatsappWebhookRoutes from '../webhooks/whatsappWebhook.js';
import managementRoutes from '../v1/managementRoutes.js';
import callRoutes from '../v1/callRoutes.js';
import { apiKeyAuth } from '../auth/apiKeyAuth.js';
import { httpErrorHandler } from '../errors.js';

export default async function registerRoutes(fastify) {
    fastify.get('/health', handleWorkerHealth);
    fastify.get('/v1/health', handleHealth);

    await fastify.register(whatsappWebhookRoutes);

    await fastify.register(async (v1) => {
        v1.setErrorHandler(httpErrorHandler);
        v1.addHook('preHandler', apiKeyAuth);
        await v1.register(managementRoutes);
        await v1.register(callRoutes);
    }, { prefix: '/v1' });
}
