// src/core/events/handlers/TransferEventHandler.js
// Moves a live call to another agent — named directly, or picked from a queue
// by the queue's strategy. Also used by supervisors to assign an unassigned call.
import CallRepository from '../../../persistence/CallRepository.js';
import AgentRepository from '../../../persistence/AgentRepository.js';
import QueueRepository from '../../../persistence/QueueRepository.js';
import CallConnectionRepository from '../../../persistence/CallConnectionRepository.js';
import EventBus from '../../EventBus.js';
import { agentAssignmentCoordinator } from '../../routing/AgentAssignmentCoordinator.js';
import { queueRouter } from '../../routing/QueueRouter.js';
import { callLifecycleLogger } from '../../calls/CallLifecycleLogger.js';
import { callMedia } from '../../media/CallMedia.js';
import { mediaLegs } from '../../media/MediaLegs.js';
import { ConnectionType, AssignmentType, AgentRole, InitiatorType, CallStatus, ParticipantKind, LeaveReason } from '../../constants/CallConstants.js';
import { IncomingCallPayload } from '../../calls/IncomingCallPayload.js';
import { callParticipants } from '../../calls/CallParticipants.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.TransferEventHandler');

export class TransferEventHandler {

    async handleCallTransferred(data) {
        const {
            callId,
            newAgentId,
            tenantId,
            assignorId,
            targetType = 'agent',
            targetQueueId = null,
        } = data;

        log.info({ callId }, `Transferring call using targetType=${targetType}`);

        try {
            const call = await CallRepository.findById(callId);
            if (!call || String(call.tenant_id) !== String(tenantId)) throw new Error('Call not found');

            // The current agent comes from the call row, never from the client.
            const oldAgentId = call.agent_id ?? null;
            const [oldAgent, assignor] = await Promise.all([
                oldAgentId ? AgentRepository.findById(oldAgentId) : null,
                assignorId ? AgentRepository.findById(assignorId) : null,
            ]);

            const resolved = await this._resolveTransferTarget({
                callId, tenantId, targetType, targetQueueId, newAgentId, excludeAgentId: oldAgentId,
            });

            if (oldAgentId && String(oldAgentId) === String(resolved.newAgentId)) {
                throw new Error('Call is already assigned to this agent');
            }

            const moved = oldAgentId == null
                ? await CallRepository.assignCallToAgentIfUnassigned(callId, resolved.newAgentId)
                : await CallRepository.updateCallAgentIfCurrent(callId, oldAgentId, resolved.newAgentId);
            if (!moved) {
                await agentAssignmentCoordinator.releaseAgent(resolved.newAgentId, callId);
                throw new Error('Call transfer conflict: call state changed during transfer');
            }
            if (resolved.queueId && String(resolved.queueId) !== String(call.queue_id)) {
                await CallRepository.updateQueue(callId, resolved.queueId);
            }
            // The target must accept within CALL_TRANSFER_TIMEOUT_SECONDS (QueueTimeoutService).
            if (call.status === CallStatus.IN_PROGRESS) await CallRepository.markHandoverOffered(callId, resolved.newAgentId);

            if (oldAgentId) {
                await callParticipants.leave(callId, { kind: ParticipantKind.AGENT, agentId: oldAgentId, reason: LeaveReason.TRANSFERRED });
                await agentAssignmentCoordinator.releaseAgent(oldAgentId, callId);
            }

            // The old agent leaves the room (the customer hears the reconnect tone
            // until the new agent joins); a fresh leg is offered to the new agent.
            if (oldAgentId) await callMedia.dropAgent(callId, oldAgentId);
            const sdpOffer = await mediaLegs.offerAgent(call);

            const wasUnassigned = oldAgentId == null;
            const transferredFrom = wasUnassigned
                ? { id: assignor?.id ?? null, name: assignor?.name ?? null, isAssignment: true }
                : { id: oldAgentId, name: oldAgent?.name ?? null, isAssignment: false };
            const assignedBy = (!wasUnassigned && assignor && String(assignor.id) !== String(oldAgentId))
                ? { id: assignor.id, name: assignor.name }
                : null;
            const initiatorType = !assignor ? InitiatorType.SYSTEM
                : assignor.role === AgentRole.SUPERVISOR ? InitiatorType.SUPERVISOR : InitiatorType.AGENT;

            // The old agent's clients drop the call; the new agent's join its room.
            EventBus.emit('call:room:broadcast', { callId, event: 'call:terminated', data: { callId, reason: 'transferred' } });
            if (oldAgentId) EventBus.emit('call:room:leave', { userId: oldAgentId, callId });
            EventBus.emit('call:room:join', { userId: resolved.newAgentId, callId });

            await callLifecycleLogger.logTransferred(
                callId, tenantId,
                oldAgentId, resolved.newAgentId,
                {
                    assignor_id: assignor?.id ?? null,
                    assignor_name: assignor?.name ?? null,
                    assignor_type: initiatorType,
                    was_unassigned: wasUnassigned,
                    target_type: resolved.targetType,
                    to_queue_id: resolved.queueId,
                },
                { userId: assignor?.id ?? null, type: initiatorType }
            );
            await callLifecycleLogger.logAssigned(callId, tenantId, resolved.newAgentId, {
                assignment_type: wasUnassigned ? AssignmentType.DIRECT : AssignmentType.TRANSFERRED,
            });

            const updatedCall = await CallRepository.findById(callId);
            const payload = IncomingCallPayload.fromCall(updatedCall, {
                agentId: resolved.newAgentId,
                agentName: resolved.newAgent?.name ?? null,
                sdpOffer,
                assignmentType: AssignmentType.TRANSFERRED,
                transferredFrom,
                assignedBy,
            });
            EventBus.emit('call:incoming', payload);
            EventBus.emit('call:transferred', {
                ...payload,
                tenantId,
                oldAgentId,
                userId: resolved.newAgentId,
                targetQueueId: resolved.queueId,
                transferTarget: { type: resolved.targetType, queueId: resolved.queueId },
            });
            await agentAssignmentCoordinator.emitQueueUpdate(tenantId);

            log.info({ callId, toAgentId: resolved.newAgentId }, 'Call transferred to an agent');
        } catch (error) {
            log.error({ callId, err: error }, 'Failed to transfer call');
            throw error;
        }
    }

    // Claims the target agent for the call (on shift and not busy). Returns
    // { targetType, queueId, newAgentId, newAgent }.
    async _resolveTransferTarget({ callId, tenantId, targetType, targetQueueId, newAgentId, excludeAgentId }) {
        if (targetType === 'queue' || (!newAgentId && targetQueueId)) {
            if (!targetQueueId) throw new Error('Missing target queue');
            const queue = await QueueRepository.findForTenant(targetQueueId, tenantId);
            if (!queue || queue.status !== 'ACTIVE') throw new Error('Target queue not found for this tenant');

            const agent = await queueRouter.claimMemberForTransfer(queue, callId, excludeAgentId);
            if (!agent) throw new Error('No available agents in the selected queue');
            return { targetType: 'queue', queueId: queue.id, newAgentId: agent.id, newAgent: agent };
        }

        if (!newAgentId) throw new Error('Missing target agent');

        const target = await AgentRepository.findById(newAgentId);
        if (!target || String(target.tenant_id) !== String(tenantId)) {
            throw new Error('Target agent does not belong to this tenant');
        }
        if (!await AgentRepository.claimAgentForCall(newAgentId, callId)) {
            throw new Error('Target agent is not available');
        }
        return { targetType: 'agent', queueId: null, newAgentId: target.id, newAgent: target };
    }
}
