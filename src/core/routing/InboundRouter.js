// src/core/routing/InboundRouter.js
// Where a new inbound call goes first, decided from its line (channel):
//   owner  a personal line (channels.owner_agent_id): ring that agent
//   ivr    a shared line whose IVR flow's trigger holds: the flow takes it
//   queue  a shared line's active inbound queue
//   none   nowhere to send it (no owner, no queue, no IVR): it is rejected
// ChannelIngress acts on the decision; QueueRouter stays the only reader of
// queues.strategy. Nothing here scans a tenant: a call looks up its line's
// owner by id, or its queue.
import AgentRepository from '../../persistence/AgentRepository.js';
import PushTokenRepository from '../../persistence/PushTokenRepository.js';
import { presenceService } from '../agents/PresenceService.js';
import { queueRouter } from './QueueRouter.js';

export const RouteKind = Object.freeze({ OWNER: 'owner', IVR: 'ivr', QUEUE: 'queue', NONE: 'none' });

export const DEFAULT_LINE_RING_TIMEOUT_SECONDS = 30;

class InboundRouter {
    /**
     * @returns {Promise<{ kind, owner?, queue?, ivrFlowId? }>}
     */
    async route(channel) {
        if (channel.owner_agent_id != null) {
            const owner = await AgentRepository.findById(channel.owner_agent_id);
            return owner ? { kind: RouteKind.OWNER, owner } : { kind: RouteKind.NONE };
        }
        const queue = await queueRouter.getQueue(channel.inbound_queue_id);
        // IVR is an overlay on the queue: a flow whose trigger holds takes the
        // call first; it reaches the queue when the flow transfers it.
        const ivrFlowId = await queueRouter.selectIvrFlow(channel, queue);
        if (ivrFlowId) return { kind: RouteKind.IVR, ivrFlowId, queue };
        if (queue) return { kind: RouteKind.QUEUE, queue };
        return { kind: RouteKind.NONE };
    }

    // Whether ringing the agent can reach anyone: a connected socket, or a
    // device to push to.
    async reachable(agentId) {
        if (await presenceService.getUserSocketCount(agentId) > 0) return true;
        return PushTokenRepository.hasAny(agentId);
    }

    ringTimeoutMs(channel) {
        return (channel.ring_timeout_seconds ?? DEFAULT_LINE_RING_TIMEOUT_SECONDS) * 1000;
    }
}

export const inboundRouter = new InboundRouter();
