// src/core/calls/CallTerminator.js
// The one way a call ends. Every path — an agent or the API hanging up, the
// provider ending it, a failure, IVR, a queue timeout, cleanup — goes through
// here, so the side effects run once and in the same order:
//
//   1. commit the final state (guarded: only the first path to end a call
//      does anything else — the rest just close their local media)
//   2. tell clients and consumers (call:terminated)
//   3. free the agent (INBOUND: AVAILABLE and drain the queues; OUTBOUND: OFFLINE)
//      — before media teardown, which can take over a second
//   4. tell the provider (terminate / reject), when this path is the one ending it
//   5. close media, here and on the worker that holds it
//   6. lifecycle log and queue snapshot
//
// end()    commits with a plain terminate or failure, then settles.
// settle() is steps 2–6 alone, for a caller that already committed with its
//          own finalize (the provider's end, with the provider's timing).
import EventBus from '../EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import { agentAssignmentCoordinator } from '../routing/AgentAssignmentCoordinator.js';
import { customerChannels } from '../channels/CustomerChannels.js';
import { callLifecycleLogger } from './CallLifecycleLogger.js';
import { peerRegistry } from '../../media/webrtc/PeerRegistry.js';
import { redisPubSubService } from '../../infra/redis/RedisPubSubService.js';
import { EventTypes } from '../events/EventTypes.js';
import { CallDirection } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';
import { recordCallEnded } from '../../infra/monitoring/metrics.js';

const log = logger('core.calls.CallTerminator');

class CallTerminator {
    /**
     * @param {object|number} callOrId  a calls row (as it was before ending) or its id
     * @param {object} opts
     *   reason        TerminationReason
     *   terminatedBy  TerminatedBy
     *   failure       { errors } — end as FAILED instead of TERMINATED
     *   onlyIfStatus  end only if the call is still in this status (e.g. RINGING)
     *   provider      what to tell the provider: 'end' (reject an inbound call
     *                 nobody answered, otherwise terminate), 'terminate', 'reject'
     *                 or 'none'
     *   media         'broadcast' (default) | 'local' — see #closeMedia
     *   source        short label for logs and call:terminated (e.g. 'queue_max_wait')
     *   log           extra lifecycle-log fields
     *   agentAfter    where the agent goes: 'auto' (default: INBOUND → AVAILABLE and
     *                 drain the queues, OUTBOUND → OFFLINE) or 'offline' (they're gone)
     * @returns {Promise<boolean>} true if this call ended it
     */
    async end(callOrId, opts) {
        const call = await this.#load(callOrId);
        if (!call) return false;
        const { reason, terminatedBy, failure = null, onlyIfStatus = null } = opts;

        const committed = failure
            ? await CallRepository.markCallFailedIfNotFinal(call.id, failure.errors ?? null, null, reason, terminatedBy)
            : await CallRepository.terminateCallIfNotTerminated(call.id, reason, terminatedBy, null, onlyIfStatus);

        if (!committed) {
            // Someone else ended it (or it moved on); only local media is ours to close.
            await this.#closeMedia(call.id, 'local');
            return false;
        }
        await this.settle(call, opts);
        return true;
    }

    // Steps 2–6 for a call whose final state is already committed.
    async settle(callOrId, {
        reason, terminatedBy, provider = 'none', media = 'broadcast', source = null, log: lifecycleFields = {}, agentAfter = 'auto',
    }) {
        const call = await this.#load(callOrId);
        if (!call) return;
        const callId = call.id;

        EventBus.emit('call:terminated', {
            callId,
            tenantId: call.tenant_id,
            reason,
            terminationReason: reason,
            terminatedBy,
            source,
        });

        if (call.agent_id) {
            try {
                if (agentAfter === 'offline' || call.direction === CallDirection.OUTBOUND) {
                    await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(call.agent_id);
                } else {
                    await agentAssignmentCoordinator.releaseAgentIfIdle(call.agent_id);
                    await agentAssignmentCoordinator.assignOldestUnassignedCall(call.tenant_id);
                }
            } catch (err) {
                log.error({ agentId: call.agent_id, callId, err }, 'AGENT STUCK: failed to release agent after call');
            }
        }

        if (provider !== 'none' && call.provider_call_id) {
            const action = provider === 'end'
                ? (call.direction === CallDirection.INBOUND && !call.answered_at ? 'reject' : 'terminate')
                : provider;
            try {
                await (action === 'reject' ? customerChannels.reject(call) : customerChannels.terminate(call));
            } catch (err) {
                log.warn({ callId, err }, `Provider ${action} failed`);
            }
        }

        await this.#closeMedia(callId, media);

        callLifecycleLogger.logTerminated(callId, call.tenant_id, call.agent_id ?? null, {
            reason,
            terminated_by: terminatedBy,
            direction: call.direction,
            ...(source ? { source } : {}),
            ...lifecycleFields,
        }).catch((err) => log.error({ callId, err }, 'Lifecycle log failed'));

        agentAssignmentCoordinator.emitQueueUpdate(call.tenant_id, call.queue_id ?? null)
            .catch((err) => log.error({ callId, err }, 'Queue update failed'));

        recordCallEnded(call, { reason, terminatedBy });
        log.info({ callId }, `Call ended — ${reason}/${terminatedBy}${source ? ` (${source})` : ''}`);
    }

    // A call's media lives on one worker. 'local' closes this worker's peers —
    // for callers already running there (events routed to the owning worker).
    // 'broadcast' also tells the owning worker, whose CALL_TERMINATED handler
    // sees the call is over and closes its peers.
    async #closeMedia(callId, media) {
        await peerRegistry.closePeerConnection(callId).catch((err) =>
            log.error({ callId, err }, 'Closing local media failed')
        );
        if (media !== 'broadcast') return;
        await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TERMINATED, { callId, reason: 'ended' })
            .catch((err) => log.error({ callId, err }, 'Media close broadcast failed'));
    }

    async #load(callOrId) {
        if (callOrId && typeof callOrId === 'object') return callOrId;
        return CallRepository.findById(callOrId);
    }
}

export const callTerminator = new CallTerminator();
