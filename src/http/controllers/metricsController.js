// GET /metrics — Prometheus metrics for this worker (src/infra/monitoring/metrics.js).
// Off unless METRICS_TOKEN is set; Prometheus sends it as a bearer token
// (nginx exposes the whole domain, so the endpoint is never open).
import { timingSafeEqual } from 'crypto';
import { registry } from '../../infra/monitoring/metrics.js';
import { config } from '../../../config/envConfig.js';

function authorized(header) {
    const expected = Buffer.from(`Bearer ${config.metrics.token}`);
    const given = Buffer.from(String(header ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handleMetrics(request, reply) {
    if (!config.metrics.token) return reply.code(404).send({ error: 'Not Found' });
    if (!authorized(request.headers.authorization)) return reply.code(401).send({ error: 'Unauthorized' });
    reply.header('content-type', registry.contentType);
    return registry.metrics();
}
