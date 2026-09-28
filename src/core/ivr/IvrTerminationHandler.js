// src/core/ivr/IvrTerminationHandler.js
// Ends a call whose IVR flow finished without transferring it (hang-up node,
// timeout, error, or the caller hanging up mid-flow): tells the provider,
// finalizes the row, closes media, releases any agent. Registered once per
// worker; the realtime layer only relays the IVR events to supervisors.
import EventBus from '../EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import { peerRegistry } from '../../media/webrtc/PeerRegistry.js';
import { customerChannels } from '../channels/CustomerChannels.js';
import { agentAssignmentCoordinator } from '../routing/AgentAssignmentCoordinator.js';
import { TerminationReason, CallDirection } from '../constants/CallConstants.js';

export function ivrTerminationReason(action) {
    switch (String(action || '').toLowerCase()) {
        case 'timeout': return TerminationReason.TIMEOUT;
        case 'error': return TerminationReason.SYSTEM_ERROR;
        default: return TerminationReason.COMPLETED;
    }
}

class IvrTerminationHandler {
    constructor() {
        this._registered = false;
    }

    register() {
        if (this._registered) return;
        this._registered = true;
        EventBus.on('call:ivr_terminated', (data) => this.#handle(data));
    }

    async #handle({ callId, action, tenantId }) {
        const terminationReason = ivrTerminationReason(action);
        console.log(`[IvrTermination] call=${callId}, action=${action}, terminationReason=${terminationReason}`);

        try {
            await customerChannels.terminate(callId).catch(() => { });
            const terminatedByThisPath = await CallRepository.terminateCallIfNotTerminated(callId, terminationReason, 'SYSTEM');
            await peerRegistry.closePeerConnection(callId);
            if (!terminatedByThisPath) return;

            const call = await CallRepository.findById(callId).catch(() => null);
            const resolvedTenantId = tenantId ?? call?.tenant_id ?? null;

            // An IVR → agent transfer may have claimed an agent; nothing else on
            // this path releases them.
            if (call?.agent_id) {
                try {
                    if (call.direction === CallDirection.OUTBOUND) {
                        await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(call.agent_id);
                    } else {
                        await agentAssignmentCoordinator.releaseAgentIfIdle(call.agent_id);
                        await agentAssignmentCoordinator.assignOldestUnassignedCall(resolvedTenantId);
                    }
                } catch (releaseErr) {
                    console.error(`[IvrTermination] AGENT STUCK: failed to release agent ${call.agent_id} for call ${callId}:`, releaseErr);
                }
                if (resolvedTenantId) agentAssignmentCoordinator.emitQueueUpdate(resolvedTenantId).catch(() => { });
            }

            EventBus.emit('call:terminated', {
                callId,
                tenantId: resolvedTenantId,
                reason: terminationReason,
                terminationReason,
                source: 'ivr',
            });
        } catch (err) {
            console.error(`[IvrTermination] Failed to clean up call ${callId}:`, err);
        }
    }
}

export const ivrTerminationHandler = new IvrTerminationHandler();
