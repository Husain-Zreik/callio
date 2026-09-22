// services/call/events/handlers/TransferEventHandler.js
import CallRepository from '../../../../repositories/CallRepository.js';
import AgentRepository from '../../../../repositories/AgentRepository.js';
import UserGroupRepository from '../../../../repositories/UserGroupRepository.js';
import CallConnectionRepository from '../../../../repositories/CallConnectionRepository.js';
import OneSignalService from '../../../../services/notifications/OneSignalService.js';
import { NotificationPresets, NotificationIcons, absoluteUrl } from '../../../notifications/notificationPresets.js';
import EventBus from '../../../core/EventBus.js';
import { agentAssignmentCoordinator } from '../../assignment/AgentAssignmentCoordinator.js';
import { callAgentAssignmentService } from '../../../redis/CallAgentAssignmentService.js';
import { callLifecycleLogger } from '../../lifecycle/CallLifecycleLogger.js';
import { peerRegistry } from '../../signaling/webrtc/PeerRegistry.js';
import { sdpCoordinator } from '../../signaling/webrtc/SDPCoordinator.js';
import { ConnectionType, CallDirection, AssignmentType } from '../../constants/CallConstants.js';
import { IncomingCallPayload } from '../../assignment/IncomingCallPayload.js';

export class TransferEventHandler {

    async handleCallTransferred(data) {
        const {
            callId,
            oldAgentId,
            newAgentId,
            oldAgentName,
            businessId,
            assignorId,
            assignorName,
            targetType = 'agent',
            targetGroupId = null,
        } = data;

        console.log(
            `[TransferEventHandler] Transferring call ${callId} from ${oldAgentId} ` +
            `using targetType=${targetType}`
        );

        try {
            const call = await CallRepository.findById(callId);
            if (!call) throw new Error('Call not found');

            const resolvedTarget = await this._resolveTransferTarget({
                businessId,
                targetType,
                targetGroupId,
                newAgentId,
            });

            if (String(call.user_id) === String(resolvedTarget.newAgentId)) {
                throw new Error('Call is already assigned to this agent');
            }
            if (oldAgentId && String(oldAgentId) === String(resolvedTarget.newAgentId)) {
                throw new Error('Cannot transfer call to the same agent');
            }

            const moved = call.user_id == null
                ? await CallRepository.assignCallToAgentIfUnassigned(callId, resolvedTarget.newAgentId)
                : await CallRepository.updateCallAgentIfCurrent(callId, call.user_id, resolvedTarget.newAgentId);
            if (!moved) {
                await agentAssignmentCoordinator.releaseAgentIfIdle(resolvedTarget.newAgentId);
                throw new Error('Call transfer conflict: call state changed during transfer');
            }
            await callAgentAssignmentService.markAgentAsLastAssigned(businessId, resolvedTarget.newAgentId);

            if (call.user_id) await agentAssignmentCoordinator.releaseAgentIfIdle(call.user_id);

            // Close old FRONTEND, create new SDP offer for new agent
            await peerRegistry.closePeerConnection(callId, ConnectionType.FRONTEND);
            await CallConnectionRepository.cleanupConnection(callId, ConnectionType.FRONTEND);
            const sdpOffer = await sdpCoordinator.createSDPOffer(callId, ConnectionType.FRONTEND);

            const wasUnassigned = call.user_id == null;
            const transferredFrom = wasUnassigned
                ? { id: assignorId, name: assignorName, isAssignment: true }
                : { id: oldAgentId, name: oldAgentName, isAssignment: false };
            const assignedBy = (!wasUnassigned && String(assignorId) !== String(oldAgentId))
                ? { id: assignorId, name: assignorName }
                : null;

            const initiatorType = await AgentRepository.resolveTransferInitiatorType(businessId, assignorId);

            const transferData = {
                callId,
                wacid: call.wacid,
                businessId,
                oldAgentId: wasUnassigned ? null : oldAgentId,
                userId: resolvedTarget.newAgentId,
                agentName: resolvedTarget.newAgent?.name,
                agentEmail: resolvedTarget.newAgent?.email,
                assignmentType: AssignmentType.TRANSFERRED,
                transferredFrom,
                assignedBy,
                transferTarget: {
                    type: resolvedTarget.targetType,
                    groupId: resolvedTarget.targetGroupId,
                },
                callerId: call.direction === CallDirection.INBOUND ? call.client_number_id : call.business_number_id,
                callerName: call.caller_name,
                callerUsername: call.caller_username,
                callerNumber: call.caller_number,
                calleeId: call.direction === CallDirection.OUTBOUND ? call.client_number_id : call.business_number_id,
                calleeName: call.callee_name,
                calleeUsername: call.callee_username,
                calleeNumber: call.callee_number,
                status: call.status,
                direction: call.direction,
                startedAt: call.created_at,
                ringingAt: call.ringing_at,
                answeredAt: call.answered_at,
                sdpOffer,
            };

            try {
                // Mirrors mobile's ringing-screen phrasing exactly: when a
                // manager (someone other than the previous agent) triggered
                // the transfer, credit both — "by {manager} from {previous
                // agent}"; when the previous agent transferred their own
                // call, `assignedBy` is null and naming them twice would be
                // redundant, so just "from {previous agent}". Replaces the
                // old hardcoded `oldAgentName`, which was also flatly wrong
                // for a manager-initiated transfer and undefined for a plain
                // queue pickup (no previous agent at all in that case).
                const transferText = assignedBy?.name
                    ? `has been transferred to you by ${assignedBy.name} from ${transferredFrom.name}`
                    : `has been transferred to you from ${transferredFrom.name}`;
                // A phone-less (bsuid-only) caller has no caller_number —
                // prefer their WhatsApp username over the literal "(null)" a
                // bare number interpolation would otherwise render.
                const callerLabel = call.caller_number
                    ? `${call.caller_name} (${call.caller_number})`
                    : call.caller_username
                        ? `${call.caller_name} (@${call.caller_username})`
                        : call.caller_name;
                const notificationResult = await OneSignalService.sendToUsers(
                    resolvedTarget.newAgentId,
                    'Call Transferred to You',
                    `Call from ${callerLabel} ${transferText}`,
                    {
                        type: 'call_transfer', callId: call.wacid,
                        callerName: call.caller_name, callerUsername: call.caller_username, callerNumber: call.caller_number,
                        businessId, assignedUserId: resolvedTarget.newAgentId,
                        transferredFrom, assignedBy,
                        isCallCenter: true, timestamp: new Date().toISOString(),
                    },
                    {
                        url: absoluteUrl('/call-center'),
                        icon: NotificationIcons.call,
                        payload: {
                            ...NotificationPresets.transferredCall,
                            buttons: [
                                { id: 'answer',  text: 'Answer'  },
                                { id: 'decline', text: 'Decline' },
                            ],
                        },
                    }
                );
                console.log(`[TransferEventHandler] ✅ Notification sent: ${notificationResult.recipients} device(s)`);
            } catch (notificationError) {
                console.error(`[TransferEventHandler] ❌ Notification error:`, notificationError.message);
            }

            // Room management delegated to serverListeners via EventBus
            // (keeps the service layer free of WebSocket transport dependencies).
            EventBus.emit('call:room:broadcast', { callId, event: 'call:terminated', data: { callId, reason: 'Reconnected on another device.' } });
            EventBus.emit('call:room:leave', { userId: oldAgentId, callId });
            EventBus.emit('call:room:join', { userId: resolvedTarget.newAgentId, callId });

            await callLifecycleLogger.logTransferred(
                callId, businessId,
                wasUnassigned ? null : oldAgentId, resolvedTarget.newAgentId,
                {
                    assignor_id: assignorId,
                    assignor_name: assignorName,
                    assignor_type: initiatorType,
                    was_unassigned: wasUnassigned,
                    target_type: resolvedTarget.targetType,
                    target_group_id: resolvedTarget.targetGroupId,
                },
                { userId: assignorId ?? null, type: initiatorType }
            );
            await callLifecycleLogger.logAssigned(callId, businessId, resolvedTarget.newAgentId, {
                assignment_type: wasUnassigned ? AssignmentType.DIRECT : AssignmentType.TRANSFERRED,
            });

            EventBus.emit('call:incoming', new IncomingCallPayload(transferData));
            EventBus.emit('call:transferred', transferData);
            await agentAssignmentCoordinator.emitQueueUpdate(businessId);

            console.log(`[TransferEventHandler] ✅ Call ${callId} transferred successfully`);
        } catch (error) {
            console.error(`[TransferEventHandler] Failed to transfer call ${callId}:`, error.message);
            throw error;
        }
    }

