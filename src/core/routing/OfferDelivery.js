// src/core/routing/OfferDelivery.js
// Whether a call:incoming offer should reach its agent. A direct offer to an
// agent who already has another call ringing is a double dispatch (two
// assignment paths raced): it is suppressed and cleanup releases the call.
// Transfers are deliberate and exempt. Fails open — a failed check delivers.
import CallRepository from '../../persistence/CallRepository.js';
import { AssignmentType } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.routing.OfferDelivery');

class OfferDelivery {
    /** { deliver: true } or { deliver: false, priorCallId } */
    async check({ callId, agentId, assignmentType }) {
        if (!agentId || assignmentType === AssignmentType.TRANSFERRED) return { deliver: true };
        try {
            const priorCallId = await CallRepository.getConflictingRingingCallId(agentId, callId);
            return priorCallId === null ? { deliver: true } : { deliver: false, priorCallId };
        } catch (err) {
            log.error({ callId, err }, 'Double-assignment guard failed — failing open');
            return { deliver: true };
        }
    }
}

export const offerDelivery = new OfferDelivery();
