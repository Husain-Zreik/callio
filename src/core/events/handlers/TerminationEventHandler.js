// src/core/events/handlers/TerminationEventHandler.js
import { customerChannels } from '../../channels/CustomerChannels.js';
import CallRepository from '../../../persistence/CallRepository.js';
import { agentAssignmentCoordinator } from '../../routing/AgentAssignmentCoordinator.js';
import { callLifecycleLogger } from '../../calls/CallLifecycleLogger.js';
import { peerRegistry } from '../../../media/webrtc/PeerRegistry.js';
import { TerminationReason, TerminatedBy, CallDirection, InternalErrorCodes } from '../../constants/CallConstants.js';
import EventBus from '../../EventBus.js';

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
                terminatedBy = TerminatedBy.AGENT;
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

            // Order after the DB commit: tell clients and free the agent first —
            // tearing down the WebRTC peers can take over a second, and the agent
            // must not sit ON_CALL (unofferable) meanwhile — then the provider,
            // then media.
            EventBus.emit('call:terminated', {
                callId,
                tenantId: call.tenant_id,
                reason: terminationReason,
                terminatedBy,
                source: isSystemFailed ? 'ice_reconnect_exhausted'
                    : isCustomerNetworkLoss ? 'silence_watchdog'
                        : 'agent_or_api',
            });

            if (call?.agent_id) {
                try {
                    if (call.direction === CallDirection.OUTBOUND) {
                        await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(call.agent_id);
                    } else {
                        await agentAssignmentCoordinator.releaseAgentIfIdle(call.agent_id);
                        await agentAssignmentCoordinator.assignOldestUnassignedCall(call.tenant_id);
                    }
                } catch (releaseErr) {
                    console.error(
                        `[TerminationEventHandler] ⚠️ AGENT STUCK: Failed to release agent ${call.agent_id} after call ${callId}:`,
                        releaseErr.message
                    );
                }
            }

            // Tell the provider (normal path: triggers the authoritative webhook
            // that patches durations; failures: stops media billing), then close media.
            try { await customerChannels.terminate(call); } catch (err) {
                console.warn(`[TerminationEventHandler] terminateCall API error for ${callId}: ${err.message}`);
            }
            await peerRegistry.closePeerConnection(callId);

            await callLifecycleLogger.logTerminated(callId, call.tenant_id, call?.agent_id ?? null, {
                reason: terminationReason,
                terminated_by: terminatedBy,
                direction: call?.direction,
            });

            try {
                await agentAssignmentCoordinator.emitQueueUpdate(call?.tenant_id, call?.queue_id ?? null);
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
