// services/call/cleanup/CallCenterToggleService.js
// Reacts to a business's Call Center being disabled from the Laravel side
// (account settings self-service toggle, or an admin editing the business).
// The has_call_center column flip alone never reaches this server's live
// call/agent state — this is the piece that actually terminates whatever's
// in progress and takes every agent/manager off the board, mirroring the
// batchTerminateCalls → batchUpdateAgentAvailability sequencing already
// used by CallCleanupService (calls first, then release agents, since an
// agent can't be safely flipped OFFLINE while a call row still points at
// them as ON_CALL).
import CallRepository from '../../../repositories/CallRepository.js';
import AgentRepository from '../../../repositories/AgentRepository.js';
import EventBus from '../../core/EventBus.js';
import { peerRegistry } from '../signaling/webrtc/PeerRegistry.js';
import { AgentAvailability, TerminationReason, TerminatedBy } from '../constants/CallConstants.js';

class CallCenterToggleService {
    async disableForBusiness(businessId) {
        const ongoingCalls = await CallRepository.getOngoingCallsForBusiness(businessId);
        const callIds = ongoingCalls.map((c) => c.id);

        if (callIds.length > 0) {
            await CallRepository.batchTerminateCalls(callIds, TerminationReason.SERVICE_MAINTENANCE, TerminatedBy.SYSTEM);

            callIds.forEach((id) => {
                peerRegistry.closePeerConnection(id).catch((err) =>
                    console.error(`[CallCenterToggle] Error closing connection ${id}:`, err)
                );
            });

            ongoingCalls.forEach((call) => {
                EventBus.emit('call:terminated', {
                    callId: call.id,
                    businessId: call.business_id,
                    reason: 'call_center_disabled',
                    terminationReason: TerminationReason.SERVICE_MAINTENANCE,
                });
            });

            console.log(`[CallCenterToggle] Terminated ${callIds.length} in-progress call(s) for business ${businessId} (call center disabled)`);
        }

        // Agents AND managers — call_center_manager_access also carries
        // call_receive (see config/roles.php), so managers can be ON_CALL/
        // AVAILABLE too, not just watching the roster.
        const [agents, managers] = await Promise.all([
            AgentRepository.getCallCenterAgents(businessId),
            AgentRepository.getCallCenterManagers(businessId),
        ]);

        const staffById = new Map([...agents, ...managers].map((u) => [u.id, u]));
        const affectedIds = [...staffById.values()]
            .filter((u) => u.call_availability !== AgentAvailability.OFFLINE)
            .map((u) => u.id);

        if (affectedIds.length === 0) return;

        // The active calls above are already terminated, so this is safe to
        // apply unconditionally — batchUpdateAgentAvailability only guards
        // against an active call when releasing TO 'AVAILABLE', not OFFLINE.
        await AgentRepository.batchUpdateAgentAvailability(affectedIds, AgentAvailability.OFFLINE);

        const updatedAt = new Date().toISOString();
        affectedIds.forEach((userId) => {
            EventBus.emit('call:agent_availability', {
                businessId,
                userId,
                availability: AgentAvailability.OFFLINE,
                reason: 'call_center_disabled',
                updatedAt,
            });
        });

        console.log(`[CallCenterToggle] Flipped ${affectedIds.length} agent/manager(s) OFFLINE for business ${businessId} (call center disabled)`);
    }
}

export const callCenterToggleService = new CallCenterToggleService();
