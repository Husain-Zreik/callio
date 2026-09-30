// src/core/events/handlers/TerminationEventHandler.js
// CALL_TERMINATED on the worker holding the call's media: an agent or the API
// hung up, media failed (ICE reconnect exhausted, customer silence), or — for
// a call another path already ended — just close this worker's peers.
import CallRepository from '../../../persistence/CallRepository.js';
import { callTerminator } from '../../calls/CallTerminator.js';
import { peerRegistry } from '../../../media/webrtc/PeerRegistry.js';
import { TerminationReason, TerminatedBy, InternalErrorCodes, CallStatus } from '../../constants/CallConstants.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.TerminationEventHandler');

export class TerminationEventHandler {

    async handleCallTerminated(data, _attempt = 0) {
        const { callId, userId, reason, requestedBy } = data;
        const isSystemFailed = reason === 'system_failed';
        const isCustomerNetworkLoss = reason === 'customer_network_loss';

        try {
            const call = await CallRepository.findById(callId);
            if (!call) { log.warn({ callId }, 'Call not found'); return; }

            if (call.status === CallStatus.TERMINATED || call.status === CallStatus.FAILED) {
                await peerRegistry.closePeerConnection(callId);
                return;
            }

            const label = isSystemFailed ? 'ICE reconnect exhausted'
                : isCustomerNetworkLoss ? 'Customer network loss'
                    : 'Hang-up';
            log.info({ callId, ...(userId ? { agentId: userId } : {}) }, label);

            if (isSystemFailed || isCustomerNetworkLoss) {
                // System-detected failure — FAILED, not TERMINATED, so history
                // shows an infrastructure/network failure.
                //   system_failed         → ICE reconnect exhausted (NETWORK_ERROR / 90001)
                //   customer_network_loss → silence watchdog fired (CUSTOMER_NETWORK_LOSS / 90002)
                await callTerminator.end(call, {
                    reason: isCustomerNetworkLoss ? TerminationReason.CUSTOMER_NETWORK_LOSS : TerminationReason.NETWORK_ERROR,
                    terminatedBy: TerminatedBy.SYSTEM,
                    failure: {
                        errors: [isCustomerNetworkLoss ? InternalErrorCodes.CUSTOMER_NETWORK_LOSS : InternalErrorCodes.NETWORK_ERROR],
                    },
                    provider: 'terminate',
                    media: 'local',
                    source: isSystemFailed ? 'ice_reconnect_exhausted' : 'silence_watchdog',
                });
                return;
            }

            // The reason follows the call's state: a call hung up before anyone
            // answered is NO_ANSWER, not COMPLETED (a stale COMPLETED would
            // survive the provider's later end event via COALESCE).
            await callTerminator.end(call, {
                reason: reason === 'cancelled'
                    ? TerminationReason.CANCELLED
                    : (!call.answered_at && (call.status === CallStatus.RINGING || call.status === CallStatus.INITIATED))
                        ? TerminationReason.NO_ANSWER
                        : TerminationReason.COMPLETED,
                // requestedBy is set by the Management API route; a socket's
                // hang-up is an agent's or a supervisor's.
                terminatedBy: requestedBy === TerminatedBy.CONSUMER ? TerminatedBy.CONSUMER : TerminatedBy.AGENT,
                provider: 'end',
                media: 'local',
                source: requestedBy === TerminatedBy.CONSUMER ? 'api' : 'agent',
            });
        } catch (error) {
            const isDeadlock = error.code === 'ER_LOCK_DEADLOCK' || error.errno === 1213;
            if (isDeadlock && _attempt < 2) {
                log.warn({ callId }, `Deadlock, retrying (attempt ${_attempt + 1})...`);
                await new Promise(r => setTimeout(r, 50 * (_attempt + 1)));
                return this.handleCallTerminated(data, _attempt + 1);
            }
            log.error({ callId, err: error }, 'Failed to handle termination');
        }
    }
}
