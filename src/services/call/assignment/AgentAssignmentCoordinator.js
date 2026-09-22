import EventBus from '../../core/EventBus.js';
import CallRepository from '../../../repositories/CallRepository.js';
import AgentRepository from '../../../repositories/AgentRepository.js';
import BusinessRepository from '../../../repositories/BusinessRepository.js';
import CallConnectionRepository from '../../../repositories/CallConnectionRepository.js';
import UserGroupRepository from '../../../repositories/UserGroupRepository.js';
import OneSignalService from '../../notifications/OneSignalService.js';
import { sdpCoordinator } from '../signaling/webrtc/SDPCoordinator.js';
import { callAgentAssignmentService } from '../../redis/CallAgentAssignmentService.js';
import { callLifecycleLogger } from '../lifecycle/CallLifecycleLogger.js';
import { ConnectionType, AssignmentType, AgentAvailability, RoutingStrategy } from '../constants/CallConstants.js';
import { IncomingCallPayload } from './IncomingCallPayload.js';
import { NotificationPresets, NotificationIcons, absoluteUrl } from '../../notifications/notificationPresets.js';
import { presenceService } from '../../redis/PresenceService.js';

class AgentAssignmentCoordinator {
    constructor() {
        this._callEventCallback = null;
    }

    setCallEventCallback(fn) {
        this._callEventCallback = fn;
    }

    async emitQueueUpdate(businessId) {
        if (!businessId) return;

        const isCallCenter = await BusinessRepository.isCallCentered(businessId);
        if (!isCallCenter) return;

        const agents = await AgentRepository.getCallCenterAgents(businessId);
        const snapshot = await callAgentAssignmentService.buildQueueSnapshot(businessId, agents);
        EventBus.emit('call:agent_queue', snapshot);
    }

    // Centralized here (rather than in each of the ~10 call sites across the
    // termination/rejection/transfer/IVR/connection-failure handlers) so the
    // "tell the agent's own socket" broadcast can't be forgotten at a new
    // call site the way the original ON_CALL-side broadcast was.
    async releaseAgentIfIdle(userId) {
        if (!userId) return false;
        const released = await AgentRepository.setAgentAvailableIfNoActiveCalls(userId);
        if (released) await this._broadcastAvailability(userId, AgentAvailability.AVAILABLE);
        return released;
    }

    async _broadcastAvailability(userId, availability) {
        try {
            const businessId = await AgentRepository.getUserBusinessId(userId);
            if (!businessId) return;
            EventBus.emit('call:agent_availability', {
                businessId,
                userId,
                availability,
                updatedAt: new Date().toISOString(),
            });
        } catch (err) {
            console.error(`[AgentAssignmentCoordinator] Failed to broadcast availability for user ${userId}:`, err.message);
        }
    }

    /**
     * Validates and resolves an agent availability sync request.
     * Returns { userId, availability } on success, null if unauthorized or invalid.
     */
    async resolveAvailabilitySync(businessId, actorUserId, targetUserId) {
        if (!actorUserId || !targetUserId) return null;

        const isSelfSync = actorUserId === targetUserId;
        if (!isSelfSync) {
            const managers = await AgentRepository.getCallCenterManagers(businessId);
            const isManager = managers.some((m) => String(m.id) === String(actorUserId));
            if (!isManager) {
                console.warn(`[AgentAssignmentCoordinator] Unauthorized availability sync by user ${actorUserId} for user ${targetUserId} in business ${businessId}`);
                return null;
            }
        }

        const agents = await AgentRepository.getCallCenterAgents(businessId);
        const targetAgent = agents.find((agent) => String(agent.id) === String(targetUserId));
        if (!targetAgent) {
            console.warn(`[AgentAssignmentCoordinator] Ignoring availability sync for non-agent user ${targetUserId} in business ${businessId}`);
            return null;
        }

        let availability = String(targetAgent.call_availability || '').toUpperCase();

        // Safety net: if the agent is stuck ON_CALL but has no active calls
        // (e.g. connect+terminate webhook race), release to OFFLINE.
        // OFFLINE is safer than AVAILABLE — avoids pushing them into the
        // inbound queue unexpectedly on a page refresh.
        if (availability === AgentAvailability.ON_CALL && isSelfSync) {
            const released = await AgentRepository.setAgentOfflineIfNoActiveCalls(targetUserId);
            if (released) {
                console.log(`[AgentAssignmentCoordinator] Safety net: released stuck ON_CALL agent ${targetUserId} to OFFLINE`);
                availability = AgentAvailability.OFFLINE;
            }
        }

        if (!Object.values(AgentAvailability).includes(availability)) return null;

        return { userId: targetUserId, availability };
    }

