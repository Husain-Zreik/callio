// services/call/events/handlers/TerminationEventHandler.js
import { terminateWhatsAppCall } from '../../signaling/webrtc/WhatsAppCallApi.js';
import CallRepository from '../../../../repositories/CallRepository.js';
import { agentAssignmentCoordinator } from '../../assignment/AgentAssignmentCoordinator.js';
import { callLifecycleLogger } from '../../lifecycle/CallLifecycleLogger.js';
import { peerRegistry } from '../../signaling/webrtc/PeerRegistry.js';
import { TerminationReason, TerminatedBy, CallDirection, InternalErrorCodes } from '../../constants/CallConstants.js';
import EventBus from '../../../core/EventBus.js';

export class TerminationEventHandler {

    async handleCallTerminated(data, _attempt = 0) {
        const { callId, userId, reason } = data;
        const isSystemFailed = reason === 'system_failed';
        const isCustomerNetworkLoss = reason === 'customer_network_loss';

        const label = isSystemFailed ? 'ICE reconnect exhausted'
            : isCustomerNetworkLoss ? 'Customer network loss'
                : 'Business hangup';
        console.log(`[TerminationEventHandler] ${label} for call ${callId}${userId ? ` from user ${userId}` : ''}`);

        try {
            const call = await CallRepository.findById(callId);
            if (!call) { console.warn(`[TerminationEventHandler] Call ${callId} not found`); return; }

            if (call.status === 'TERMINATED' || call.status === 'FAILED') {
                console.log(`[TerminationEventHandler] Call ${callId} already ${call.status} — closing peer connections`);
                await peerRegistry.closePeerConnection(callId);
                return;
            }

            let terminationReason;
            let terminatedBy;
            let committed;

            if (isSystemFailed || isCustomerNetworkLoss) {
                // System-detected failure path — mark FAILED, not TERMINATED, so the UI
                // and history clearly show an infrastructure/network failure.
                //   system_failed         → ICE reconnect exhausted (NETWORK_ERROR / 90001)
                //   customer_network_loss → silence watchdog fired (CUSTOMER_NETWORK_LOSS / 90002)
                terminationReason = isCustomerNetworkLoss
                    ? TerminationReason.CUSTOMER_NETWORK_LOSS
                    : TerminationReason.NETWORK_ERROR;
                terminatedBy = TerminatedBy.SYSTEM;
                const errors = isCustomerNetworkLoss
                    ? [InternalErrorCodes.CUSTOMER_NETWORK_LOSS]
                    : [InternalErrorCodes.NETWORK_ERROR];
                committed = await CallRepository.markCallFailedIfNotFinal(
                    callId, errors, null, terminationReason, terminatedBy
                );
            } else {
                // Normal business-initiated termination.
                // Derive the correct reason from actual call state rather than
                // defaulting to COMPLETED for everything.  Without this, a RINGING
                // call terminated by the business side would be recorded as COMPLETED
                // even though no media session was ever established, and that stale
                // COMPLETED would then survive the later Meta webhook via COALESCE.
                terminatedBy = TerminatedBy.BUSINESS;
                terminationReason = reason === 'cancelled'
                    ? TerminationReason.CANCELLED
                    : (!call.answered_at && (call.status === 'RINGING' || call.status === 'INITIATED'))
                        ? TerminationReason.NO_ANSWER
                        : TerminationReason.COMPLETED;
                committed = await CallRepository.terminateCallIfNotTerminated(
                    callId, terminationReason, terminatedBy
                );
            }

            if (!committed) {
                console.log(`[TerminationEventHandler] Call ${callId} already finalized — closing local peer connections`);
                await peerRegistry.closePeerConnection(callId);
                return;
            }

            // Tell Meta to terminate (for normal path: triggers authoritative webhook
            // that patches durations; for system_failed: stops media billing).
            try { await terminateWhatsAppCall(callId); } catch (err) {
                console.warn(`[TerminationEventHandler] terminateCall API error for ${callId}: ${err.message}`);
            }

            await peerRegistry.closePeerConnection(callId);

            EventBus.emit('call:terminated', {
                callId,
                businessId: call.business_id,
                reason: terminationReason,
                terminatedBy,
                source: isSystemFailed ? 'ice_reconnect_exhausted'
                    : isCustomerNetworkLoss ? 'silence_watchdog'
                        : 'business_socket',
            });

            await callLifecycleLogger.logTerminated(callId, call.business_id, call?.user_id ?? null, {
                reason: terminationReason,
                terminated_by: terminatedBy,
                direction: call?.direction,
            });

            if (call?.user_id) {
                try {
                    if (call.direction === CallDirection.OUTBOUND) {
                        await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(call.user_id);
                    } else {
                        await agentAssignmentCoordinator.releaseAgentIfIdle(call.user_id);
                        await agentAssignmentCoordinator.assignOldestUnassignedCall(call.business_id);
                    }
                } catch (releaseErr) {
                    console.error(
                        `[TerminationEventHandler] ⚠️ AGENT STUCK: Failed to release agent ${call.user_id} after call ${callId}:`,
                        releaseErr.message
                    );
                }
            }

            try {
                await agentAssignmentCoordinator.emitQueueUpdate(call?.business_id);
            } catch (queueErr) {
                console.error(`[TerminationEventHandler] Failed to emit queue update:`, queueErr.message);
            }

            const outcome = isSystemFailed ? 'marked FAILED (NETWORK_ERROR/SYSTEM)'
                : isCustomerNetworkLoss ? 'marked FAILED (CUSTOMER_NETWORK_LOSS/SYSTEM)'
                    : 'terminated locally — webhook will patch durations';
            console.log(`[TerminationEventHandler] Call ${callId} ${outcome}`);
        } catch (error) {
            const isDeadlock = error.code === 'ER_LOCK_DEADLOCK' || error.errno === 1213;
            if (isDeadlock && _attempt < 2) {
                console.warn(`[TerminationEventHandler] Deadlock on call ${callId}, retrying (attempt ${_attempt + 1})...`);
                await new Promise(r => setTimeout(r, 50 * (_attempt + 1)));
                return this.handleCallTerminated(data, _attempt + 1);
            }
            console.error(`[TerminationEventHandler] Failed to handle termination for call ${callId}:`, error.message);
        }
    }
}
