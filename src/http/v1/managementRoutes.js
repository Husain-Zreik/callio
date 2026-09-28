// src/http/v1/managementRoutes.js
// Management API — provisioning (PLATFORM_ARCHITECTURE.md §3A). Consumers
// address their entities by their own references; every route is scoped to
// the calling consumer's tenants.
import TenantRepository from '../../persistence/TenantRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import QueueRepository from '../../persistence/QueueRepository.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import SipTrunkRepository from '../../persistence/SipTrunkRepository.js';
import IvrRepository from '../../persistence/IvrRepository.js';
import PushTokenRepository from '../../persistence/PushTokenRepository.js';
import { agentAssignmentCoordinator } from '../../core/routing/AgentAssignmentCoordinator.js';
import { callCleanupService } from '../../core/calls/CallCleanupService.js';
import { storageClient } from '../../infra/storage/StorageClient.js';
import { customerChannels } from '../../core/channels/CustomerChannels.js';
import { Channel } from '../../core/constants/CallConstants.js';
import { badRequest, notFound } from '../errors.js';
import { requireString, optionalInt, oneOf, optionalObject, ref } from './validate.js';

// ── Shaping ──────────────────────────────────────────────────────────────────

const agentView = (a) => a && ({
    id: a.id, ref: a.external_ref, name: a.name, role: a.role, availability: a.availability,
});
const queueView = (q) => q && ({
    id: q.id, ref: q.external_ref, name: q.name, strategy: q.strategy,
    ringTimeoutSeconds: q.ring_timeout_seconds, maxActiveCalls: q.max_active_calls,
    maxWaitSeconds: q.max_wait_seconds, overflowQueueId: q.overflow_queue_id,
    holdAudioAssetId: q.hold_audio_asset_id, status: q.status,
});
const channelView = (c) => c && ({
    id: c.id, ref: c.external_ref, type: c.type, displayName: c.display_name, address: c.address,
    providerAccountId: c.provider_account_id, sipTrunkId: c.sip_trunk_id ?? null, inboundQueueId: c.inbound_queue_id,
    recordingEnabled: Boolean(c.recording_enabled), status: c.status,
});
const tenantView = (t) => t && ({ id: t.id, ref: t.external_ref, name: t.name, status: t.status, settings: t.settings });
const flowView = (f) => f && ({
    id: f.id, ref: f.external_ref, name: f.name, channelId: f.channel_id, schemaVersion: f.schema_version,
    triggerCondition: f.trigger_condition, triggerPriority: f.trigger_priority,
    timeoutSeconds: f.timeout_seconds, agentRingTimeout: f.agent_ring_timeout, status: f.status,
    ...(f.structure !== undefined ? { structure: f.structure } : {}),
});
const audioView = (a) => a && ({
    id: a.id, ref: a.external_ref, name: a.name, storageProvider: a.storage_provider, storageKey: a.storage_key,
    mimeType: a.mime_type, durationSeconds: a.duration_seconds, platformDefault: a.tenant_id == null,
});

// ── Resolution ───────────────────────────────────────────────────────────────

export async function resolveTenant(request) {
    const tenant = await TenantRepository.findByExternalRef(request.consumer.id, ref(request.params.tenantRef, 'tenant'));
    if (!tenant) throw notFound('Tenant');
    return tenant;
}

export async function resolveAgent(tenant, agentRef) {
    const agent = await AgentRepository.findByExternalRef(tenant.id, ref(agentRef, 'agent'));
    if (!agent) throw notFound('Agent');
    return agent;
}

async function resolveQueueRef(tenant, queueRef, field) {
    if (queueRef == null) return null;
    const queue = await QueueRepository.findByExternalRef(tenant.id, ref(queueRef, field));
    if (!queue) throw badRequest(`${field} does not match a queue`);
    return queue;
}

async function resolveChannelRef(tenant, channelRef, field) {
    if (channelRef == null) return null;
    const channel = await ChannelRepository.findByExternalRef(tenant.id, ref(channelRef, field));
    if (!channel) throw badRequest(`${field} does not match a channel`);
    return channel;
}

