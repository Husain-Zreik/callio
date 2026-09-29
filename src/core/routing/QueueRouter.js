// src/core/routing/QueueRouter.js
// Routing decisions for a queue — the only place that interprets
// queues.strategy. Callers (webhook ingress, queue drain, IVR/agent transfer)
// ask it who to offer a call to; it never touches media or sockets.
import AgentRepository from '../../persistence/AgentRepository.js';
import CallRepository from '../../persistence/CallRepository.js';
import QueueRepository from '../../persistence/QueueRepository.js';
import IvrRepository from '../../persistence/IvrRepository.js';
import { callAgentAssignmentService } from './CallAgentAssignmentService.js';
import { AgentAvailability, QueueStrategy } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.routing.QueueRouter');

class QueueRouter {
    async getQueue(queueId) {
        const queue = await QueueRepository.findById(queueId);
        return queue?.status === 'ACTIVE' ? queue : null;
    }

    getMembers(queue) {
        return queue ? QueueRepository.getMembers(queue.id) : Promise.resolve([]);
    }

    isRingAll(queue) {
        return !queue || queue.strategy === QueueStrategy.RING_ALL;
    }

    // Picks and claims one member with claimFn, per the queue's strategy.
    async #pick(queue, members, claimFn) {
        return queue.strategy === QueueStrategy.PRIORITY
            ? callAgentAssignmentService.pickPriority(queue.id, members, claimFn)
            : callAgentAssignmentService.pickRoundRobin(queue.id, members, claimFn);
    }

    /**
     * Synchronous assignment for a brand-new inbound call, before its row
     * exists. Claims the agent (AVAILABLE → ON_CALL) but can't assign the call
     * yet — the caller writes agent_id at insert. Returns the agent or null.
     * Null when the queue rings everyone, or when older calls are already
     * waiting (FIFO: a new call must never jump ahead of them).
     */
    async claimForNewCall(queue) {
        if (this.isRingAll(queue)) return null;
        try {
            if (await CallRepository.hasUnassignedCalls(queue.id)) return null;
        } catch (err) {
            log.warn({ err }, `FIFO guard failed for queue ${queue.id} — skipping sync claim`);
            return null;
        }
        const members = await this.getMembers(queue);
        return this.#pick(queue, members, (agentId) => AgentRepository.claimAgentIfAvailable(agentId));
    }

    /**
     * Claims a member and assigns an existing waiting call atomically.
     * Returns { agent, takenByAnotherWorker }.
     */
    async claimForWaitingCall(queue, callId, members = null) {
        let takenByAnotherWorker = false;
        const pool = members ?? await this.getMembers(queue);
        const agent = await this.#pick(queue, pool, async (agentId) => {
            const { claimed, assigned } = await AgentRepository.claimAgentAndAssignCall(agentId, callId);
            if (claimed && !assigned) takenByAnotherWorker = true;
            return assigned;
        });
        return { agent, takenByAnotherWorker };
    }

    /**
     * Claims one member for a transfer into this queue (excluding the agent
     * transferring the call). A RING_ALL queue picks round-robin here: a
     * transfer hands the live call to exactly one agent.
     */
    async claimMemberForTransfer(queue, excludeAgentId = null) {
        const members = (await this.getMembers(queue))
            .filter((a) => excludeAgentId == null || String(a.id) !== String(excludeAgentId));
        const strategyQueue = queue.strategy === QueueStrategy.RING_ALL
            ? { ...queue, strategy: QueueStrategy.ROUND_ROBIN }
            : queue;
        return this.#pick(strategyQueue, members, (agentId) => AgentRepository.claimAgentIfAvailable(agentId));
    }

    // RING_ALL: every available member is offered the call at once.
    async ringAllTargets(queue, tenantId) {
        const members = queue
            ? await this.getMembers(queue)
            : (await AgentRepository.getTenantAgents(tenantId)).filter((a) => a.role === 'AGENT');
        return members.filter((a) => a.availability === AgentAvailability.AVAILABLE);
    }

    // Accepting a call from this queue would exceed queues.max_active_calls.
    async isAtCapacity(queue, excludeCallId) {
        if (!queue?.max_active_calls) return false;
        const active = await CallRepository.countOtherActiveCallsInQueue(queue.id, excludeCallId);
        return active >= queue.max_active_calls;
    }

    async availabilityStats(queue, tenantId) {
        if (!queue) return AgentRepository.getTenantAvailabilityStats(tenantId);
        const memberIds = await QueueRepository.getMemberIds(queue.id);
        return AgentRepository.getAvailabilityStatsForAgentIds(memberIds);
    }

    /**
     * The IVR flow that takes an inbound call on this channel, or null.
     * Channel-specific flows are evaluated before tenant-wide ones; within
     * each scope, the first flow whose trigger condition holds wins.
     * Conditions are evaluated against the channel's inbound queue.
     */
    async selectIvrFlow(channel, queue) {
        const flows = await IvrRepository.findCandidateFlows(channel.tenant_id, channel.id);
        if (!flows.length) return null;

        let stats = null;
        const getStats = async () => (stats ??= await this.availabilityStats(queue, channel.tenant_id));

        const holds = async (condition) => {
            switch ((condition ?? 'ALWAYS').toUpperCase()) {
                case 'ALWAYS': return true;
                case 'ALL_AGENTS_BUSY': { const s = await getStats(); return s.total > 0 && s.available === 0 && s.on_call > 0; }
                case 'ALL_AGENTS_OFFLINE': { const s = await getStats(); return s.total > 0 && s.available === 0 && s.on_call === 0; }
                case 'ALL_AGENTS_UNAVAILABLE': { const s = await getStats(); return s.available === 0; }
                default: return false;
            }
        };

        // Channel scope first; a tenant-wide flow still applies when no
        // channel-specific flow's condition held.
        for (const scope of [0, 1]) {
            for (const flow of flows) {
                if (flow.scope_order === scope && await holds(flow.trigger_condition)) return flow.id;
            }
        }
        return null;
    }
}

export const queueRouter = new QueueRouter();
