// src/core/calls/IncomingCallPayload.js
// Payload of the `call:incoming` EventBus event (and the agent socket event of
// the same name). Every assignment path builds it with fromCall() so agents
// always receive the same shape: the CallView plus how the call reached them.
import { AssignmentType } from '../constants/CallConstants.js';
import { toCallView } from './CallView.js';

export class IncomingCallPayload {
    /**
     * @param {object} call      calls row
     * @param {object} options
     *   agentId        the agent it's assigned to (null = offered to offeredAgentIds)
     *   agentName
     *   offeredAgentIds agents it's offered to without an assignment (RING_ALL)
     *   sdpOffer       the AGENT-leg offer
     *   assignmentType AssignmentType
     *   transferredFrom, assignedBy  set for transfers
     */
    static fromCall(call, {
        agentId = call?.agent_id ?? null,
        agentName = null,
        offeredAgentIds = null,
        sdpOffer = null,
        assignmentType,
        transferredFrom = null,
        assignedBy = null,
    } = {}) {
        if (!call?.id) throw new Error('IncomingCallPayload: call required');
        if (!assignmentType || !Object.values(AssignmentType).includes(assignmentType))
            throw new Error(`IncomingCallPayload: invalid assignmentType "${assignmentType}"`);

        const payload = new IncomingCallPayload();
        Object.assign(payload, toCallView(call, { agentName }), {
            agentId,
            agentName,
            offeredAgentIds: offeredAgentIds ?? (agentId ? [agentId] : []),
            sdpOffer,
            assignmentType,
            transferredFrom,
            assignedBy,
        });
        return payload;
    }
}