async function resolveAudioId(tenant, audioId, field) {
    if (audioId == null) return null;
    const asset = await IvrRepository.findAudioAsset(Number(audioId), tenant.id);
    if (!asset) throw badRequest(`${field} does not match an audio asset`);
    return asset.id;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export default async function managementRoutes(fastify) {
    // Tenants
    fastify.put('/tenants/:tenantRef', async (request) => {
        const body = request.body ?? {};
        const tenant = await TenantRepository.upsert(request.consumer.id, ref(request.params.tenantRef, 'tenant'), {
            name: requireString(body, 'name'),
            status: oneOf(body, 'status', ['ACTIVE', 'SUSPENDED'], { optional: true, fallback: 'ACTIVE' }),
            settings: optionalObject(body, 'settings'),
        });
        return { tenant: tenantView(tenant) };
    });

    fastify.get('/tenants/:tenantRef', async (request) => ({ tenant: tenantView(await resolveTenant(request)) }));

    // Agents
    fastify.put('/tenants/:tenantRef/agents/:agentRef', async (request) => {
        const tenant = await resolveTenant(request);
        const body = request.body ?? {};
        const agent = await AgentRepository.upsert(tenant.id, ref(request.params.agentRef, 'agent'), {
            name: requireString(body, 'name'),
            role: oneOf(body, 'role', ['AGENT', 'SUPERVISOR'], { optional: true }),
        });
        return { agent: agentView(agent) };
    });

    fastify.get('/tenants/:tenantRef/agents', async (request) => {
        const tenant = await resolveTenant(request);
        return { agents: (await AgentRepository.getTenantAgents(tenant.id)).map(agentView) };
    });

    fastify.delete('/tenants/:tenantRef/agents/:agentRef', async (request, reply) => {
        const tenant = await resolveTenant(request);
        if (!await AgentRepository.softDelete(tenant.id, ref(request.params.agentRef, 'agent'))) throw notFound('Agent');
        return reply.code(204).send();
    });

    // Force an agent's availability (e.g. the consumer's own "go offline" UI).
    fastify.put('/tenants/:tenantRef/agents/:agentRef/availability', async (request) => {
        const tenant = await resolveTenant(request);
        const agent = await resolveAgent(tenant, request.params.agentRef);
        const availability = oneOf(request.body, 'availability', ['AVAILABLE', 'OFFLINE']);
        if (availability === 'AVAILABLE') await callCleanupService.releaseStaleCallsForUser(agent.id);
        const result = await agentAssignmentCoordinator.setAvailability(tenant.id, agent.id, agent.id, availability);
        return { agent: { ...agentView(agent), availability: result ?? agent.availability } };
    });

    // Push tokens
    fastify.put('/tenants/:tenantRef/agents/:agentRef/push-tokens/:deviceId', async (request) => {
        const tenant = await resolveTenant(request);
        const agent = await resolveAgent(tenant, request.params.agentRef);
        const body = request.body ?? {};
        await PushTokenRepository.register(agent.id, {
            deviceId: ref(request.params.deviceId, 'device'),
            platform: oneOf(body, 'platform', ['ANDROID', 'IOS', 'WEB']),
            provider: oneOf(body, 'provider', ['FCM', 'APNS_VOIP', 'ONESIGNAL']),
            token: requireString(body, 'token', { max: 512 }),
        });
        return { registered: true };
    });

    fastify.delete('/tenants/:tenantRef/agents/:agentRef/push-tokens/:deviceId', async (request, reply) => {
        const tenant = await resolveTenant(request);
        const agent = await resolveAgent(tenant, request.params.agentRef);
        await PushTokenRepository.unregisterDevice(agent.id, ref(request.params.deviceId, 'device'));
        return reply.code(204).send();
    });

    // Queues
    fastify.put('/tenants/:tenantRef/queues/:queueRef', async (request) => {
        const tenant = await resolveTenant(request);
        const body = request.body ?? {};
        const overflow = await resolveQueueRef(tenant, body.overflow_queue_ref, 'overflow_queue_ref');
        const queue = await QueueRepository.upsert(tenant.id, ref(request.params.queueRef, 'queue'), {
            name: requireString(body, 'name'),
            strategy: oneOf(body, 'strategy', ['RING_ALL', 'ROUND_ROBIN', 'PRIORITY'], { optional: true, fallback: 'ROUND_ROBIN' }),
            ring_timeout_seconds: optionalInt(body, 'ring_timeout_seconds', { min: 5, max: 600 }),
            max_active_calls: optionalInt(body, 'max_active_calls', { min: 1, max: 10000 }),
            max_wait_seconds: optionalInt(body, 'max_wait_seconds', { min: 5, max: 86400 }),
            overflow_queue_id: overflow?.id ?? null,
            hold_audio_asset_id: await resolveAudioId(tenant, body.hold_audio_asset_id, 'hold_audio_asset_id'),
            status: oneOf(body, 'status', ['ACTIVE', 'DISABLED'], { optional: true, fallback: 'ACTIVE' }),
        });
        return { queue: queueView(queue) };
    });

    fastify.get('/tenants/:tenantRef/queues', async (request) => {
        const tenant = await resolveTenant(request);
        return { queues: (await QueueRepository.listForTenant(tenant.id)).map(queueView) };
    });

    // Replace the member list: { members: [{ agent_ref, priority? }] }
    fastify.put('/tenants/:tenantRef/queues/:queueRef/members', async (request) => {
        const tenant = await resolveTenant(request);
        const queue = await QueueRepository.findByExternalRef(tenant.id, ref(request.params.queueRef, 'queue'));
        if (!queue) throw notFound('Queue');
        const list = request.body?.members;
        if (!Array.isArray(list)) throw badRequest('members must be an array');

        const members = [];
        for (const [i, m] of list.entries()) {
            const agent = await AgentRepository.findByExternalRef(tenant.id, ref(m?.agent_ref, `members[${i}].agent_ref`));
            if (!agent) throw badRequest(`members[${i}].agent_ref does not match an agent`);
            members.push({ agentId: agent.id, priority: optionalInt(m, 'priority', { min: 1, max: 1000 }) ?? 1 });
        }
        await QueueRepository.replaceMembers(queue.id, members);
        await agentAssignmentCoordinator.emitQueueUpdate(tenant.id, queue.id).catch(() => { });
        return { members: (await QueueRepository.getMembers(queue.id)).map((a) => ({ ...agentView(a), priority: a.priority })) };
    });

    // Channels
    fastify.put('/tenants/:tenantRef/channels/:channelRef', async (request) => {
        const tenant = await resolveTenant(request);
        const body = request.body ?? {};
        const type = oneOf(body, 'type', Object.values(Channel));
        const inboundQueue = await resolveQueueRef(tenant, body.inbound_queue_ref, 'inbound_queue_ref');
        const credentials = body.credentials === undefined ? undefined : optionalObject(body, 'credentials');
        // Each channel adapter validates its own provider fields.
        const configError = customerChannels.has(type) ? customerChannels.get(type).validateChannelConfig?.(body) : null;
        if (configError) throw badRequest(configError);
        // A SIP channel's trunk: a platform trunk, or one of this consumer's own.
        const sipTrunkId = body.sip_trunk_id != null ? optionalInt(body, 'sip_trunk_id', { min: 1 }) : null;
        if (sipTrunkId != null && !SipTrunkRepository.usableBy(await SipTrunkRepository.findById(sipTrunkId), request.consumer.id)) {
            throw badRequest('sip_trunk_id is not a trunk this consumer can use');
        }

        let channel;
        try {
            channel = await ChannelRepository.upsert(tenant.id, ref(request.params.channelRef, 'channel'), {
                type,
                display_name: requireString(body, 'display_name', { optional: true }),
                address: requireString(body, 'address', { max: 50 }),
                provider_account_id: body.provider_account_id != null ? String(body.provider_account_id) : null,
                sip_trunk_id: sipTrunkId,
                credentials,
                inbound_queue_id: inboundQueue?.id ?? null,
                recording_enabled: Boolean(body.recording_enabled),
                status: oneOf(body, 'status', ['ACTIVE', 'DISABLED'], { optional: true, fallback: 'ACTIVE' }),
            });
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') throw badRequest('Another channel already uses this address or provider account');
            throw err;
        }
        return { channel: channelView(channel) };
    });

    fastify.get('/tenants/:tenantRef/channels', async (request) => {
        const tenant = await resolveTenant(request);
        return { channels: (await ChannelRepository.listForTenant(tenant.id)).map(channelView) };
    });

    // IVR flows
    fastify.put('/tenants/:tenantRef/ivr-flows/:flowRef', async (request) => {
        const tenant = await resolveTenant(request);
        const body = request.body ?? {};
        const structure = optionalObject(body, 'structure');
        if (!structure || !Array.isArray(structure.nodes) || !Array.isArray(structure.edges)) {
            throw badRequest('structure must be { nodes: [], edges: [] }');
        }
        const channel = await resolveChannelRef(tenant, body.channel_ref, 'channel_ref');
        const flow = await IvrRepository.upsertFlow(tenant.id, ref(request.params.flowRef, 'ivr flow'), {
            channel_id: channel?.id ?? null,
            name: requireString(body, 'name'),
            schema_version: optionalInt(body, 'schema_version', { min: 1, max: 1 }) ?? 1,
            structure,
            trigger_condition: oneOf(body, 'trigger_condition',
                ['ALWAYS', 'ALL_AGENTS_BUSY', 'ALL_AGENTS_OFFLINE', 'ALL_AGENTS_UNAVAILABLE'], { optional: true, fallback: 'ALWAYS' }),
            trigger_priority: optionalInt(body, 'trigger_priority', { min: 0, max: 10000 }) ?? 0,
            timeout_seconds: optionalInt(body, 'timeout_seconds', { min: 1, max: 120 }) ?? 10,
            agent_ring_timeout: optionalInt(body, 'agent_ring_timeout', { min: 5, max: 600 }) ?? 60,
            status: oneOf(body, 'status', ['ACTIVE', 'INACTIVE'], { optional: true, fallback: 'INACTIVE' }),
        });
        return { ivrFlow: flowView(flow) };
    });

    fastify.get('/tenants/:tenantRef/ivr-flows', async (request) => {
        const tenant = await resolveTenant(request);
        return { ivrFlows: (await IvrRepository.listFlows(tenant.id)).map(flowView) };
    });

    // Audio assets: register an object already in storage (storage_key), or
    // upload one inline (content_base64, stored under audio/<tenant>/…).
    fastify.post('/tenants/:tenantRef/audio-assets', { bodyLimit: 15 * 1024 * 1024 }, async (request, reply) => {
        const tenant = await resolveTenant(request);
        const body = request.body ?? {};
        const name = requireString(body, 'name');
        let storageKey = requireString(body, 'storage_key', { max: 512, optional: true });
        let storageProvider = oneOf(body, 'storage_provider', ['S3', 'LOCAL'], { optional: true, fallback: 'S3' }).toLowerCase();
        let size = null;

        if (body.content_base64) {
            if (!storageClient.isInitialized) throw badRequest('Object storage is not configured — register an existing storage_key instead');
            const buffer = Buffer.from(String(body.content_base64), 'base64');
            if (!buffer.length) throw badRequest('content_base64 is empty');
            const mime = requireString(body, 'mime_type', { max: 100 });
            storageKey = `audio/${tenant.id}/${Date.now()}_${name.replace(/[^\w.-]+/g, '_').slice(0, 80)}`;
            await storageClient.uploadFile(storageKey, buffer, mime);
            storageProvider = 's3';
            size = buffer.length;
        }
        if (!storageKey) throw badRequest('storage_key or content_base64 is required');

        const asset = await IvrRepository.createAudioAsset(tenant.id, {
            external_ref: body.ref != null ? ref(body.ref, 'audio asset') : null,
            name,
            storage_provider: storageProvider,
            storage_key: storageKey,
            mime_type: requireString(body, 'mime_type', { max: 100, optional: true }),
            duration_seconds: optionalInt(body, 'duration_seconds', { min: 0, max: 86400 }),
            file_size_bytes: size,
        });
        return reply.code(201).send({ audioAsset: audioView(asset) });
    });

    fastify.get('/tenants/:tenantRef/audio-assets', async (request) => {
        const tenant = await resolveTenant(request);
        return { audioAssets: (await IvrRepository.listAudioAssets(tenant.id)).map(audioView) };
    });
}