    /**
     * Full availability sync: resolves, broadcasts via EventBus, and triggers
     * assignment if the agent just became available.
     */
    async syncAgentAvailability(businessId, actorUserId, targetUserId) {
        try {
            const result = await this.resolveAvailabilitySync(businessId, actorUserId, targetUserId);
            if (!result) return;

            const { userId, availability } = result;

            EventBus.emit('call:agent_availability', {
                businessId,
                userId,
                availability,
                updatedAt: new Date().toISOString(),
            });

            if (availability === AgentAvailability.AVAILABLE) {
                try {
                    const assigned = await this.assignOldestUnassignedCall(businessId);
                    if (!assigned) await this.emitQueueUpdate(businessId);
                } catch (assignmentErr) {
                    console.error(
                        `[AgentAssignmentCoordinator] Availability sync assignment error for business ${businessId}, user ${userId}:`,
                        assignmentErr.message
                    );
                    await this.emitQueueUpdate(businessId).catch((queueErr) => {
                        console.error(
                            `[AgentAssignmentCoordinator] Availability sync queue update fallback failed for business ${businessId}:`,
                            queueErr.message
                        );
                    });
                }
            }
        } catch (error) {
            console.error(
                `[AgentAssignmentCoordinator] Availability sync failed for business ${businessId}, actor ${actorUserId}, target ${targetUserId}:`,
                error.message
            );
        }
    }

    async releaseAgentOfflineIfIdle(userId) {
        if (!userId) return false;
        const released = await AgentRepository.setAgentOfflineIfNoActiveCalls(userId);
        if (released) await this._broadcastAvailability(userId, AgentAvailability.OFFLINE);
        return released;
    }

