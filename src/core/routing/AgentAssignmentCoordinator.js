// src/core/routing/AgentAssignmentCoordinator.js
// Single entry point for anything that changes agent/queue state: releasing
// agents after a call, availability changes, draining queues when an agent
// frees up, assigning transferred calls, and passing an offer on (declined,
// rang out) or moving a call to its overflow queue.
import EventBus from '../EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import QueueRepository from '../../persistence/QueueRepository.js';
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import { mediaLegs } from '../media/MediaLegs.js';
import { callInbox } from '../../infra/cluster/CallInbox.js';
import { EventTypes } from '../events/EventTypes.js';
import { callAgentAssignmentService } from './CallAgentAssignmentService.js';
import { queueRouter } from './QueueRouter.js';
import { callLifecycleLogger } from '../calls/CallLifecycleLogger.js';
import { ConnectionType, AssignmentType, AgentAvailability, AgentRole, CallStatus } from '../constants/CallConstants.js';
import { IncomingCallPayload } from '../calls/IncomingCallPayload.js';
import { presenceService } from '../agents/PresenceService.js';
import { offerHistory } from './OfferHistory.js';
import { autoOfflinePolicy } from './AutoOfflinePolicy.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.routing.AgentAssignmentCoordinator');

const ACTIVE_STATUSES = new Set([CallStatus.INITIATED, CallStatus.RINGING, CallStatus.IN_PROGRESS]);

class AgentAssignmentCoordinator {
    constructor() {
        this._callEventCallback = null;
    }

    setCallEventCallback(fn) {
        this._callEventCallback = fn;
    }

    // ── Queue snapshots ──────────────────────────────────────────────────────

    // Emits a fresh snapshot for one queue, or for every queue of the tenant.
    async emitQueueUpdate(tenantId, queueId = null) {
        if (!tenantId) return;
        const queues = queueId
            ? [await QueueRepository.findForTenant(queueId, tenantId)].filter(Boolean)
            : await QueueRepository.listForTenant(tenantId);
        for (const queue of queues) {
            const members = await QueueRepository.getMembers(queue.id);
            const snapshot = await callAgentAssignmentService.buildQueueSnapshot(queue, members);
            EventBus.emit('call:agent_queue', snapshot);
        }
    }

    // Fresh snapshots for the queues this agent is a member of (their status
    // changed); nothing for an agent in no queue.
    async emitAgentQueues(tenantId, agentId) {
        if (!tenantId || !agentId) return;
        for (const queueId of await QueueRepository.getQueueIdsForAgent(agentId)) {
            await this.emitQueueUpdate(tenantId, queueId);
        }
    }

    async getQueueSnapshots(tenantId) {
        const queues = await QueueRepository.listForTenant(tenantId);
        return Promise.all(queues.map(async (queue) =>
            callAgentAssignmentService.buildQueueSnapshot(queue, await QueueRepository.getMembers(queue.id))
        ));
    }

    // ── Availability ─────────────────────────────────────────────────────────
    //
    // Two facts (AgentRepository): the shift (availability) and the call
    // holding the agent (busy_call_id). Agents report ON_CALL while busy, else
    // their shift; every broadcast below sends that reported status.

    /**
     * The call no longer holds the agent: after it ended, the agent passed the
     * offer on, it overflowed, or it was transferred away. Exact — a release
     * for a call that doesn't hold them does nothing. offline: the agent is
     * gone (never reconnected), so their shift ends too.
     */
    async releaseAgent(agentId, callId, { offline = false } = {}) {
        if (!agentId || !callId) return false;
        const released = await AgentRepository.releaseFromCall(agentId, callId);
        if (offline) await AgentRepository.updateAgentAvailability(agentId, AgentAvailability.OFFLINE);
        if (released || offline) {
            const agent = await this._broadcastCurrent(agentId);
            if (agent) await this.emitAgentQueues(agent.tenantId, agentId).catch((err) => log.error({ agentId, err }, 'Queue update failed'));
        }
        return released;
    }

