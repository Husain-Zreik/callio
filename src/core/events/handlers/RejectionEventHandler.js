// src/core/events/handlers/RejectionEventHandler.js
import CallRepository from '../../../persistence/CallRepository.js';
import AgentRepository from '../../../persistence/AgentRepository.js';
import EventBus from '../../EventBus.js';
import { agentAssignmentCoordinator } from '../../routing/AgentAssignmentCoordinator.js';
import { callLifecycleLogger } from '../../calls/CallLifecycleLogger.js';
import { peerRegistry } from '../../../media/webrtc/PeerRegistry.js';
import { CallDirection, CallStatus, TerminationReason, TerminatedBy } from '../../constants/CallConstants.js';
import { emitCallError } from '../CallErrorEmitter.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { callPushNotifier } from '../../../push/CallPushNotifier.js';
import { queueRouter } from '../../routing/QueueRouter.js';
import { customerChannels } from '../../channels/CustomerChannels.js';

export class RejectionEventHandler {

    async handleCallRejected(data) {
        const { callId, userId, tenantId, reason, direction, deviceId } = data;
        const isClientRejected = reason === 'CUSTOMER_REJECTED';

        console.log(`[RejectionEventHandler] ${isClientRejected ? 'Client' : 'Agent'} rejecting call ${callId}`);

        // Reject is only ever valid while the call hasn't been answered yet
        // (INITIATED/RINGING). A stale, duplicated, or delayed call:reject
        // arriving after the call already transitioned to IN_PROGRESS must
        // not be allowed to tear it down — for the isClientRejected branch
        // this closed peer connections on an active call with zero guard at
        // all, and for the agent branch assignCallToAgentIfEligible's SQL
        // deliberately still permits IN_PROGRESS (needed by its other
        // caller, AgentEventHandler's transfer-accept path), so it wouldn't
        // have caught this either. Mirrors AgentEventHandler.handleAgentJoined's
        // own fresh-status pre-gate rather than trusting the event's own
        // claimed state. Doesn't matter *why* the client sent a stale
        // reject — this closes the hole regardless of cause.
        const currentStatus = await CallRepository.getStatus(callId);
        if (currentStatus === CallStatus.IN_PROGRESS) {
            console.warn(`[RejectionEventHandler] Ignoring call:reject for call ${callId} — already IN_PROGRESS`);
            return;
        }

        try {
            const callRecord = await CallRepository.findById(callId);
            const queue = callRecord?.queue_id ? await queueRouter.getQueue(callRecord.queue_id) : null;

            // RING_ALL call nobody has taken yet: a decline only dismisses it for
            // this agent — the others are still being offered it.
            if (!isClientRejected && callRecord && callRecord.agent_id == null
                && callRecord.direction === CallDirection.INBOUND && queueRouter.isRingAll(queue)) {
                await callLifecycleLogger.logRejected(callId, tenantId, userId, { reason: 'agent_declined_offer' });
                EventBus.emit('call:room:leave', { userId, callId });
                EventBus.emit('call:offer_declined', { callId, tenantId, userId, deviceId: deviceId ?? null });
                callPushNotifier.notifyCallResolved(callId, { resolvedAgentId: userId, tenantId })
                    .catch((err) => console.error(`[RejectionEventHandler] dismiss push failed for call ${callId}:`, err));
                console.log(`[RejectionEventHandler] Agent ${userId} declined RING_ALL offer for call ${callId}`);
                return;
            }

            if (!isClientRejected) {
                await callLifecycleLogger.logRejected(callId, tenantId, userId, { reason: 'agent_rejected' });

                if (callRecord?.ivr_flow_id) {
                    // IVR-transferred call: the IVR already answered the customer.
                    // Use terminate (end call) instead of reject to properly close the active session.
                    await customerChannels.terminate(callRecord);
                } else {
                    await customerChannels.reject(callRecord ?? callId);
                }

                const assigned = await CallRepository.assignCallToAgentIfEligible(callId, userId);
                if (!assigned) throw new Error('Call assignment conflict. Call ownership changed.');

                await CallRepository.terminateCall(callId, TerminationReason.REJECTED, TerminatedBy.AGENT);
                if (callRecord?.direction === CallDirection.OUTBOUND) {
                    await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(userId);
                } else {
                    await agentAssignmentCoordinator.releaseAgentIfIdle(userId);
                    await agentAssignmentCoordinator.assignOldestUnassignedCall(tenantId);
                }
            }

            await peerRegistry.closePeerConnection(callId);

            if (userId && isClientRejected) {
                // Mirrors the agent-rejected branch's direction split above (and
                // _handleCallTerminate's): OUTBOUND drops the agent OFFLINE
                // (avoids auto-queueing them into inbound routing after a failed
                // outbound attempt); INBOUND frees them back to AVAILABLE and
                // immediately feeds them the next queued call.
                if (direction === CallDirection.OUTBOUND) {
                    await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(userId);
                } else {
                    await agentAssignmentCoordinator.releaseAgentIfIdle(userId);
                    await agentAssignmentCoordinator.assignOldestUnassignedCall(tenantId);
                }
            }

            if (tenantId) {
                // Only broadcast "agent rejected" to the dashboard when the agent
                // actually pressed the reject button — emitting call:handled for
                // CLIENT_REJECTED would falsely show the agent as the one who
                // rejected the call.
                if (!isClientRejected) {
                    const agentName = userId ? await AgentRepository.getNameById(userId) : null;
                    EventBus.emit('call:handled', { callId, userId, tenantId, agentName, deviceId: deviceId ?? null, action: 'rejected' });

                    // Same reasoning as AgentEventHandler's accept path: call:handled
                    // doesn't reach a killed/backgrounded device, a push does.
                    callPushNotifier.notifyCallResolved(callId, {
                        resolvedAgentId: userId,
                        ringAllQueue: queueRouter.isRingAll(queue) ? queue : null,
                        tenantId,
                    }).catch((err) =>
                        console.error(`[RejectionEventHandler] notifyCallResolved failed for call ${callId}:`, err)
                    );
                } else {
                    // The customer declined while still ringing — nothing else in
                    // the codebase emits call:terminated for this path (confirmed by
                    // grepping every emission site), so without this the manager
                    // dashboard's Active Calls row for this call never gets removed.
                    EventBus.emit('call:terminated', {
                        callId, tenantId, reason: TerminationReason.REJECTED, terminatedBy: TerminatedBy.CUSTOMER,
                    });
                }
                await agentAssignmentCoordinator.emitQueueUpdate(tenantId, callRecord?.queue_id ?? null);
            }

            console.log(`[RejectionEventHandler] ✅ Call ${callId} rejected`);
        } catch (error) {
            console.error(`[RejectionEventHandler] Failed to reject call ${callId}:`, error.message);

            // Same reasoning as AgentEventHandler's accept path: lost the
            // ownership claim (someone else already has this call, or it
            // already ended) — an expected outcome, not a system failure, so
            // return a message the agent can act on instead of the raw
            // internal one via CallEventHandler's outer catch.
            if (error.message.includes('Call assignment conflict')) {
                emitCallError({
                    callId,
                    code: CallErrorCodes.REJECT_FAILED,
                    message: 'This call was already handled by another agent.',
                    socketId: data.socketId,
                });
                return;
            }

            throw error;
        }
    }
}
