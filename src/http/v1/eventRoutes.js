// src/http/v1/eventRoutes.js
// Management API — consumer events (docs/events.md#reading-events-back): the
// events Callio sent (or is sending) to the consumer's webhook, so a consumer
// that missed deliveries can catch up, and a way to have one sent again.
import OutboxRepository from '../../persistence/OutboxRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import { notFound } from '../errors.js';
import { oneOf, optionalInt, ref } from './validate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// body is exactly what the webhook POSTs.
function eventView(row) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    return {
        eventId: row.event_id,
        type: row.event_type,
        callId: row.call_id ?? null,
        createdAt: row.created_at,
        delivery: {
            status: row.status,
            attempts: row.attempts,
            lastResponseStatus: row.last_response_status ?? null,
            deliveredAt: row.delivered_at ?? null,
        },
        body: { event_id: row.event_id, ...payload },
    };
}

async function findEvent(request) {
    const { eventId } = request.params;
    if (!UUID.test(eventId)) throw notFound('Event');
    const row = await OutboxRepository.findForConsumer(request.consumer.id, eventId);
    if (!row) throw notFound('Event');
    return row;
}

export default async function eventRoutes(fastify) {
    fastify.get('/events', async (request) => {
        const q = request.query ?? {};
        let tenantId = null;
        if (q.tenant_ref != null) {
            const tenant = await TenantRepository.findByExternalRef(request.consumer.id, ref(q.tenant_ref, 'tenant'));
            if (!tenant) throw notFound('Tenant');
            tenantId = tenant.id;
        }
        const rows = await OutboxRepository.listForConsumer(request.consumer.id, {
            tenantId,
            callId: optionalInt(q, 'call_id', { min: 1 }),
            eventType: q.type ? String(q.type).slice(0, 64) : null,
            status: q.status ? oneOf(q, 'status', ['PENDING', 'DELIVERED', 'FAILED']) : null,
            beforeId: optionalInt(q, 'before_id', { min: 1 }),
            limit: optionalInt(q, 'limit', { min: 1, max: 200 }) ?? 50,
        });
        return { events: rows.map(eventView), nextBeforeId: rows.length ? rows[rows.length - 1].id : null };
    });

    fastify.get('/events/:eventId', async (request) => ({ event: eventView(await findEvent(request)) }));

    // Sends the event to the webhook again (same event_id), with a fresh retry schedule.
    fastify.post('/events/:eventId/redeliver', async (request, reply) => {
        const row = await findEvent(request);
        await OutboxRepository.redeliver(request.consumer.id, row.event_id);
        return reply.code(202).send({ accepted: true });
    });
}
