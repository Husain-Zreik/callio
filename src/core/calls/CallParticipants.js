// src/core/calls/CallParticipants.js
// Who is in a call (call_participants). The call flows report joins and
// leaves here at the points where they already commit them: the customer on
// arrival (inbound) or answer (outbound), an agent on accept or call:start,
// a supervisor on monitor start, and everyone left when the call ends.
// Bookkeeping only: a failed write is logged, never thrown into a call flow.
import CallParticipantRepository from '../../persistence/CallParticipantRepository.js';
import { ParticipantKind, LeaveReason } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.calls.CallParticipants');

class CallParticipants {
    async join(call, { kind, agentId = null, deviceId = null, at } = {}) {
        try {
            await CallParticipantRepository.join({
                callId: call.id, tenantId: call.tenant_id, kind, agentId, deviceId, at: at ?? new Date(),
            });
        } catch (err) {
            log.error({ callId: call.id, agentId, err }, `Recording the ${kind} joining failed`);
        }
    }

    async leave(callId, { kind, agentId = null, reason, at } = {}) {
        try {
            await CallParticipantRepository.leave({ callId, kind, agentId, reason, at: at ?? new Date() });
        } catch (err) {
            log.error({ callId, agentId, err }, `Recording the ${kind} leaving failed`);
        }
    }

    async callEnded(callId, at) {
        try {
            await CallParticipantRepository.leaveAll(callId, LeaveReason.ENDED, at ?? new Date());
        } catch (err) {
            log.error({ callId, err }, 'Closing the participants failed');
        }
    }

    async agentDevice(callId, agentId, deviceId) {
        try {
            await CallParticipantRepository.setDevice({ callId, kind: ParticipantKind.AGENT, agentId, deviceId });
        } catch (err) {
            log.error({ callId, agentId, err }, 'Recording the agent device failed');
        }
    }
}

export const callParticipants = new CallParticipants();
