// src/http/v1/callRoutes.js
// Management API — calls: outbound intents, history, control, recordings.
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import CallParticipantRepository from '../../persistence/CallParticipantRepository.js';
import CallLifecycleEventRepository from '../../persistence/CallLifecycleEventRepository.js';
import CallTransferLogRepository from '../../persistence/CallTransferLogRepository.js';
import IvrRepository from '../../persistence/IvrRepository.js';
import RecordingRepository from '../../persistence/RecordingRepository.js';
import { callEventHandler } from '../../core/events/CallEventHandler.js';
import { OutboundCallError } from '../../core/events/handlers/InitiationEventHandler.js';
import { callInbox } from '../../infra/cluster/CallInbox.js';
import { storageClient } from '../../infra/storage/StorageClient.js';
import { EventTypes } from '../../core/events/EventTypes.js';
import { toConsumerCallView } from '../../core/calls/CallView.js';
import { CallStatus, TerminationReason, TerminatedBy } from '../../core/constants/CallConstants.js';
import { callTerminator } from '../../core/calls/CallTerminator.js';
import { callErasure, ErasureError } from '../../core/calls/CallErasure.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { requireString, oneOf, optionalObject, optionalInt, optionalTimestamp, ref } from './validate.js';
import { config } from '../../../config/envConfig.js';
import { resolveTenant, resolveAgent, resolveChannelRef, resolveQueueRef } from './managementRoutes.js';

const ACTIVE = new Set([CallStatus.INITIATED, CallStatus.RINGING, CallStatus.IN_PROGRESS]);
// The values calls.status can hold (CallStatus also has CANCELLED, which is a
// termination reason in the database, never a status).
const STORED_STATUSES = [CallStatus.INITIATED, CallStatus.RINGING, CallStatus.IN_PROGRESS, CallStatus.TERMINATED, CallStatus.FAILED];

async function erasing(run) {
    try {
        return await run();
    } catch (err) {
        if (err instanceof ErasureError) throw new HttpError(err.code === 'storage_unavailable' ? 503 : 409, err.code, err.message);
        throw err;
    }
}

// ?customer= a phone number as the API stores it (E.164), with or without
// the "+" or a 00 prefix; anything else (a SIP URI) matches exactly.
function customerQuery(value) {
    if (value == null || value === '') return null;
    const s = String(value).trim().slice(0, 191);
    const digits = /^(\+|00)?\d{5,15}$/.test(s.replace(/[\s-]/g, '')) ? s.replace(/[^\d]/g, '').replace(/^00/, '') : null;
    return digits ? `+${digits}` : s;
}

// A call the calling consumer owns, with its tenant.
async function ownedCall(request) {
    const callId = Number(request.params.callId);
    if (!Number.isInteger(callId) || callId <= 0) throw notFound('Call');
    const call = await CallRepository.findById(callId);
    if (!call) throw notFound('Call');
    const tenant = await TenantRepository.findById(call.tenant_id);
    if (!tenant || String(tenant.consumer_id) !== String(request.consumer.id)) throw notFound('Call');
    return { call, tenant };
}

async function views(calls, tenant) {
    const agentIds = [...new Set(calls.map((c) => c.agent_id).filter(Boolean))];
    const agents = new Map((await AgentRepository.findByIds(agentIds)).map((a) => [String(a.id), a]));
    return calls.map((c) => {
        const agent = c.agent_id ? agents.get(String(c.agent_id)) : null;
        return toConsumerCallView(c, { tenantRef: tenant.external_ref, agentRef: agent?.external_ref ?? null, agentName: agent?.name ?? null });
    });
}

