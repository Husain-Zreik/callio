// src/core/calls/CallQueryService.js
// Read query for active call state (agent resync). Includes lazy cleanup:
// stale calls discovered during a query are enqueued for background cleanup.
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import { callCleanupService } from './CallCleanupService.js';
import { toCallView } from './CallView.js';
import { ConnectionType, CallDirection, CallStatus } from '../constants/CallConstants.js';

class CallQueryService {

    /**
     * @param {number} tenantId
     * @param {number|null} agentId  Scope to one agent's calls (agent view). Null for
     *   supervisor views, which need every call including IVR-active ones.
     */
    async getOngoingCalls(tenantId, agentId = null) {
        const calls = agentId
            ? await CallRepository.getOngoingCallsForAgent(tenantId, agentId)
            : await CallRepository.getOngoingCallsForTenant(tenantId);
        const now = Date.now();

        callCleanupService.processCleanupQueue(tenantId);

        const agentIds = [...new Set(calls.map((c) => c.agent_id).filter(Boolean).map(String))];
        const agentNames = agentIds.length ? await AgentRepository.getNamesByIds(agentIds) : new Map();

        // One query for every call's AGENT leg (device binding + pending offer).
        const agentLegs = calls.length
            ? await CallConnectionRepository.findByCallIdsAndType(calls.map((c) => c.id), ConnectionType.AGENT)
            : [];
        const legByCallId = new Map(agentLegs.map((leg) => [leg.call_id, leg]));

        const results = calls.map((call) => {
            try {
                // Assigned RINGING calls past a minute are already dead at the
                // provider (QUEUE-state calls are intentionally waiting) — clean up
                // and leave them out.
                if (call.status === CallStatus.RINGING && call.state !== 'QUEUE' && call.agent_id != null && call.ringing_at) {
                    const ringingMinutes = (now - new Date(call.ringing_at).getTime()) / 60000;
                    if (ringingMinutes > 1) {
                        callCleanupService.enqueue(call.id, tenantId, 'NO_ANSWER');
                        return null;
                    }
                }
                // IN_PROGRESS with a termination reason is a contradiction — clean up.
                if (call.status === CallStatus.IN_PROGRESS && call.termination_reason) {
                    callCleanupService.enqueue(call.id, tenantId, call.termination_reason);
                    return null;
                }

                const leg = legByCallId.get(call.id) ?? null;
                const view = toCallView(call, {
                    agentName: call.agent_id ? (agentNames.get(String(call.agent_id)) ?? null) : null,
                    // Lets a reloaded client tell "bound to this device" from
                    // "bound to my other device".
                    deviceId: leg?.device_id ?? null,
                });
                view.sdpOffer = (call.status === CallStatus.RINGING && call.direction === CallDirection.INBOUND)
                    ? (leg?.local_sdp ?? null)
                    : null;
                return view;
            } catch (err) {
                console.error(`[CallQueryService] Failed to process call ${call.id}:`, err);
                return null;
            }
        });

        return results.filter(Boolean);
    }
}

export const callQueryService = new CallQueryService();
