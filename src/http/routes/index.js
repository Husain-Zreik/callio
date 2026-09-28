// src/http/routes/index.js
// Every HTTP surface Callio exposes (PLATFORM_ARCHITECTURE.md §3):
//   /health, /v1/health            probes (unauthenticated)
//   channel ingress                each customer channel's own webhooks, e.g.
//                                  /webhooks/whatsapp and /v1/webhooks/whatsapp/forward
//   /v1/...                        Management API (API key)
import { handleWorkerHealth, handleHealth } from '../controllers/healthController.js';
import managementRoutes from '../v1/managementRoutes.js';
import callRoutes from '../v1/callRoutes.js';
import { apiKeyAuth } from '../auth/apiKeyAuth.js';
import { httpErrorHandler } from '../errors.js';
import { customerChannels } from '../../core/channels/CustomerChannels.js';

export default async function registerRoutes(fastify) {
    fastify.get('/health', handleWorkerHealth);
    fastify.get('/v1/health', handleHealth);

    for (const channel of customerChannels.all()) {
        if (channel.registerRoutes) await channel.registerRoutes(fastify);
    }

    await fastify.register(async (v1) => {
        v1.setErrorHandler(httpErrorHandler);
        v1.addHook('preHandler', apiKeyAuth);
        await v1.register(managementRoutes);
        await v1.register(callRoutes);
    }, { prefix: '/v1' });
}
