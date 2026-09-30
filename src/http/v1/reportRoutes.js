// src/http/v1/reportRoutes.js
// Reports for a tenant (docs/management-api.md, Reports): calls over time,
// agents over a window, and the queues right now.
import QueueRepository from '../../persistence/QueueRepository.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import { callReports } from '../../core/reports/CallReports.js';
import { resolveTenant } from './managementRoutes.js';
import { badRequest } from '../errors.js';
import { oneOf, optionalInt, ref } from './validate.js';

const MAX_DAYS = { hour: 7, day: 93 };

// ?from&to (ISO 8601; default: the last 24 h up to now)
function timeWindow(query, maxDays) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 86_400_000);
    if (Number.isNaN(from.getTime())) throw badRequest('from must be an ISO 8601 date-time');
    if (Number.isNaN(to.getTime())) throw badRequest('to must be an ISO 8601 date-time');
    if (from >= to) throw badRequest('from must be before to');
    if (to - from > maxDays * 86_400_000) throw badRequest(`the window can be at most ${maxDays} days`);
    return { from, to };
}

export default async function reportRoutes(fastify) {
    fastify.get('/tenants/:tenantRef/reports/calls', async (request) => {
        const tenant = await resolveTenant(request);
        const query = request.query ?? {};
        const interval = oneOf(query, 'interval', ['HOUR', 'DAY'], { optional: true, fallback: 'HOUR' }).toLowerCase();
        const { from, to } = timeWindow(query, MAX_DAYS[interval]);
        const utcOffsetMinutes = optionalInt(query, 'utc_offset_minutes', { min: -720, max: 840 }) ?? 0;
        const serviceLevelSeconds = optionalInt(query, 'service_level_seconds', { min: 1, max: 3600 }) ?? 20;

        let queueId = null;
        if (query.queue_ref != null) {
            const queue = await QueueRepository.findByExternalRef(tenant.id, ref(query.queue_ref, 'queue'));
            if (!queue) throw badRequest('queue_ref does not match a queue');
            queueId = queue.id;
        }
        let channelId = null;
        if (query.channel_ref != null) {
            const channel = await ChannelRepository.findByExternalRef(tenant.id, ref(query.channel_ref, 'channel'));
            if (!channel) throw badRequest('channel_ref does not match a channel');
            channelId = channel.id;
        }

        const report = await callReports.calls(tenant.id, { from, to, interval, utcOffsetMinutes, serviceLevelSeconds, queueId, channelId });
        return {
            from: from.toISOString(), to: to.toISOString(), interval, utcOffsetMinutes, serviceLevelSeconds,
            ...(query.queue_ref != null ? { queueRef: String(query.queue_ref) } : {}),
            ...(query.channel_ref != null ? { channelRef: String(query.channel_ref) } : {}),
            ...report,
        };
    });

    fastify.get('/tenants/:tenantRef/reports/agents', async (request) => {
        const tenant = await resolveTenant(request);
        const { from, to } = timeWindow(request.query ?? {}, MAX_DAYS.day);
        return { from: from.toISOString(), to: to.toISOString(), agents: await callReports.agents(tenant.id, { from, to }) };
    });

    fastify.get('/tenants/:tenantRef/reports/live', async (request) => {
        const tenant = await resolveTenant(request);
        return { at: new Date().toISOString(), ...(await callReports.live(tenant.id)) };
    });
}
