// src/realtime/namespaces/call/handlers/ivr.js
// Relays IVR progress to supervisors. Ending a call after IVR is core logic
// (core/ivr/IvrTerminationHandler.js), not a transport concern.
import EventBus from '../../../../core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';
import { ivrTerminationReason } from '../../../../core/ivr/IvrTerminationHandler.js';

export function registerCallIvrListeners() {
    EventBus.on('call:ivr_node', ({ callId, tenantId, nodeType, nodeId }) => {
        if (tenantId) roomManager.broadcastToSupervisors(tenantId, 'call:ivr_state', { callId, nodeType, nodeId });
    });

    EventBus.on('call:ivr_transferred', ({ callId, tenantId }) => {
        console.log(`[EventBus] IVR transferred — call=${callId}`);
        if (tenantId) roomManager.broadcastToSupervisors(tenantId, 'call:ivr_transferred', { callId });
    });

    EventBus.on('call:ivr_terminated', ({ callId, action, tenantId }) => {
        if (!tenantId) return;
        const terminationReason = ivrTerminationReason(action);
        roomManager.broadcastToSupervisors(tenantId, 'call:ivr_terminated', {
            callId, action, reason: terminationReason, terminationReason,
        });
    });

    EventBus.on('call:ivr_session_closed', (data) => {
        const { callId, tenantId, outcome, durationSeconds } = data;
        console.log(`[EventBus] IVR session closed — call=${callId}, outcome=${outcome}, duration=${durationSeconds ?? 'n/a'}s`);
        if (tenantId) roomManager.broadcastToSupervisors(tenantId, 'call:ivr_session_closed', data);
    });
}
