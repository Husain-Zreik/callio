// src/core/calls/CallAccess.js
// Who may act on a call. The agent gateway asks this before a socket joins a
// call's room or sends a call action — identity comes from the socket's
// verified token, never from the payload.
import CallRepository from '../../persistence/CallRepository.js';
import QueueRepository from '../../persistence/QueueRepository.js';
import { AgentRole, CallStatus, QueueStrategy } from '../constants/CallConstants.js';

const ACTIVE = new Set([CallStatus.INITIATED, CallStatus.RINGING, CallStatus.IN_PROGRESS]);

class CallAccess {
    async #activeCallInTenant(callId, tenantId) {
        const call = await CallRepository.findById(callId);
        if (!call || String(call.tenant_id) !== String(tenantId) || !ACTIVE.has(call.status)) return null;
        return call;
    }

    // An unassigned call is offered to the members of its RING_ALL queue. A call
    // without a queue is only ever offered to the agent it is assigned to.
    async #isOffered(call, agentId) {
        if (call.agent_id != null) return false;
        if (!call.queue_id) return false;
        const queue = await QueueRepository.findById(call.queue_id);
        if (!queue || queue.strategy !== QueueStrategy.RING_ALL) return false;
        return QueueRepository.isMember(queue.id, agentId);
    }

    /**
     * The agent handling (or being offered) the call: accept, reject,
     * reconnect, hang up. Returns the call row or null.
     */
    async asAgent(callId, { agentId, tenantId }) {
        const call = await this.#activeCallInTenant(callId, tenantId);
        if (!call) return null;
        if (String(call.agent_id) === String(agentId)) return call;
        return await this.#isOffered(call, agentId) ? call : null;
    }

    // A supervisor of the call's tenant: monitor, whisper, barge.
    async asSupervisor(callId, { tenantId, role }) {
        if (role !== AgentRole.SUPERVISOR) return null;
        return this.#activeCallInTenant(callId, tenantId);
    }

    // Transfer: the agent on the call, or any supervisor of the tenant.
    async canTransfer(callId, { agentId, tenantId, role }) {
        const call = await this.#activeCallInTenant(callId, tenantId);
        if (!call) return null;
        if (role === AgentRole.SUPERVISOR) return call;
        return String(call.agent_id) === String(agentId) ? call : null;
    }
}

export const callAccess = new CallAccess();