    // An agent's reported status, read back and broadcast ({ tenantId,
    // availability }). Centralized so the "tell the agent's own socket"
    // broadcast can't be forgotten.
    async _broadcastCurrent(agentId, extra = {}) {
        try {
            const agent = await AgentRepository.findById(agentId);
            if (!agent) return null;
            this._broadcast(agent.tenant_id, agentId, agent.availability, extra);
            return { tenantId: agent.tenant_id, availability: agent.availability };
        } catch (err) {
            log.error({ agentId, err }, 'Failed to broadcast availability');
            return null;
        }
    }

    _broadcast(tenantId, agentId, availability, extra = {}) {
        EventBus.emit('call:agent_availability', {
            tenantId,
            userId: agentId,
            availability,
            updatedAt: new Date().toISOString(),
            ...extra,
        });
    }

    /**
     * An agent (or a supervisor, for another agent of the same tenant) sets
     * their shift. ON_CALL can't be set by hand — it follows real calls. A busy
     * agent still reports ON_CALL; the shift applies to queues from their next
     * call. Returns the resulting reported status, or null if refused.
     */
    async setAvailability(tenantId, actorAgentId, targetAgentId, availability) {
        if (![AgentAvailability.AVAILABLE, AgentAvailability.OFFLINE].includes(availability)) return null;

        const target = await AgentRepository.findById(targetAgentId);
        if (!target || String(target.tenant_id) !== String(tenantId)) return null;
        if (String(actorAgentId) !== String(targetAgentId)) {
            const actor = await AgentRepository.findById(actorAgentId);
            if (actor?.role !== AgentRole.SUPERVISOR || String(actor.tenant_id) !== String(tenantId)) {
                log.warn({ agentId: actorAgentId, targetAgentId }, 'Agent may not set availability for another agent');
                return null;
            }
        }

        await AgentRepository.updateAgentAvailability(targetAgentId, availability);
        const reported = target.busy_call_id ? AgentAvailability.ON_CALL : availability;
        // Setting the same value again still confirms it to the agent's sockets,
        // but isn't a change for the consumer (changed: false).
        this._broadcast(tenantId, targetAgentId, reported, { changed: target.availability !== reported });

        if (reported === AgentAvailability.AVAILABLE) {
            await this.drainForTenant(tenantId).catch((err) =>
                log.error({ tenantId, err }, 'Drain after availability change failed')
            );
        }
        await this.emitQueueUpdate(tenantId).catch(() => { });
        return reported;
    }

    /**
     * Re-reads an agent's status and broadcasts it (a client resync). Safety
     * net for the agent's own resync: a call that ended without releasing them
     * releases them now.
     */
    async syncAgentAvailability(tenantId, actorAgentId, targetAgentId) {
        try {
            const target = await AgentRepository.findById(targetAgentId);
            if (!target || String(target.tenant_id) !== String(tenantId)) return;

            if (String(actorAgentId) !== String(targetAgentId)) {
                const actor = await AgentRepository.findById(actorAgentId);
                if (actor?.role !== AgentRole.SUPERVISOR) return;
            }

            let availability = target.availability;
            if (target.busy_call_id && String(actorAgentId) === String(targetAgentId)) {
                const call = await CallRepository.findById(target.busy_call_id);
                if (!call || !ACTIVE_STATUSES.has(call.status)) {
                    if (await AgentRepository.releaseFromCall(targetAgentId, target.busy_call_id)) {
                        log.info({ agentId: targetAgentId, callId: target.busy_call_id }, 'Safety net: released an agent held by an ended call');
                    }
                    availability = (await AgentRepository.findById(targetAgentId))?.availability ?? availability;
                }
            }

            this._broadcast(tenantId, targetAgentId, availability, {
                changed: availability !== target.availability,   // a resync is only a change after the safety net
            });

            if (availability === AgentAvailability.AVAILABLE) {
                const assigned = await this.drainForTenant(tenantId);
                if (!assigned) await this.emitQueueUpdate(tenantId);
            }
        } catch (error) {
            log.error({ tenantId, agentId: targetAgentId, err: error }, 'Availability sync failed');
        }
    }

