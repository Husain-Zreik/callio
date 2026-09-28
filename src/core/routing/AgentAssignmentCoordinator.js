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
import { sdpCoordinator } from '../../media/webrtc/SDPCoordinator.js';
import { callAgentAssignmentService } from './CallAgentAssignmentService.js';
import { queueRouter } from './QueueRouter.js';
import { callLifecycleLogger } from '../calls/CallLifecycleLogger.js';
import { ConnectionType, AssignmentType, AgentAvailability, AgentRole } from '../constants/CallConstants.js';
import { IncomingCallPayload } from '../calls/IncomingCallPayload.js';
import { presenceService } from '../agents/PresenceService.js';
import { offerHistory } from './OfferHistory.js';
import { autoOfflinePolicy } from './AutoOfflinePolicy.js';

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

    async getQueueSnapshots(tenantId) {
        const queues = await QueueRepository.listForTenant(tenantId);
        return Promise.all(queues.map(async (queue) =>
            callAgentAssignmentService.buildQueueSnapshot(queue, await QueueRepository.getMembers(queue.id))
        ));
    }

    // ── Availability ─────────────────────────────────────────────────────────

    // Centralized so the "tell the agent's own socket" broadcast can't be
    // forgotten at any of the call-ending paths that release an agent.
    async releaseAgentIfIdle(agentId) {
        if (!agentId) return false;
        const released = await AgentRepository.setAgentAvailableIfNoActiveCalls(agentId);
        if (released) await this._broadcastAvailability(agentId, AgentAvailability.AVAILABLE);
        return released;
    }

    // Outbound calls end with the agent OFFLINE rather than AVAILABLE: safer
    // than auto-queueing them into inbound routing right after placing a call.
    async releaseAgentOfflineIfIdle(agentId) {
        if (!agentId) return false;
        const released = await AgentRepository.setAgentOfflineIfNoActiveCalls(agentId);
        if (released) await this._broadcastAvailability(agentId, AgentAvailability.OFFLINE);
        return released;
    }

    async _broadcastAvailability(agentId, availability, extra = {}) {
        try {
            const tenantId = await AgentRepository.getTenantId(agentId);
            if (!tenantId) return;
            EventBus.emit('call:agent_availability', {
                tenantId,
                userId: agentId,
                availability,
                updatedAt: new Date().toISOString(),
                ...extra,
            });
        } catch (err) {
            console.error(`[AgentAssignmentCoordinator] Failed to broadcast availability for agent ${agentId}:`, err);
        }
    }

    /**
     * An agent (or a supervisor, for another agent of the same tenant) sets
     * availability. ON_CALL can't be set by hand — it follows real calls.
     * Returns the resulting availability, or null if refused.
     */
    async setAvailability(tenantId, actorAgentId, targetAgentId, availability) {
        if (![AgentAvailability.AVAILABLE, AgentAvailability.OFFLINE].includes(availability)) return null;

        const target = await AgentRepository.findById(targetAgentId);
        if (!target || String(target.tenant_id) !== String(tenantId)) return null;
        if (String(actorAgentId) !== String(targetAgentId)) {
            const actor = await AgentRepository.findById(actorAgentId);
            if (actor?.role !== AgentRole.SUPERVISOR || String(actor.tenant_id) !== String(tenantId)) {
                console.warn(`[AgentAssignmentCoordinator] Agent ${actorAgentId} may not set availability for agent ${targetAgentId}`);
                return null;
            }
        }

        // An agent on a live call stays ON_CALL until it ends.
        if (target.availability === AgentAvailability.ON_CALL
            && await CallRepository.hasAgentActiveCall(targetAgentId, 0)) {
            return AgentAvailability.ON_CALL;
        }

        await AgentRepository.updateAgentAvailability(targetAgentId, availability);
        await this._broadcastAvailability(targetAgentId, availability);

        if (availability === AgentAvailability.AVAILABLE) {
            await this.drainForTenant(tenantId).catch((err) =>
                console.error(`[AgentAssignmentCoordinator] Drain after availability change failed for tenant ${tenantId}:`, err)
            );
        }
        await this.emitQueueUpdate(tenantId).catch(() => { });
        return availability;
    }

    /**
     * Re-reads an agent's availability and broadcasts it (a client resync).
     * Safety net: an agent stuck ON_CALL with no active call (a connect +
     * terminate webhook race) is released to OFFLINE — safer than AVAILABLE,
     * which would push them into routing on a page refresh.
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
            if (availability === AgentAvailability.ON_CALL && String(actorAgentId) === String(targetAgentId)) {
                if (await AgentRepository.setAgentOfflineIfNoActiveCalls(targetAgentId)) {
                    console.log(`[AgentAssignmentCoordinator] Safety net: released stuck ON_CALL agent ${targetAgentId} to OFFLINE`);
                    availability = AgentAvailability.OFFLINE;
                }
            }

            EventBus.emit('call:agent_availability', {
                tenantId,
                userId: targetAgentId,
                availability,
                updatedAt: new Date().toISOString(),
            });

            if (availability === AgentAvailability.AVAILABLE) {
                const assigned = await this.drainForTenant(tenantId);
                if (!assigned) await this.emitQueueUpdate(tenantId);
            }
        } catch (error) {
            console.error(`[AgentAssignmentCoordinator] Availability sync failed for tenant ${tenantId}, agent ${targetAgentId}:`, error);
        }
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
            console.log(`[AgentAssignment] Transferred call ${callId} assigned to agent ${agent.id}`);
            return true;
        }

        await this.emitQueueUpdate(tenantId, callRecord.queue_id);
        EventBus.emit('call:waiting', { callId, tenantId, queueId: callRecord.queue_id });
        console.log(`[AgentAssignment] Transferred call ${callId} waiting in queue (no available agent)`);
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
        await this.releaseAgentIfIdle(agentId);

        if (kind === 'missed') {
            callLifecycleLogger.logOfferMissed(call.id, call.tenant_id, agentId, { queue_id: call.queue_id })
                .catch((err) => console.error(`[AgentAssignment] Missed-offer log failed for call ${call.id}:`, err));
            await autoOfflinePolicy.recordMiss({ callId: call.id, tenantId: call.tenant_id, queueId: call.queue_id, agentId });
        } else {
            callLifecycleLogger.logRejected(call.id, call.tenant_id, agentId, { reason: 'agent_declined_offer', queue_id: call.queue_id })
                .catch((err) => console.error(`[AgentAssignment] Decline log failed for call ${call.id}:`, err));
        }
        console.log(`[AgentAssignment] Offer of call ${call.id} to agent ${agentId} ${kind} — passing it on`);

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
        if (call.agent_id) await this.releaseAgentIfIdle(call.agent_id);
        await offerHistory.clearMissed(call.id);

        callLifecycleLogger.logOverflowed(call.id, call.tenant_id, {
            from_queue_id: call.queue_id, to_queue_id: toQueue.id, waited_seconds: call.max_wait_seconds ?? null,
        }).catch((err) => console.error(`[AgentAssignment] Overflow log failed for call ${call.id}:`, err));
        EventBus.emit('call:overflowed', {
            callId: call.id, tenantId: call.tenant_id, fromQueueId: call.queue_id, toQueueId: toQueue.id,
        });
        console.log(`[AgentAssignment] Call ${call.id} overflowed from queue ${call.queue_id} to ${toQueue.id}`);

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
        const offered = (await offerHistory.eligible(callId, await queueRouter.ringAllTargets(queue, call.tenant_id)));
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

    // The AGENT-leg SDP offer for a call: reuse one already created on this
    // worker (IvrTransferHandler pre-creates it next to the CUSTOMER peer) —
    // creating a second would add another placeholder sender.
    async #agentOffer(callId) {
        const existing = await CallConnectionRepository.findByCallAndType(callId, ConnectionType.AGENT);
        return existing?.local_sdp
            ?? await sdpCoordinator.createSDPOffer(callId, ConnectionType.AGENT, this._callEventCallback);
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

        // The claim already flipped the agent ON_CALL — tell their own socket.
        EventBus.emit('call:agent_availability', {
            tenantId: call.tenant_id,
            userId: agent.id,
            availability: AgentAvailability.ON_CALL,
            updatedAt: new Date().toISOString(),
        });
    }
}

export const agentAssignmentCoordinator = new AgentAssignmentCoordinator();