    async _resolveTransferTarget({ businessId, targetType, targetGroupId, newAgentId }) {
        if (targetType === 'group' || (!newAgentId && targetGroupId)) {
            if (!targetGroupId) {
                throw new Error('Missing target group');
            }

            const group = await UserGroupRepository.findByIdForBusiness(targetGroupId, businessId);
            if (!group) {
                throw new Error('Target group not found for this business');
            }

            const availableGroupAgents = await UserGroupRepository.getAvailableCallCenterAgentsForGroup(
                businessId,
                targetGroupId
            );
            if (!availableGroupAgents.length) {
                throw new Error('No available call-center agents in the selected group');
            }

            const selectedAgent = await callAgentAssignmentService.pickAgentForGroup(
                businessId,
                Number(targetGroupId),
                availableGroupAgents,
                async (agentId) => AgentRepository.claimAgentIfAvailable(agentId)
            );
            if (!selectedAgent) {
                throw new Error('Could not claim an available group agent');
            }

            return {
                targetType: 'group',
                targetGroupId: Number(targetGroupId),
                newAgentId: selectedAgent.id,
                newAgent: selectedAgent,
            };
        }

        if (!newAgentId) {
            throw new Error('Missing target agent');
        }

        const targetAgentBusinessId = await AgentRepository.getUserBusinessId(newAgentId);
        if (!targetAgentBusinessId || String(targetAgentBusinessId) !== String(businessId)) {
            throw new Error('Target agent does not belong to this business');
        }

        const claimed = await AgentRepository.claimAgentIfAvailable(newAgentId);
        if (!claimed) {
            throw new Error('Target agent is not available');
        }

        const newAgent = await AgentRepository.findUserById(newAgentId);
        return {
            targetType: 'agent',
            targetGroupId: null,
            newAgentId,
            newAgent,
        };
    }
}