    /**
     * Safety net, from the cleanup loop: agents still held by a call that has
     * ended or was deleted (a release lost to a crash) are released, and their
     * tenants' queues drained. Every worker runs it; the guarded release lets
     * one of them do each.
     */
    async releaseAgentsOfEndedCalls() {
        const held = await AgentRepository.findHeldByEndedCalls();
        const tenants = new Set();
        for (const { id, tenant_id: tenantId, busy_call_id: callId } of held) {
            if (!await AgentRepository.releaseFromCall(id, callId)) continue;
            log.warn({ agentId: id, callId }, 'Released an agent still held by an ended call');
            await this._broadcastCurrent(id);
            tenants.add(tenantId);
        }
        for (const tenantId of tenants) {
            await this.drainForTenant(tenantId).catch((err) => log.error({ tenantId, err }, 'Drain after release failed'));
        }
        return held.length;
    }

    // ── Queue draining ───────────────────────────────────────────────────────

    // Kept under its original name for the many call-ending paths that trigger
    // it: an agent may have freed up, so drain the tenant's queues, longest
    // wait first. Returns true if any call was assigned.
    async assignOldestUnassignedCall(tenantId) {
        return this.drainForTenant(tenantId);
    }

    async drainForTenant(tenantId) {
        if (!tenantId) return false;
        const queueIds = await CallRepository.findQueuesWithWaitingCalls(tenantId);
        let assignedAny = false;
        for (const queueId of queueIds) {
            const queue = await queueRouter.getQueue(queueId);
            if (!queue || queueRouter.isRingAll(queue)) continue;
            if (await this.drainQueue(queue)) assignedAny = true;
        }
        return assignedAny;
    }

    /**
     * Assigns the oldest waiting call of a queue that an available member can
     * take. Retries when another worker won a claim race. Returns true if a
     * call was assigned.
     */
    async drainQueue(queue) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const members = await queueRouter.getMembers(queue);
            if (!members.some((a) => a.availability === AgentAvailability.AVAILABLE)) return false;

            const waiting = await CallRepository.findOldestUnassignedCalls(queue.id, 25);
            if (!waiting.length) return false;

