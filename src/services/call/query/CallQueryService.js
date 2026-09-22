// services/call/query/CallQueryService.js
// Read query for active call state. Includes lazy cleanup: stale calls
// discovered during a query are enqueued for background cleanup.
import CallRepository from '../../../repositories/CallRepository.js';
import AgentRepository from '../../../repositories/AgentRepository.js';
import CallConnectionRepository from '../../../repositories/CallConnectionRepository.js';
import { callCleanupService } from '../cleanup/CallCleanupService.js';
import { ConnectionType, CallDirection, CallStatus } from '../constants/CallConstants.js';

class CallQueryService {

    /**
     * @param {number} businessId
     * @param {number|null} agentUserId  Scope to a single agent's calls (agent view).
     *   Pass null for manager/supervisor views that need all calls including IVR-active ones.
     */
    async getOngoingCalls(businessId, agentUserId = null) {
        try {
            const calls = agentUserId
                ? await CallRepository.getOngoingCallsForAgent(businessId, agentUserId)
                : await CallRepository.getOngoingCallsForBusiness(businessId);
            const now = Date.now();

            callCleanupService.processCleanupQueue(businessId);

            // Batch-fetch all agent names in one query instead of N per-call queries.
            const uniqueUserIds = [...new Set(calls.map(c => c.user_id).filter(Boolean).map(String))];
            const agentNameMap = uniqueUserIds.length > 0
                ? await AgentRepository.getUserNamesByIds(uniqueUserIds, businessId)
                : new Map();

            // Batch-fetch all FRONTEND connections (deviceId + sdpOffer source)
            // in one query instead of N per-call queries.
            const callIds = calls.map(c => c.id);
            const frontendConnections = callIds.length > 0
                ? await CallConnectionRepository.findByCallIdsAndType(callIds, ConnectionType.FRONTEND)
                : [];
            const connectionByCallId = new Map(frontendConnections.map(c => [c.call_id, c]));

            const results = await Promise.all(calls.map(async (call) => {
                try {
                    const {
                        id: callId, user_id, wacid,
                        client_number_id, business_number_id,
                        caller_name, caller_username, caller_number,
                        callee_name, callee_username, callee_number,
                        direction, status, state,
                        ringing_at: ringingAt, answered_at: startedAt,
                        termination_reason,
                    } = call;

                    // QUEUE state calls are intentionally waiting (post-IVR) — skip stale check.
                    // Assigned RINGING calls past 1 minute: WhatsApp will have dropped them,
                    // so enqueue cleanup and exclude from the response.
                    if (
                        status === CallStatus.RINGING
                        && state !== 'QUEUE'
                        && user_id != null
                        && ringingAt
                    ) {
                        const ringingDuration = (now - new Date(ringingAt).getTime()) / 1000 / 60;
                        if (ringingDuration > 1) {
                            callCleanupService.enqueue(callId, businessId, 'NO_ANSWER');
                            return null;
                        }
                    }

                    // A call cannot be both IN_PROGRESS and already have a termination reason —
                    // enqueue cleanup and exclude from the response.
                    if (status === CallStatus.IN_PROGRESS && termination_reason) {
                        callCleanupService.enqueue(callId, businessId, termination_reason);
                        return null;
                    }

                    const callerId = direction === CallDirection.INBOUND ? client_number_id : business_number_id;
                    const calleeId = direction === CallDirection.OUTBOUND ? client_number_id : business_number_id;

                    const agentName = user_id ? (agentNameMap.get(String(user_id)) ?? null) : null;

                    // deviceId is needed for any ongoing call a client might consider
                    // reconnecting to, so a reloaded/resyncing client can tell "bound
                    // to this exact device" apart from "bound to the same account's
                    // other device", which userId alone can't distinguish.
                    const callConnection = connectionByCallId.get(callId) ?? null;
                    const deviceId = callConnection?.device_id ?? null;

                    let sdpOffer = null;
                    if (status === CallStatus.RINGING && direction === CallDirection.INBOUND) {
                        sdpOffer = callConnection?.local_sdp;
                    }

                    return {
                        callId, wacid, businessId, userId: user_id, agentName, deviceId,
                        status, state, direction, callerId, callerName: caller_name, callerUsername: caller_username, callerNumber: caller_number,
                        calleeId, calleeName: callee_name, calleeUsername: callee_username, calleeNumber: callee_number,
                        ringingAt, startedAt, sdpOffer,
                    };
                } catch (err) {
                    console.error(`[CallQueryService] ❌ Failed to process call ${call.id}:`, err);
                    return null;
                }
            }));

            return results.filter(Boolean);
        } catch (err) {
            console.error('[CallQueryService] ❌ getOngoingCalls error:', err);
            throw err;
        }
    }
}

export const callQueryService = new CallQueryService();