export default async function callRoutes(fastify) {
    // Outbound step 1: the consumer (after its own consent check) creates the
    // call; the agent's client then sends call:start { callId, sdpOffer }.
    fastify.post('/tenants/:tenantRef/calls', async (request, reply) => {
        const tenant = await resolveTenant(request);
        const body = request.body ?? {};
        const channel = await ChannelRepository.findByExternalRef(tenant.id, ref(body.channel_ref, 'channel'));
        if (!channel) throw badRequest('channel_ref does not match a channel');
        const agent = await resolveAgent(tenant, body.agent_ref);
        const customer = optionalObject(body, 'customer');
        if (!customer) throw badRequest('customer is required');

        try {
            const call = await callEventHandler.createOutboundIntent({
                tenantId: tenant.id,
                channel,
                agent,
                customerAddress: requireString(customer, 'address', { max: 191 }),
                customerAddressType: oneOf(customer, 'address_type', ['E164', 'WHATSAPP_USER', 'SIP_URI'], { optional: true }),
                customerName: requireString(customer, 'name', { optional: true }),
                externalRef: requireString(body, 'external_ref', { max: 191, optional: true }),
                consumerMetadata: optionalObject(body, 'consumer_metadata'),
            });
            const [view] = await views([call], tenant);
            return reply.code(201).send({ call: view });
        } catch (err) {
            if (err instanceof OutboundCallError) throw new HttpError(409, err.code, err.message);
            throw err;
        }
    });

    fastify.get('/tenants/:tenantRef/calls', async (request) => {
        const tenant = await resolveTenant(request);
        const q = request.query ?? {};
        let agentId = null;
        if (q.agent_ref) agentId = (await resolveAgent(tenant, q.agent_ref)).id;
        const calls = await CallRepository.listForTenant(tenant.id, {
            status: q.status ? oneOf(q, 'status', STORED_STATUSES) : null,
            direction: q.direction ? oneOf(q, 'direction', ['INBOUND', 'OUTBOUND']) : null,
            agentId,
            externalRef: q.external_ref ?? null,
            customerAddress: customerQuery(q.customer),
            channelId: q.channel_ref ? (await resolveChannelRef(tenant, q.channel_ref, 'channel_ref')).id : null,
            queueId: q.queue_ref ? (await resolveQueueRef(tenant, q.queue_ref, 'queue_ref')).id : null,
            from: optionalTimestamp(q, 'from'),
            to: optionalTimestamp(q, 'to'),
            beforeId: optionalInt(q, 'before_id', { min: 1 }),
            limit: optionalInt(q, 'limit', { min: 1, max: 200 }) ?? 50,
        });
        const data = await views(calls, tenant);
        return { calls: data, nextBeforeId: data.length ? data[data.length - 1].callId : null };
    });

    fastify.get('/calls/:callId', async (request) => {
        const { call, tenant } = await ownedCall(request);
        const [[view], participants, legs, events, transfers, ivrSessions, recording] = await Promise.all([
            views([call], tenant),
            CallParticipantRepository.findByCall(call.id),
            Promise.all(['AGENT', 'CUSTOMER', 'MONITOR'].map((t) => CallConnectionRepository.findByCallAndType(call.id, t))),
            CallLifecycleEventRepository.listForCall(call.id),
            CallTransferLogRepository.listForCall(call.id),
            IvrRepository.listSessionsForCall(call.id),
            RecordingRepository.findByCallId(call.id),
        ]);
        return {
            call: view,
            participants: participants.map((p) => ({
                kind: p.kind, agentId: p.agent_id, agentRef: p.agent_ref, deviceId: p.device_id,
                joinedAt: p.joined_at, leftAt: p.left_at, leaveReason: p.leave_reason,
            })),
            legs: legs.filter(Boolean).map((l) => ({
                type: l.connection_type, agentId: l.agent_id, deviceId: l.device_id, state: l.connection_state,
                connectedAt: l.connected_at, disconnectedAt: l.disconnected_at,
            })),
            events: events.map((e) => ({
                type: e.event_type, agentId: e.agent_id, occurredAt: e.occurred_at,
                durationSeconds: e.duration_seconds, metadata: typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata,
            })),
            transfers: transfers.map((t) => ({
                id: t.id, fromAgentId: t.from_agent_id, toAgentId: t.to_agent_id, toQueueId: t.to_queue_id,
                initiatedByAgentId: t.initiated_by_agent_id, initiatedByType: t.initiated_by_type,
                transferredAt: t.transferred_at, acceptedAt: t.accepted_at,
                acceptanceDurationSeconds: t.acceptance_duration_seconds,
            })),
            ivrSessions: ivrSessions.map((s) => ({
                id: s.id, ivrFlowId: s.ivr_flow_id, completed: Boolean(s.completed), outcome: s.outcome,
                durationSeconds: s.duration, startedAt: s.started_at, endedAt: s.ended_at,
                inputs: s.inputs.map((i) => ({ nodeName: i.node_name, input: i.input, pressedAt: i.pressed_at })),
            })),
            recording: recording ? {
                id: recording.id, status: recording.status, durationSeconds: recording.duration_seconds,
                format: recording.format, channelMap: recording.channel_map, completedAt: recording.completed_at,
            } : null,
        };
    });

    fastify.patch('/calls/:callId', async (request) => {
        const { call, tenant } = await ownedCall(request);
        const body = request.body ?? {};
        await CallRepository.updateConsumerFields(call.id, {
            externalRef: body.external_ref === undefined ? undefined : requireString(body, 'external_ref', { max: 191, optional: true }),
            consumerMetadata: body.consumer_metadata === undefined ? undefined : optionalObject(body, 'consumer_metadata'),
        });
        const [view] = await views([await CallRepository.findById(call.id)], tenant);
        return { call: view };
    });

    // Ends the call from the consumer's backend (handled by the worker that
    // owns the call's media).
    fastify.post('/calls/:callId/terminate', async (request, reply) => {
        const { call } = await ownedCall(request);
        if (!ACTIVE.has(call.status)) throw new HttpError(409, 'call_ended', `Call is already ${call.status}`);
        const subscribers = await callInbox.post(call.id, EventTypes.CALL_TERMINATED, {
            callId: call.id,
            userId: null,
            tenantId: call.tenant_id,
            reason: call.status === CallStatus.IN_PROGRESS ? 'api_terminated' : 'cancelled',
            requestedBy: TerminatedBy.CONSUMER,
        });
        // An outbound intent the agent hasn't started has no media and no
        // worker listening yet: end it here, as its expiry would. Guarded on
        // INITIATED, so a call:start that got in first wins.
        if (!subscribers && call.status === CallStatus.INITIATED) {
            await callTerminator.end(call.id, {
                reason: TerminationReason.CANCELLED,
                terminatedBy: TerminatedBy.CONSUMER,
                onlyIfStatus: CallStatus.INITIATED,
                provider: 'none',
                source: 'api_cancelled_intent',
            });
        }
        return reply.code(202).send({ accepted: true });
    });

    // Deletes an ended call and everything about it, recording included.
    fastify.delete('/calls/:callId', async (request, reply) => {
        const { call, tenant } = await ownedCall(request);
        await erasing(() => callErasure.deleteCall(tenant.id, call.id));
        return reply.code(204).send();
    });

    // Erases one customer's personal data from the tenant's ended calls.
    fastify.post('/tenants/:tenantRef/customers/erase', async (request) => {
        const tenant = await resolveTenant(request);
        const address = customerQuery(requireString(request.body ?? {}, 'address', { max: 191 }));
        return erasing(() => callErasure.eraseCustomer(tenant.id, address));
    });

    // A short-lived download URL for the call's recording.
    fastify.get('/calls/:callId/recording', async (request) => {
        const { call } = await ownedCall(request);
        const recording = await RecordingRepository.findByCallId(call.id);
        if (!recording || recording.status !== 'completed' || !recording.storage_key) throw notFound('Recording');
        if (!storageClient.isInitialized) throw new HttpError(503, 'storage_unavailable', 'Object storage is not configured');
        const url = await storageClient.getSignedDownloadUrl(recording.storage_key);
        return { url, expiresInSeconds: config.storage.signedUrlExpiry, format: recording.format, channelMap: recording.channel_map };
    });
}