    _parseCallMetadata(call) {
        const raw = call?.metadata;
        if (!raw) return null;
        if (typeof raw === 'object') return raw;
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    _normalizeIdList(ids) {
        if (!Array.isArray(ids)) return [];
        return [...new Set(
            ids
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id))
        )];
    }

    async _getGroupAgentIdSet(groupId, businessId, cache) {
        const key = String(groupId);
        if (cache.has(key)) return cache.get(key);

        const members = await UserGroupRepository.getCallCenterAgentsForGroup(businessId, Number(groupId));
        const set = new Set(members.map((member) => Number(member.id)));
        cache.set(key, set);
        return set;
    }

    async _resolveScopedAvailableAgentsForCall(call, allAgents, businessId, groupMembersCache, businessRoutingCache) {
        const availableAgents = allAgents.filter(
            (agent) => agent.call_availability === AgentAvailability.AVAILABLE
        );
        if (!availableAgents.length) return [];

        const metadata = this._parseCallMetadata(call);
        let routing = metadata?.routing && typeof metadata.routing === 'object'
            ? metadata.routing
            : null;
        if (!routing) {
            const cacheKey = String(businessId);
            let settings = businessRoutingCache?.get(cacheKey) || null;
            if (!settings) {
                settings = await BusinessRepository.getCallRoutingSettings(businessId);
                businessRoutingCache?.set(cacheKey, settings);
            }
            const strategyRaw = String(settings?.assignmentStrategy || RoutingStrategy.QUEUE).toUpperCase();
            const receptionistTargetType = settings?.receptionistTargetType ?? null;
            const receptionistTargetId = settings?.receptionistTargetId ?? null;
            const receptionistAgentId = settings?.receptionistAgentId ?? null;
            const receptionistGroupId = settings?.receptionistGroupId ?? null;
            const priorityMode = settings?.priorityMode ?? 'AGENT_ORDER';
            const priorityGroupId = settings?.priorityGroupId ?? null;
            const priorityAgentIds = settings?.priorityAgentIds ?? [];

            let strategy = strategyRaw;

            if (strategyRaw === RoutingStrategy.RECEPTIONIST) {
                const hasReceptionistAgent = receptionistTargetType === 'agent' && Number.isFinite(Number(receptionistAgentId ?? receptionistTargetId));
                const hasReceptionistGroup = receptionistTargetType === 'group' && Number.isFinite(Number(receptionistGroupId ?? receptionistTargetId));
                if (!hasReceptionistAgent && !hasReceptionistGroup) {
                    strategy = RoutingStrategy.QUEUE;
                }
            } else if (strategyRaw === RoutingStrategy.PRIORITY) {
                const normalizedMode = String(priorityMode || 'AGENT_ORDER').toUpperCase();
                const hasPriorityGroup = normalizedMode === 'GROUP_LEAD_FIRST' && Number.isFinite(Number(priorityGroupId));
                const hasPriorityAgents = normalizedMode !== 'GROUP_LEAD_FIRST' && Array.isArray(priorityAgentIds) && priorityAgentIds.length > 0;
                if (!hasPriorityGroup && !hasPriorityAgents) {
                    strategy = RoutingStrategy.QUEUE;
                }
            }

            routing = {
                assignmentStrategy: strategy,
                strategy,
                receptionistTargetType,
                receptionistTargetId,
                receptionistAgentId,
                receptionistGroupId,
                priorityMode,
                priorityGroupId,
                priorityAgentIds,
            };
        }

        const strategy = String(routing.assignmentStrategy || routing.strategy || RoutingStrategy.QUEUE).toUpperCase();

        if (strategy === RoutingStrategy.RECEPTIONIST) {
            const targetType = String(routing.receptionistTargetType || '').toLowerCase();

            if (targetType === 'agent') {
                const targetAgentId = Number(routing.receptionistAgentId ?? routing.receptionistTargetId);
                if (!Number.isFinite(targetAgentId)) return [];
                return availableAgents.filter((agent) => Number(agent.id) === targetAgentId);
            }

            if (targetType === 'group') {
                const targetGroupId = Number(routing.receptionistGroupId ?? routing.receptionistTargetId);
                if (!Number.isFinite(targetGroupId)) return [];
                const groupAgentSet = await this._getGroupAgentIdSet(targetGroupId, businessId, groupMembersCache);
                return availableAgents.filter((agent) => groupAgentSet.has(Number(agent.id)));
            }

            return [];
        }

        if (strategy === RoutingStrategy.PRIORITY) {
            const priorityMode = String(routing.priorityMode || 'AGENT_ORDER').toUpperCase();

            if (priorityMode === 'GROUP_LEAD_FIRST') {
                const priorityGroupId = Number(routing.priorityGroupId);
                if (!Number.isFinite(priorityGroupId)) return [];
                const priorityGroupSet = await this._getGroupAgentIdSet(priorityGroupId, businessId, groupMembersCache);
                return availableAgents.filter((agent) => priorityGroupSet.has(Number(agent.id)));
            }

            const priorityAgentIds = this._normalizeIdList(routing.priorityAgentIds);
            if (!priorityAgentIds.length) return [];
            const priorityAgentSet = new Set(priorityAgentIds);
            return availableAgents.filter((agent) => priorityAgentSet.has(Number(agent.id)));
        }

        return availableAgents;
    }

    async assignOldestUnassignedCall(businessId) {
        if (!businessId) return false;

        const isCallCenter = await BusinessRepository.isCallCentered(businessId);
        if (!isCallCenter) return false;

        for (let attempt = 0; attempt < 3; attempt++) {
            const agents = await AgentRepository.getCallCenterAgents(businessId);
            if (!agents.length) {
                return false;
            }

            const unassignedCalls = await CallRepository.findOldestUnassignedCalls(businessId, 25);
            if (!unassignedCalls.length) {
                return false;
            }

            let anyCallTakenByAnotherWorker = false;
            const groupMembersCache = new Map();
            const businessRoutingCache = new Map();

            for (const unassignedCall of unassignedCalls) {
                const eligibleAvailableAgents = await this._resolveScopedAvailableAgentsForCall(
                    unassignedCall,
                    agents,
                    businessId,
                    groupMembersCache,
                    businessRoutingCache
                );

                if (!eligibleAvailableAgents.length) continue;

                let callTakenByAnotherWorker = false;
                const selectedAgent = await callAgentAssignmentService.pickAgentForBusiness(
                    businessId,
                    eligibleAvailableAgents,
                    async (agentId) => {
                        const { claimed, assigned } = await AgentRepository.claimAgentAndAssignCall(agentId, unassignedCall.id);
                        if (assigned) return true;
                        if (claimed && !assigned) callTakenByAnotherWorker = true;
                        return false;
                    }
                );

                if (!selectedAgent) {
                    if (callTakenByAnotherWorker) anyCallTakenByAnotherWorker = true;
                    continue;
                }

                const userId = selectedAgent.id;
                const agentName = selectedAgent.name || null;

                const agentSocketCount = await presenceService.getUserSocketCount(userId);
                await callLifecycleLogger.logAssigned(unassignedCall.id, businessId, userId, {
                    assignment_type: AssignmentType.QUEUED,
                    agent_connected: agentSocketCount > 0,
                    agent_socket_count: agentSocketCount,
                });

                const frontendConnection = await CallConnectionRepository.findByCallAndType(unassignedCall.id, ConnectionType.FRONTEND);
                const sdpOffer = frontendConnection?.local_sdp
                    || await sdpCoordinator.createSDPOffer(unassignedCall.id, ConnectionType.FRONTEND, this._callEventCallback);

                let callRoutingContext;
                try {
                    const meta = typeof unassignedCall.metadata === 'string'
                        ? JSON.parse(unassignedCall.metadata)
                        : unassignedCall.metadata;
                    callRoutingContext = meta?.routing ?? undefined;
                } catch {
                    callRoutingContext = undefined;
                }

                EventBus.emit('call:incoming', new IncomingCallPayload({
                    callId: unassignedCall.id,
                    wacid: unassignedCall.wacid,
                    businessId,
                    userId,
                    agentName,
                    callerId: unassignedCall.client_number_id,
                    callerName: unassignedCall.caller_name,
                    callerUsername: unassignedCall.caller_username,
                    callerNumber: unassignedCall.caller_number,
                    calleeId: unassignedCall.business_number_id,
                    calleeName: unassignedCall.callee_name,
                    calleeNumber: unassignedCall.callee_number,
                    ringingAt: unassignedCall.ringing_at,
                    sdpOffer,
                    assignmentType: AssignmentType.QUEUED,
                    routingContext: callRoutingContext,
                }));

                // claimAgentAndAssignCall above already flipped this agent's DB
                // availability to ON_CALL — tell their own socket too, same gap
                // fixed for the webhook's direct-assignment path.
                EventBus.emit('call:agent_availability', {
                    businessId,
                    userId,
                    availability: AgentAvailability.ON_CALL,
                    updatedAt: new Date().toISOString(),
                });

                await this.emitQueueUpdate(businessId);
                return true;
            }

            if (!anyCallTakenByAnotherWorker) {
                return false;
            }
        }

        return false;
    }

    /**
     * Assign a specific call (e.g. IVR-transferred) to the best available agent.
     *
     * targetType: 'agent' → try that exact agent first, fall back to queue
     * targetType: 'group' → pick within the group per the business's routing
     *                        strategy (priority/queue/receptionist), fall back to queue
     * targetType: 'queue' (default) → find any available agent for the business
     *
     * @param {number} callId
     * @param {object} callRecord  Full call row from DB (with id, wacid, caller_number, etc.)
     * @param {number} businessId
     * @param {string} targetType  'agent' | 'group' | 'queue'
     * @param {number|null} targetId   userId (agent) or groupId (group)
     * @returns {Promise<boolean>}  true if assigned to an agent, false if queued
     */
    async assignTransferredCall(callId, callRecord, businessId, targetType = 'queue', targetId = null) {
        // Build candidate agent list based on target
        let candidates = [];
        let preClaimedAgent = null; // set when the picker below already claimed the agent+call together

        if (targetType === 'agent' && targetId) {
            const agent = await AgentRepository.findUserById(targetId);
            if (agent && agent.call_availability === 'AVAILABLE') candidates = [agent];
        } else if (targetType === 'group' && targetId) {
            preClaimedAgent = await this._assignGroupByRoutingStrategy(callId, businessId, targetId);
            if (preClaimedAgent) candidates = [preClaimedAgent];
        } else {
            // Queue mode: use the same round-robin picker used by inbound routing.
            const all = await AgentRepository.getCallCenterAgents(businessId);
            const available = all.filter((a) => a.call_availability === AgentAvailability.AVAILABLE);
            if (available.length) {
                preClaimedAgent = await callAgentAssignmentService.pickAgentForBusiness(
                    businessId,
                    available,
                    async (agentId) => {
                        const { assigned } = await AgentRepository.claimAgentAndAssignCall(agentId, callId);
                        return assigned;
                    }
                );
                if (preClaimedAgent) candidates = [preClaimedAgent];
            }
        }

        for (const agent of candidates) {
            if (!preClaimedAgent) {
                const { claimed, assigned } = await AgentRepository.claimAgentAndAssignCall(agent.id, callId);
                if (!claimed) continue;
                if (!assigned) continue;
            }

            const transferAgentSocketCount = await presenceService.getUserSocketCount(agent.id);
            await callLifecycleLogger.logAssigned(callId, businessId, agent.id, {
                assignment_type: AssignmentType.QUEUED,
                agent_connected: transferAgentSocketCount > 0,
                agent_socket_count: transferAgentSocketCount,
            });

            // IvrTransferHandler pre-creates the FRONTEND peer connection and its
            // SDP offer on the same worker before calling assignTransferredCall.
            // Re-using that offer avoids calling createSDPOffer on an already-
            // initialised peer, which would add a second placeholder sender and
            // cause the agent to hear the reconnecting tone alongside the caller.
            const existingFrontendConn = await CallConnectionRepository.findByCallAndType(callId, ConnectionType.FRONTEND);
            const sdpOffer = existingFrontendConn?.local_sdp
                ?? await sdpCoordinator.createSDPOffer(callId, ConnectionType.FRONTEND, this._callEventCallback);

            EventBus.emit('call:incoming', new IncomingCallPayload({
                callId,
                wacid: callRecord.wacid,
                businessId,
                userId: agent.id,
                agentName: agent.name || null,
                callerId: callRecord.client_number_id,
                callerName: callRecord.caller_name,
                callerUsername: callRecord.caller_username,
                callerNumber: callRecord.caller_number,
                calleeId: callRecord.business_number_id,
                calleeName: callRecord.callee_name,
                calleeNumber: callRecord.callee_number,
                ringingAt: callRecord.ringing_at,
                sdpOffer,
                assignmentType: AssignmentType.QUEUED,
            }));

            await this._sendIvrAssignedNotification({
                userId: agent.id,
                agentName: agent.name,
                businessId,
                wacid: callRecord.wacid,
                callerName: callRecord.caller_name,
                callerUsername: callRecord.caller_username,
                callerNumber: callRecord.caller_number,
            });

            await this.emitQueueUpdate(businessId);
            console.log(`[AgentAssignment] IVR-transferred call ${callId} assigned to agent ${agent.id}`);
            return true;
        }

        // No available agent — emit queue update and notify managers so the call
        // doesn't sit silently in the queue.
        await this.emitQueueUpdate(businessId);
        await this._sendIvrQueuedNotification({
            businessId,
            wacid: callRecord.wacid,
            callerName: callRecord.caller_name,
            callerUsername: callRecord.caller_username,
            callerNumber: callRecord.caller_number,
        });
        console.log(`[AgentAssignment] IVR-transferred call ${callId} placed in queue (no available agent)`);
        return false;
    }

    /**
     * Pick an agent within an IVR-targeted group per the business's configured
     * assignment strategy, so a group transfer honors the same routing rules as
     * a direct inbound call — instead of always taking the lowest-id available
     * member. Mirrors CallWebhookProcessor._findPriorityAgent's GROUP_LEAD_FIRST
     * ordering and reuses the same group-scoped pickers as the receptionist path.
     *
     * PRIORITY + GROUP_LEAD_FIRST → group leads first, then members, id order
     * PRIORITY + AGENT_ORDER      → business's priorityAgentIds order, remainder by id
     * QUEUE / RECEPTIONIST        → fair round-robin among the group's members
     *
     * Claims the agent and assigns the call atomically.
     * @returns {Promise<object|null>} the claimed agent row, or null if none available/claimable
     */
    async _assignGroupByRoutingStrategy(callId, businessId, groupId) {
        const availableGroupAgents = await UserGroupRepository.getAvailableCallCenterAgentsForGroup(businessId, groupId);
        if (!availableGroupAgents.length) return null;

        const claimFn = async (agentId) => {
            const { assigned } = await AgentRepository.claimAgentAndAssignCall(agentId, callId);
            return assigned;
        };

        const routing = await BusinessRepository.getCallRoutingSettings(businessId);

        if (routing.assignmentStrategy === RoutingStrategy.PRIORITY) {
            const preferredIds = routing.priorityMode === 'GROUP_LEAD_FIRST'
                ? [
                    ...availableGroupAgents
                        .filter((agent) => String(agent.group_role || '').toUpperCase() === 'LEAD')
                        .sort((a, b) => Number(a.id) - Number(b.id))
                        .map((agent) => agent.id),
                    ...availableGroupAgents
                        .filter((agent) => String(agent.group_role || '').toUpperCase() !== 'LEAD')
                        .sort((a, b) => Number(a.id) - Number(b.id))
                        .map((agent) => agent.id),
                ]
                : routing.priorityAgentIds;

            return callAgentAssignmentService.pickPriorityAgentForBusinessByOrder(
                businessId, preferredIds, availableGroupAgents, claimFn
            );
        }

        // QUEUE / RECEPTIONIST — no leader concept here, rotate fairly among the group.
        return callAgentAssignmentService.pickAgentForGroup(businessId, groupId, availableGroupAgents, claimFn);
    }

    /**
     * Push notification for an IVR-transferred call that was successfully
     * assigned to a specific agent.
     */
    async _sendIvrAssignedNotification({ userId, agentName, businessId, wacid, callerName, callerUsername, callerNumber }) {
        try {
            const name = agentName || 'Agent';
            // A phone-less (bsuid-only) caller has no callerNumber — prefer
            // their WhatsApp username over the literal "(null)" a bare number
            // interpolation would otherwise render.
            const callerLabel = callerNumber
                ? `${callerName} (${callerNumber})`
                : callerUsername
                    ? `${callerName} (@${callerUsername})`
                    : callerName;
            await OneSignalService.sendToUsers(
                userId,
                `Call from IVR - Assigned to ${name}`,
                `New call from ${callerLabel} routed via IVR menu`,
                {
                    type: 'incoming_call',
                    source: 'ivr',
                    callId: wacid,
                    callerName,
                    callerUsername,
                    callerNumber,
                    businessId,
                    assignedUserId: userId,
                    assignedUserName: name,
                    isCallCenter: true,
                    timestamp: new Date().toISOString(),
                },
                {
                    url: absoluteUrl('/call-center'),
                    icon: NotificationIcons.call,
                    payload: {
                        ...NotificationPresets.transferredCall,
                        buttons: [
                            { id: 'answer', text: 'Answer' },
                            { id: 'decline', text: 'Decline' },
                        ],
                    },
                },
            );
        } catch (err) {
            console.error(`[AgentAssignment] IVR-assigned notification error:`, err.message);
        }
    }

    /**
     * Push notification for an IVR-transferred call that ended up queued
     * because no agent was available. Notifies call-center managers so
     * someone can manually pick the call up.
     */
    async _sendIvrQueuedNotification({ businessId, wacid, callerName, callerUsername, callerNumber }) {
        try {
            const managers = await AgentRepository.getCallCenterManagers(businessId);
            if (!managers.length) return;

            // A phone-less (bsuid-only) caller has no callerNumber — prefer
            // their WhatsApp username over the literal "(null)" a bare number
            // interpolation would otherwise render.
            const callerLabel = callerNumber
                ? `${callerName} (${callerNumber})`
                : callerUsername
                    ? `${callerName} (@${callerUsername})`
                    : callerName;
            await OneSignalService.sendToUsers(
                managers.map(m => m.id),
                'Call Waiting in Queue - From IVR',
                `Unassigned call from ${callerLabel} — IVR transferred but no agent is available`,
                {
                    type: 'incoming_call',
                    source: 'ivr',
                    callId: wacid,
                    callerName,
                    callerUsername,
                    callerNumber,
                    businessId,
                    assignedUserId: null,
                    isCallCenter: true,
                    needsAssignment: true,
                    timestamp: new Date().toISOString(),
                },
                {
                    url: absoluteUrl('/call-center'),
                    icon: NotificationIcons.call,
                    payload: {
                        ...NotificationPresets.incomingCall,
                        buttons: [
                            { id: 'answer', text: 'Answer' },
                            { id: 'decline', text: 'Decline' },
                        ],
                    },
                },
            );
        } catch (err) {
            console.error(`[AgentAssignment] IVR-queued notification error:`, err.message);
        }
    }
}

export const agentAssignmentCoordinator = new AgentAssignmentCoordinator();