            let raceLost = false;
            for (const call of waiting) {
                const eligible = await offerHistory.eligible(call.id, members);
                const { agent, takenByAnotherWorker } = await queueRouter.claimForWaitingCall(queue, call.id, eligible);
                if (!agent) {
                    if (takenByAnotherWorker) raceLost = true;
                    continue;
                }
                await this.#deliverAssignedCall(call, agent, AssignmentType.QUEUED);
                await this.emitQueueUpdate(call.tenant_id, queue.id);
                return true;
            }
            if (!raceLost) return false;
        }
        return false;
    }

    /**
     * Assigns a specific call (IVR transfer, agent transfer into a queue).
     *   targetType 'agent' → that agent, if available
     *   targetType 'queue' → the queue's strategy (the call's queue_id must
     *                        already point at it)
     * Returns true if assigned; false leaves the call waiting in its queue.
     */
    async assignTransferredCall(callId, callRecord, tenantId, targetType = 'queue', targetId = null) {
        let agent = null;

        if (targetType === 'agent' && targetId) {
            const candidate = await AgentRepository.findById(targetId);
            if (candidate && String(candidate.tenant_id) === String(tenantId)
                && candidate.availability === AgentAvailability.AVAILABLE) {
                const { assigned } = await AgentRepository.claimAgentAndAssignCall(candidate.id, callId);
                if (assigned) agent = candidate;
            }
        } else {
            const queue = await queueRouter.getQueue(targetId ?? callRecord.queue_id);
            if (queue && !queueRouter.isRingAll(queue)) {
                ({ agent } = await queueRouter.claimForWaitingCall(queue, callId));
            } else if (queue) {
                await this.#offerToAll(queue, callId);
                await this.emitQueueUpdate(tenantId, queue.id);
                return false;
            }
        }

        if (agent) {
            const call = await CallRepository.findById(callId);
            if (call) await this.#deliverAssignedCall(call, agent, AssignmentType.QUEUED);
            await this.emitQueueUpdate(tenantId, callRecord.queue_id);
            log.info({ callId, toAgentId: agent.id }, 'Transferred call assigned to an agent');
            return true;
        }

        await this.emitQueueUpdate(tenantId, callRecord.queue_id);
        EventBus.emit('call:waiting', { callId, tenantId, queueId: callRecord.queue_id });
        log.info({ callId }, 'Transferred call waiting in queue (no available agent)');
        return false;
    }

    // ── Offers passing on ──────────────────────────────────────────────────────

    /**
     * An offer from a queue that the agent declined, or that rang out
     * (queues.ring_timeout_seconds): the call keeps its place in the queue and
     * is offered to the next member. kind: 'declined' | 'missed'.
     * expiredBefore (ring timeout): only withdraw an offer made before then.
     * Returns false if the offer was no longer this agent's to pass on
     * (answered meanwhile, or already withdrawn).
     */
    async passOffer(call, agentId, kind, { expiredBefore = null } = {}) {
        if (!await CallRepository.withdrawOffer(call.id, agentId, expiredBefore)) return false;
        await offerHistory.record(call.id, agentId, kind);

        EventBus.emit('call:offer_withdrawn', {
            callId: call.id,
            tenantId: call.tenant_id,
            agentIds: [agentId],
            reason: kind === 'missed' ? 'timeout' : 'declined',
        });
        await this.releaseAgent(agentId, call.id);

        if (kind === 'missed') {
            callLifecycleLogger.logOfferMissed(call.id, call.tenant_id, agentId, { queue_id: call.queue_id })
                .catch((err) => log.error({ callId: call.id, err }, 'Missed-offer log failed'));
            await autoOfflinePolicy.recordMiss({ callId: call.id, tenantId: call.tenant_id, queueId: call.queue_id, agentId });
        } else {
            callLifecycleLogger.logRejected(call.id, call.tenant_id, agentId, { reason: 'agent_declined_offer', queue_id: call.queue_id })
                .catch((err) => log.error({ callId: call.id, err }, 'Decline log failed'));
        }
        log.debug({ callId: call.id, agentId }, `Offer ${kind} — passing it`);

        await this.routeWaitingCall({ ...call, agent_id: null });
        return true;
    }

    /**
     * A waiting call moved to its overflow queue (CallRepository.overflowToQueue
     * already committed the move). Whoever it was ringing stops ringing, and the
     * new queue offers it.
     */
    async callOverflowed(call, toQueue) {
        const fromQueue = await QueueRepository.findById(call.queue_id);
        const withdrawFrom = call.agent_id
            ? [call.agent_id]
            : (fromQueue && queueRouter.isRingAll(fromQueue) ? await QueueRepository.getMemberIds(fromQueue.id) : []);
        if (withdrawFrom.length) {
            EventBus.emit('call:offer_withdrawn', {
                callId: call.id, tenantId: call.tenant_id, agentIds: withdrawFrom, reason: 'overflow',
            });
        }
        if (call.agent_id) await this.releaseAgent(call.agent_id, call.id);
        await offerHistory.clearMissed(call.id);

        callLifecycleLogger.logOverflowed(call.id, call.tenant_id, {
            from_queue_id: call.queue_id, to_queue_id: toQueue.id, waited_seconds: call.max_wait_seconds ?? null,
        }).catch((err) => log.error({ callId: call.id, err }, 'Overflow log failed'));
        EventBus.emit('call:overflowed', {
            callId: call.id, tenantId: call.tenant_id, fromQueueId: call.queue_id, toQueueId: toQueue.id,
        });
        log.info({ callId: call.id, queueId: call.queue_id, toQueueId: toQueue.id }, 'Call overflowed to another queue');

        await this.emitQueueUpdate(call.tenant_id, call.queue_id);
        await this.routeWaitingCall({ ...call, queue_id: toQueue.id, agent_id: null });
    }

    /**
     * Offers a call that is waiting in its queue: RING_ALL rings every
     * available member; otherwise the queue drains (oldest waiting call
     * first — FIFO holds even when this call is the one that just moved).
     */
    async routeWaitingCall(call) {
        const queue = await queueRouter.getQueue(call.queue_id);
        if (!queue) {
            EventBus.emit('call:waiting', { callId: call.id, tenantId: call.tenant_id, queueId: call.queue_id ?? null });
            return false;
        }
        if (queueRouter.isRingAll(queue)) {
            await this.#offerToAll(queue, call.id);
            await this.emitQueueUpdate(call.tenant_id, queue.id);
            return false;
        }
        await this.drainQueue(queue);
        const after = await CallRepository.findById(call.id);
        const offered = after?.agent_id != null;
        if (!offered && after?.status === 'RINGING') {
            EventBus.emit('call:waiting', { callId: call.id, tenantId: call.tenant_id, queueId: queue.id });
        }
        await this.emitQueueUpdate(call.tenant_id, queue.id);
        return offered;
    }

    // RING_ALL: every available member is offered the call; first accept claims it.
    async #offerToAll(queue, callId) {
        const call = await CallRepository.findById(callId);
        if (!call) return;
        const offered = (await offerHistory.eligible(callId, await queueRouter.ringAllTargets(queue)));
        if (!offered.length) {
            EventBus.emit('call:waiting', { callId, tenantId: call.tenant_id, queueId: queue.id });
            return;
        }
        const sdpOffer = await this.#agentOffer(callId);
        EventBus.emit('call:incoming', IncomingCallPayload.fromCall(call, {
            agentId: null,
            offeredAgentIds: offered.map((a) => a.id),
            sdpOffer,
            assignmentType: AssignmentType.QUEUED,
        }));
    }

    // The agent leg's offer for a call: reuse the one already made on the
    // worker holding the customer's leg (arrival or IvrTransferHandler made it
    // there), so the agent's answer reaches the worker that can bridge it.
    // Without one, the worker that owns the call makes it — this worker if it
    // can take the lease, else through the call's inbox.
    async #agentOffer(callId) {
        const stored = await mediaLegs.storedAgentOffer(callId);
        if (stored) return stored;
        if (this._callEventCallback && await callInbox.own(callId, this._callEventCallback)) {
            return mediaLegs.offerAgent(await CallRepository.findById(callId));
        }
        return callInbox.request(callId, EventTypes.OFFER_AGENT, { callId });
    }

    async #deliverAssignedCall(call, agent, assignmentType) {
        const socketCount = await presenceService.getUserSocketCount(agent.id);
        await callLifecycleLogger.logAssigned(call.id, call.tenant_id, agent.id, {
            assignment_type: assignmentType,
            queue_id: call.queue_id ?? null,
            agent_connected: socketCount > 0,
            agent_socket_count: socketCount,
        });

        const sdpOffer = await this.#agentOffer(call.id);
        EventBus.emit('call:incoming', IncomingCallPayload.fromCall(
            { ...call, agent_id: agent.id },
            { agentId: agent.id, agentName: agent.name ?? null, sdpOffer, assignmentType }
        ));

        // The claim already made the agent busy (ON_CALL) — tell their own socket.
        EventBus.emit('call:agent_availability', {
            tenantId: call.tenant_id,
            userId: agent.id,
            availability: AgentAvailability.ON_CALL,
            updatedAt: new Date().toISOString(),
        });
    }
}

export const agentAssignmentCoordinator = new AgentAssignmentCoordinator();
