// src/http/routes/index.js
// Every HTTP surface Callio exposes (docs/architecture.md#integration-surfaces):
//   /health, /v1/health            probes (unauthenticated)
//   /metrics                       Prometheus (METRICS_TOKEN)
//   channel ingress                each customer channel's own webhooks, e.g.
//                                  /webhooks/whatsapp and /v1/webhooks/whatsapp/forward
//   /v1/...                        Management API (API key)
import { handleWorkerHealth, handleHealth } from '../controllers/healthController.js';
import { handleMetrics } from '../controllers/metricsController.js';
import managementRoutes from '../v1/managementRoutes.js';
import callRoutes from '../v1/callRoutes.js';
import eventRoutes from '../v1/eventRoutes.js';
import pushCredentialRoutes from '../v1/pushCredentialRoutes.js';
import keyRoutes from '../v1/keyRoutes.js';
import { apiKeyAuth } from '../auth/apiKeyAuth.js';
import { idempotencyPreHandler, idempotencyOnSend } from '../v1/idempotency.js';
import { httpErrorHandler } from '../errors.js';
import { customerChannels } from '../../core/channels/CustomerChannels.js';

export default async function registerRoutes(fastify) {
    fastify.get('/health', handleWorkerHealth);
    fastify.get('/v1/health', handleHealth);
    fastify.get('/metrics', handleMetrics);

    for (const channel of customerChannels.all()) {
        if (channel.registerRoutes) await channel.registerRoutes(fastify);
    }

    await fastify.register(async (v1) => {
        v1.setErrorHandler(httpErrorHandler);
        v1.addHook('preHandler', apiKeyAuth);
        v1.addHook('preHandler', idempotencyPreHandler);
        v1.addHook('onSend', idempotencyOnSend);
        await v1.register(managementRoutes);
        await v1.register(callRoutes);
        await v1.register(eventRoutes);
        await v1.register(pushCredentialRoutes);
        await v1.register(keyRoutes);
    }, { prefix: '/v1' });
}
