// src/realtime/namespaces/call/handlers/ivr.js
// Relays IVR progress to the supervisors' board. Ending a call after IVR is core logic
// (core/ivr/IvrTerminationHandler.js), not a transport concern.
import EventBus from '../../../../core/EventBus.js';
import { board, Tier } from '../../../managers/Board.js';
import { ivrTerminationReason } from '../../../../core/ivr/IvrTerminationHandler.js';
import { logger } from '../../../../infra/logging/logger.js';

const log = logger('realtime.ivr');

export function registerCallIvrListeners() {
    const toSupervisors = (callId, event, data) => board.callEvent(Tier.SUPERVISOR, callId, event, data, { callRoom: false });

    EventBus.on('call:ivr_node', ({ callId, tenantId, nodeType, nodeId }) => {
        if (tenantId) toSupervisors(callId, 'call:ivr_state', { callId, nodeType, nodeId });
    });

    EventBus.on('call:ivr_transferred', ({ callId, tenantId }) => {
        log.info({ callId }, 'IVR transferred');
        if (tenantId) toSupervisors(callId, 'call:ivr_transferred', { callId });
    });

    EventBus.on('call:ivr_terminated', ({ callId, action, tenantId }) => {
        if (!tenantId) return;
        const terminationReason = ivrTerminationReason(action);
        toSupervisors(callId, 'call:ivr_terminated', {
            callId, action, reason: terminationReason, terminationReason,
        });
    });

    EventBus.on('call:ivr_session_closed', (data) => {
        const { callId, tenantId, outcome, durationSeconds } = data;
        log.info({ callId }, `IVR session closed — outcome=${outcome}, duration=${durationSeconds ?? 'n/a'}s`);
        if (tenantId) toSupervisors(callId, 'call:ivr_session_closed', data);
    });
}
