// src/core/routing/AutoOfflinePolicy.js
// The tenant's auto-offline policy (tenants.auto_offline_*): an agent who
// misses N consecutive offers is taken offline, so calls stop going to
// someone who isn't there. A miss is an offer that rang out — the queue's
// ring timeout, or the customer giving up while it rang that agent.
import EventBus from '../EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import { agentMissedCallTracker } from './AgentMissedCallTracker.js';
import { queueRouter } from './QueueRouter.js';
import { AgentAvailability } from '../constants/CallConstants.js';

class AutoOfflinePolicy {
    /**
     * Counts a missed offer and flips the agent OFFLINE at the threshold.
     * Under RING_ALL nobody in particular missed the call, so queue calls are
     * only counted for queues that offer to one agent at a time; pass
     * anyQueue for offers made outside a queue's strategy (IVR → agent).
     * Returns true if the agent was taken offline.
     */
    async recordMiss({ callId, tenantId, queueId, agentId, anyQueue = false }) {
        if (!agentId) return false;
        try {
            if (!anyQueue) {
                const queue = queueId ? await queueRouter.getQueue(queueId) : null;
                if (!queue || queueRouter.isRingAll(queue)) return false;
            }

            const policy = await TenantRepository.getAutoOfflineSettings(tenantId);
            if (!policy.enabled) return false;

            // A miss while the agent is on another active call was a
            // double-dispatch race, not negligence — don't count it.
            if (await CallRepository.hasAgentActiveCall(agentId, callId)) {
                console.log(`[AutoOffline] Not counting a miss for agent ${agentId} — on an active call (missed=${callId})`);
                return false;
            }

            const streak = await agentMissedCallTracker.increment(agentId);
            console.log(`[AutoOffline] Agent ${agentId} missed-streak=${streak}/${policy.threshold} (tenant=${tenantId}, call=${callId})`);
            if (streak < policy.threshold) return false;

            const flipped = await AgentRepository.updateAgentAvailability(agentId, AgentAvailability.OFFLINE);
            await agentMissedCallTracker.reset(agentId);
            if (!flipped) return false;

            EventBus.emit('call:agent_availability', {
                tenantId,
                userId: agentId,
                availability: AgentAvailability.OFFLINE,
                reason: 'auto_offline_missed_calls',
                consecutiveMissed: streak,
                updatedAt: new Date().toISOString(),
            });
            console.log(`[AutoOffline] Flipped agent ${agentId} OFFLINE after ${streak} consecutive missed calls`);
            return true;
        } catch (err) {
            console.error(`[AutoOffline] policy check failed for agent ${agentId}:`, err);
            return false;
        }
    }
}

export const autoOfflinePolicy = new AutoOfflinePolicy();
