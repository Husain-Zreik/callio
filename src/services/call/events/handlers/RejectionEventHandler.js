// services/call/events/handlers/RejectionEventHandler.js
import { rejectWhatsAppCall, terminateWhatsAppCall } from '../../signaling/webrtc/WhatsAppCallApi.js';
import CallRepository from '../../../../repositories/CallRepository.js';
import AgentRepository from '../../../../repositories/AgentRepository.js';
import BusinessRepository from '../../../../repositories/BusinessRepository.js';
import EventBus from '../../../core/EventBus.js';
import { agentAssignmentCoordinator } from '../../assignment/AgentAssignmentCoordinator.js';
import { callLifecycleLogger } from '../../lifecycle/CallLifecycleLogger.js';
import { peerRegistry } from '../../signaling/webrtc/PeerRegistry.js';
import { CallDirection, CallStatus, TerminationReason, TerminatedBy } from '../../constants/CallConstants.js';
import { emitCallError } from '../CallErrorEmitter.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { notifyCallResolved } from '../../../../websocket/namespaces/call/handlers/delivery.js';

export class RejectionEventHandler {

    async handleCallRejected(data) {
        const { callId, userId, businessId, reason, direction, deviceId } = data;
        const isClientRejected = reason === 'CLIENT_REJECTED';

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
            if (!isClientRejected) {
                await callLifecycleLogger.logRejected(callId, businessId, userId, { reason: 'agent_rejected' });

                const callRecord = await CallRepository.findById(callId);
                if (callRecord?.ivr_menu_id) {
                    // IVR-transferred call: WhatsApp session is already accepted (IN_PROGRESS at Meta).
                    // Use terminate (end call) instead of reject to properly close the active session.
                    await terminateWhatsAppCall(callId);
                } else {
                    await rejectWhatsAppCall(callId);
                }

                const assigned = await CallRepository.assignCallToAgentIfEligible(callId, userId);
                if (!assigned) throw new Error('Call assignment conflict. Call ownership changed.');

                await CallRepository.terminateCall(callId, TerminationReason.REJECTED, TerminatedBy.BUSINESS);
                if (callRecord?.direction === CallDirection.OUTBOUND) {
                    await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(userId);
                } else {
                    await agentAssignmentCoordinator.releaseAgentIfIdle(userId);
                    await agentAssignmentCoordinator.assignOldestUnassignedCall(businessId);
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
                    await agentAssignmentCoordinator.assignOldestUnassignedCall(businessId);
                }
            }

            if (businessId) {
                // Only broadcast "agent rejected" to the dashboard when the agent
                // actually pressed the reject button — emitting call:handled for
                // CLIENT_REJECTED would falsely show the agent as the one who
                // rejected the call.
                if (!isClientRejected) {
                    const agentName = userId ? await AgentRepository.getUserNameById(userId, businessId) : null;
                    EventBus.emit('call:handled', { callId, userId, businessId, agentName, deviceId: deviceId ?? null, action: 'rejected' });

                    // Same reasoning as AgentEventHandler's accept path — see
                    // notifyCallResolved's doc comment for why call:handled
                    // above doesn't already reach a killed/backgrounded device.
                    const isCallCenter = await BusinessRepository.isCallCentered(businessId);
                    notifyCallResolved(callId, businessId, userId, { fanOutToBusiness: !isCallCenter }).catch((err) =>
                        console.error(`[RejectionEventHandler] notifyCallResolved failed for call ${callId}:`, err.message)
                    );
                } else {
                    // WhatsApp client declined while still ringing — nothing else in
                    // the codebase emits call:terminated for this path (confirmed by
                    // grepping every emission site), so without this the manager
                    // dashboard's Active Calls row for this call never gets removed.
                    EventBus.emit('call:terminated', {
                        callId, businessId, reason: TerminationReason.REJECTED, terminatedBy: TerminatedBy.CLIENT,
                    });
                }
                await agentAssignmentCoordinator.emitQueueUpdate(businessId);
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
