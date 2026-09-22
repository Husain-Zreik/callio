// src/websocket/namespaces/call/handlers/ivr.js
import EventBus from '../../../../services/core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';
import { peerRegistry } from '../../../../services/call/signaling/webrtc/PeerRegistry.js';
import { terminateWhatsAppCall } from '../../../../services/call/signaling/webrtc/WhatsAppCallApi.js';
import CallRepository from '../../../../repositories/CallRepository.js';
import { agentAssignmentCoordinator } from '../../../../services/call/assignment/AgentAssignmentCoordinator.js';
import { TerminationReason, CallDirection } from '../../../../services/call/constants/CallConstants.js';

function mapIvrActionToTerminationReason(action) {
    const normalized = String(action || '').toLowerCase();
    if (normalized === 'timeout') return TerminationReason.TIMEOUT;
    if (normalized === 'error') return TerminationReason.SYSTEM_ERROR;
    if (normalized === 'hung_up' || normalized === 'hangup' || normalized === 'hungup') {
        return TerminationReason.COMPLETED;
    }
    return TerminationReason.COMPLETED;
}

export function registerCallIvrListeners() {
    // IVR node transition — show live IVR progress in the manager dashboard only.
    EventBus.on('call:ivr_node', ({ callId, businessId, nodeType, nodeId }) => {
        console.log(`[EventBus] IVR node — call=${callId}, type=${nodeType}, node=${nodeId}`);
        if (businessId) {
            roomManager.broadcastToManagers(businessId, 'call:ivr_state', { callId, nodeType, nodeId });
        }
    });

    // IVR complete — broadcast so the manager dashboard can update call status.
    EventBus.on('call:ivr_transferred', ({ callId, businessId }) => {
        console.log(`[EventBus] IVR transferred — call=${callId}`);
        if (businessId) roomManager.broadcastToBusiness(businessId, 'call:ivr_transferred', { callId });
    });

    EventBus.on('call:ivr_terminated', async ({ callId, action, businessId }) => {
        const terminationReason = mapIvrActionToTerminationReason(action);
        console.log(`[EventBus] IVR terminated - call=${callId}, action=${action}, terminationReason=${terminationReason}`);

        // Notify managers only — the call room is empty at this stage (no agent joined yet)
        // and agents will learn about the outcome via call:terminated that follows.
        if (businessId) {
            roomManager.broadcastToManagers(businessId, 'call:ivr_terminated', {
                callId,
                action,
                reason: terminationReason,
                terminationReason,
            });
        }

        // Actually end the call: terminate on WhatsApp side, close peer connections, update DB.
        try {
            await terminateWhatsAppCall(callId).catch(() => { });
            const terminatedByThisPath = await CallRepository.terminateCallIfNotTerminated(callId, terminationReason, 'SYSTEM');
            await peerRegistry.closePeerConnection(callId);

            if (terminatedByThisPath) {
                const call = await CallRepository.findById(callId).catch(() => null);
                const resolvedBusinessId = businessId ?? call?.business_id ?? null;

                // Release the agent if one was assigned (IVR→agent transfer path).
                // Without this the agent stays stuck ON_CALL after IVR termination
                // since nothing else in this code path touches agent availability.
                if (call?.user_id) {
                    try {
                        if (call.direction === CallDirection.OUTBOUND) {
                            await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(call.user_id);
                        } else {
                            await agentAssignmentCoordinator.releaseAgentIfIdle(call.user_id);
                            await agentAssignmentCoordinator.assignOldestUnassignedCall(resolvedBusinessId);
                        }
                    } catch (releaseErr) {
                        console.error(
                            `[IVR] AGENT STUCK: Failed to release agent ${call.user_id} after IVR termination of call ${callId}:`,
                            releaseErr.message
                        );
                    }
                    if (resolvedBusinessId) {
                        agentAssignmentCoordinator.emitQueueUpdate(resolvedBusinessId).catch(() => { });
                    }
                }

                EventBus.emit('call:terminated', {
                    callId,
                    businessId: resolvedBusinessId,
                    reason: terminationReason,
                    terminationReason,
                    source: 'ivr',
                });
            }
        } catch (err) {
            console.error(`[IVR] Failed to clean up call ${callId} after IVR termination:`, err.message);
        }
    });

    // IVR session closure payload with exact runtime timing.
    EventBus.on('call:ivr_session_closed', (data) => {
        const { callId, businessId, outcome, durationSeconds, endedAt } = data;
        console.log(
            `[EventBus] IVR session closed — call=${callId}, outcome=${outcome}, duration=${durationSeconds ?? 'n/a'}s, endedAt=${endedAt}`
        );

        // Business-room only — the call room at IVR time contains only supervisors
        // who are monitoring, and they are already in the business room. Broadcasting
        // to both rooms would deliver the event twice to monitoring supervisors.
        if (businessId) roomManager.broadcastToBusiness(businessId, 'call:ivr_session_closed', data);
    });
}
