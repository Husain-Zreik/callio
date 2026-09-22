// services/call/IncomingCallPayload.js
// Validated, consistent payload for the `call:incoming` EventBus event.
// All three assignment paths (DIRECT, QUEUED, TRANSFERRED) must use this class
// so the frontend always receives an identical field shape.
import { AssignmentType } from '../constants/CallConstants.js';

export class IncomingCallPayload {
    constructor({
        callId,
        wacid,
        businessId,
        userId,
        agentName,
        agentEmail,
        callerId,
        callerName,
        callerUsername,
        callerNumber,
        calleeId,
        calleeName,
        calleeUsername,
        calleeNumber,
        status,
        callState = null,
        direction,
        sdpOffer,
        startedAt,
        ringingAt,
        answeredAt,
        assignmentType,
        routingContext = null,
        transferredFrom = null,
        assignedBy = null,
        isCallCenter = false,
    }) {
        if (!callId)     throw new Error('IncomingCallPayload: callId required');
        if (!businessId) throw new Error('IncomingCallPayload: businessId required');
        if (!assignmentType || !Object.values(AssignmentType).includes(assignmentType))
            throw new Error(`IncomingCallPayload: invalid assignmentType "${assignmentType}"`);

        this.callId          = callId;
        this.wacid           = wacid           ?? null;
        this.businessId      = businessId;
        this.userId          = userId          ?? null;
        this.agentName       = agentName       ?? null;
        this.agentEmail      = agentEmail      ?? null;
        this.callerId        = callerId        ?? null;
        this.callerName      = callerName      ?? null;
        this.callerUsername  = callerUsername  ?? null;
        this.callerNumber    = callerNumber    ?? null;
        this.calleeId        = calleeId        ?? null;
        this.calleeName      = calleeName      ?? null;
        this.calleeUsername  = calleeUsername  ?? null;
        this.calleeNumber    = calleeNumber    ?? null;
        this.status          = status          ?? null;
        this.callState       = callState       ?? null;
        this.direction       = direction       ?? null;
        this.sdpOffer        = sdpOffer        ?? null;
        this.startedAt       = startedAt       ?? null;
        this.ringingAt       = ringingAt       ?? null;
        this.answeredAt      = answeredAt      ?? null;
        this.assignmentType  = assignmentType;
        this.routingContext  = routingContext;
        this.transferredFrom = transferredFrom;
        this.assignedBy      = assignedBy;
        this.isCallCenter    = isCallCenter    ?? false;
    }
}
