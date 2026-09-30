// src/core/events/ConsumerEventPublisher.js
// Turns call-domain events into consumer-facing events (docs/events.md)
// and writes them to the webhook_deliveries outbox. Delivery happens in
// the outbox dispatcher, never inline — a slow or failing consumer can't hold
// up a call.
import EventBus from '../EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import OutboxRepository from '../../persistence/OutboxRepository.js';
import { toConsumerCallView } from '../calls/CallView.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.events.ConsumerEventPublisher');

export const API_VERSION = '2026-09-25';

// Events that describe a one-time transition of a call. Several workers can
// observe the same transition (e.g. a terminate handled by the webhook worker
// and by the worker owning the media), so these are written at most once:
// the outbox row's unique dedupe_key decides, so a write that fails leaves
// nothing behind and the next attempt (or another worker) can still make it.
const ONCE_PER_CALL = new Set(['call.created', 'call.answered', 'call.ended']);

// A failed outbox write is retried after these delays (ms) before the event
// is given up — a lost event is one the consumer never hears about.
const WRITE_RETRY_DELAYS_MS = [200, 1000, 3000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ConsumerEventPublisher {
    constructor() {
        this._registered = false;
    }

    async #tenantContext(tenantId) {
        const tenant = await TenantRepository.findById(tenantId);
        return tenant ? { consumerId: tenant.consumer_id, tenantRef: tenant.external_ref } : null;
    }

    // Writes an event to the outbox, retrying transient failures.
    async #enqueue(event, logFields) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await OutboxRepository.enqueue(event);
            } catch (err) {
                if (attempt >= WRITE_RETRY_DELAYS_MS.length) {
                    log.error({ ...logFields, eventType: event.eventType, err, attempts: attempt + 1 }, 'Event lost: the outbox write kept failing');
                    return null;
                }
                log.warn({ ...logFields, eventType: event.eventType, err, attempt: attempt + 1 }, 'Outbox write failed — retrying');
                await sleep(WRITE_RETRY_DELAYS_MS[attempt]);
            }
        }
    }

    async publishForCall(callId, eventType, data = {}) {
        try {
            const dedupeKey = ONCE_PER_CALL.has(eventType) ? `${callId}:${eventType}` : null;
            // Cheap early exit for the common duplicate; the unique key is what guarantees it.
            if (dedupeKey && await OutboxRepository.existsByDedupeKey(dedupeKey)) return null;

            const call = await CallRepository.findById(callId);
            if (!call) return null;
            const ctx = await this.#tenantContext(call.tenant_id);
            if (!ctx) return null;

            const agent = call.agent_id ? await AgentRepository.findById(call.agent_id) : null;
            const payload = {
                event_type: eventType,
                api_version: API_VERSION,
                occurred_at: new Date().toISOString(),
                tenant_ref: ctx.tenantRef,
                data: {
                    call: toConsumerCallView(call, {
                        tenantRef: ctx.tenantRef,
                        agentRef: agent?.external_ref ?? null,
                        agentName: agent?.name ?? null,
                    }),
                    ...data,
                },
            };
            return await this.#enqueue({
                consumerId: ctx.consumerId,
                tenantId: call.tenant_id,
                callId,
                eventType,
                payload,
                dedupeKey,
            }, { callId });
        } catch (err) {
            log.error({ callId, err }, `Failed to publish ${eventType}`);
            return null;
        }
    }

    async publishAgentAvailability(agentId, availability, extra = {}) {
        try {
            const agent = await AgentRepository.findById(agentId);
            if (!agent) return null;
            const ctx = await this.#tenantContext(agent.tenant_id);
            if (!ctx) return null;
            return await this.#enqueue({
                consumerId: ctx.consumerId,
                tenantId: agent.tenant_id,
                eventType: 'agent.availability.changed',
                payload: {
                    event_type: 'agent.availability.changed',
                    api_version: API_VERSION,
                    occurred_at: new Date().toISOString(),
                    tenant_ref: ctx.tenantRef,
                    data: { agent_ref: agent.external_ref, agent_id: agent.id, availability, ...extra },
                },
            }, { agentId });
        } catch (err) {
            log.error({ agentId, err }, 'Failed to publish availability');
            return null;
        }
    }

    // Bridges in-process call events to consumer events. Registered once per worker.
    register() {
        if (this._registered) return;
        this._registered = true;

        EventBus.on('call:incoming', (payload) => {
            if (payload.assignmentType === 'IVR') return;
            const eventType = payload.agentId ? 'call.assigned' : 'call.queued';
            this.publishForCall(payload.callId, eventType, {
                assignment_type: payload.assignmentType,
                offered_agent_ids: payload.offeredAgentIds ?? [],
            });
        });
        EventBus.on('call:waiting', ({ callId }) => this.publishForCall(callId, 'call.queued'));
        EventBus.on('call:handled', ({ callId, action }) => {
            if (action === 'accepted') this.publishForCall(callId, 'call.answered');
        });
        EventBus.on('call:status', ({ callId, status }) => {
            if (status === 'RINGING') this.publishForCall(callId, 'call.ringing');
        });
        EventBus.on('call:transferred', ({ callId, userId, oldAgentId, targetQueueId }) =>
            this.publishForCall(callId, 'call.transferred', {
                from_agent_id: oldAgentId ?? null,
                to_agent_id: userId ?? null,
                to_queue_id: targetQueueId ?? null,
            })
        );
        EventBus.on('call:overflowed', ({ callId, fromQueueId, toQueueId }) =>
            this.publishForCall(callId, 'call.overflowed', { from_queue_id: fromQueueId, to_queue_id: toQueueId })
        );
        EventBus.on('call:terminated', ({ callId }) => this.publishForCall(callId, 'call.ended'));
        EventBus.on('call:ivr_session_closed', ({ callId, outcome, durationSeconds }) =>
            this.publishForCall(callId, 'call.ivr.completed', { outcome, duration_seconds: durationSeconds ?? null })
        );
        EventBus.on('call:agent_availability', ({ userId, availability, reason }) =>
            this.publishAgentAvailability(userId, availability, reason ? { reason } : {})
        );
        EventBus.on('recording:completed', ({ callId, recordingId, durationSeconds }) =>
            this.publishForCall(callId, 'recording.completed', {
                recording_id: recordingId,
                duration_seconds: durationSeconds ?? null,
            })
        );
    }
}

export const consumerEventPublisher = new ConsumerEventPublisher();
