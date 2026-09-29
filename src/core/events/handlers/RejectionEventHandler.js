// src/core/events/handlers/RejectionEventHandler.js
// An agent declines a call offered to them (call:reject):
//   - RING_ALL offer nobody has taken: withdrawn for this agent only
//   - offer from a ROUND_ROBIN / PRIORITY queue: passed to the next member
//     (AgentAssignmentCoordinator.passOffer) — the customer keeps waiting
//   - anything else (no queue to pass it to): the call is declined and ends
import CallRepository from '../../../persistence/CallRepository.js';
import AgentRepository from '../../../persistence/AgentRepository.js';
import EventBus from '../../EventBus.js';
import { agentAssignmentCoordinator } from '../../routing/AgentAssignmentCoordinator.js';
import { callLifecycleLogger } from '../../calls/CallLifecycleLogger.js';
import { callTerminator } from '../../calls/CallTerminator.js';
import { CallDirection, CallStatus, TerminationReason, TerminatedBy } from '../../constants/CallConstants.js';
import { emitCallError } from '../CallErrorEmitter.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { callPushNotifier } from '../../../push/CallPushNotifier.js';
import { queueRouter } from '../../routing/QueueRouter.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.RejectionEventHandler');

export class RejectionEventHandler {

    async handleCallRejected(data) {
        const { callId, userId, tenantId, deviceId, socketId } = data;
        log.info({ agentId: userId, callId }, 'Agent declining call');

        try {
            const call = await CallRepository.findById(callId);
            if (!call) return;

            // A decline is only valid before the call is answered. A stale or
            // duplicated call:reject after the call went IN_PROGRESS must not
            // tear it down.
            if (call.status !== CallStatus.RINGING && call.status !== CallStatus.INITIATED) {
                log.warn({ callId }, `Ignoring call:reject — ${call.status}`);
                return;
            }

            const queue = call.queue_id ? await queueRouter.getQueue(call.queue_id) : null;
            const inboundRinging = call.direction === CallDirection.INBOUND && call.status === CallStatus.RINGING;

            // RING_ALL call nobody has taken yet: a decline only dismisses it for
            // this agent — the others are still being offered it.
            if (inboundRinging && call.agent_id == null && queueRouter.isRingAll(queue)) {
                await callLifecycleLogger.logRejected(callId, tenantId, userId, { reason: 'agent_declined_offer' });
                EventBus.emit('call:room:leave', { userId, callId });
                EventBus.emit('call:offer_declined', { callId, tenantId, userId, deviceId: deviceId ?? null });
                callPushNotifier.notifyCallResolved(callId, { resolvedAgentId: userId, tenantId })
                    .catch((err) => log.error({ callId, err }, 'dismiss push failed'));
                log.debug({ agentId: userId, callId }, 'Agent declined RING_ALL offer');
                return;
            }

            // Offer from a queue that offers one agent at a time: the next member gets it.
            if (inboundRinging && queue && !queueRouter.isRingAll(queue)) {
                if (String(call.agent_id) !== String(userId)
                    || !await agentAssignmentCoordinator.passOffer(call, userId, 'declined')) {
                    // Already answered, rung out or moved on — nothing of theirs to decline.
                    EventBus.emit('call:offer_withdrawn', { callId, tenantId, agentIds: [userId], reason: 'declined' });
                    return;
                }
                const agentName = await AgentRepository.getNameById(userId);
                EventBus.emit('call:handled', { callId, userId, tenantId, agentName, deviceId: deviceId ?? null, action: 'rejected' });
                return;
            }

            // No queue to pass it on to: the call itself is declined.
            const assigned = await CallRepository.assignCallToAgentIfEligible(callId, userId);
            if (!assigned) throw new Error('Call assignment conflict. Call ownership changed.');
            await callLifecycleLogger.logRejected(callId, tenantId, userId, { reason: 'agent_rejected' });

            await callTerminator.end({ ...call, agent_id: userId }, {
                reason: TerminationReason.REJECTED,
                terminatedBy: TerminatedBy.AGENT,
                // An IVR-transferred call was already answered by the IVR.
                provider: call.ivr_flow_id ? 'terminate' : 'reject',
                media: 'local',
                source: 'agent_rejected',
            });

            const agentName = await AgentRepository.getNameById(userId);
            EventBus.emit('call:handled', { callId, userId, tenantId, agentName, deviceId: deviceId ?? null, action: 'rejected' });
            // call:handled doesn't reach a killed/backgrounded device; a push does.
            callPushNotifier.notifyCallResolved(callId, { resolvedAgentId: userId, tenantId })
                .catch((err) => log.error({ callId, err }, 'notifyCallResolved failed'));

            log.info({ callId, agentId: userId }, 'Call declined by agent');
        } catch (error) {
            log.error({ callId, err: error }, 'Failed to decline call');

            // Lost the claim: someone else has the call or it already ended —
            // expected, so tell the agent in words they can act on.
            if (error.message.includes('Call assignment conflict')) {
                emitCallError({
                    callId,
                    code: CallErrorCodes.REJECT_FAILED,
                    message: 'This call was already handled by another agent.',
                    socketId,
                });
                return;
            }
            throw error;
        }
    }
}
