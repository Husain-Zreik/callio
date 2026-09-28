// src/realtime/namespaces/call/handlers/delivery.js
// Delivers ringing calls to agents: the call:incoming socket event to the
// assigned (or, for RING_ALL, offered) agents and their pushes, and the
// supervisor view of every new call.
import EventBus from '../../../../core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';
import { presenceService } from '../../../../core/agents/PresenceService.js';
import { callLifecycleLogger } from '../../../../core/calls/CallLifecycleLogger.js';
import CallRepository from '../../../../persistence/CallRepository.js';
import { AssignmentType } from '../../../../core/constants/CallConstants.js';
import { callPushNotifier } from '../../../../push/CallPushNotifier.js';
import QueueRepository from '../../../../persistence/QueueRepository.js';

async function logDelivery(callId, tenantId, agentId, extra) {
    try {
        const socketIds = await presenceService.getUserSockets(agentId);
        await callLifecycleLogger.logDeliveryAttempt(callId, tenantId, agentId, {
            agent_connected: socketIds.length > 0,
            presence_socket_count: socketIds.length,
            delivered: socketIds.length > 0,
            ...extra,
        });
        if (!socketIds.length) {
            // The room emit still went out; RINGING_AGENT_RECONNECT re-delivers
            // when the agent comes back, and the push wakes a closed app.
            console.warn(`[delivery] Agent ${agentId} has no live sockets at call:incoming time (call=${callId})`);
        }
    } catch (err) {
        console.error(`[delivery] Failed to log delivery attempt for call ${callId}:`, err);
    }
}

export function registerCallDeliveryListeners() {
    EventBus.on('call:incoming', async (payload) => {
        const { callId, tenantId, agentId, offeredAgentIds, assignmentType } = payload;
        console.log(`[delivery] Incoming call ${callId} (${assignmentType}) → agent=${agentId ?? '-'} offered=${(offeredAgentIds ?? []).join(',') || '-'}`);

        // The supervisor view never carries the agent-leg SDP offer.
        const supervisorView = { ...payload, sdpOffer: undefined };

        // IVR calls have no agent yet — only supervisors see them.
        if (assignmentType === AssignmentType.IVR) {
            roomManager.broadcastToSupervisors(tenantId, 'call:incoming:supervisor', supervisorView);
            return;
        }

        // Race guard for direct assignments: an older call already ringing this
        // agent means this one is a double-dispatch — suppress it (cleanup
        // releases it). Transfers are deliberate and exempt. Fails open.
        if (agentId && assignmentType !== AssignmentType.TRANSFERRED) {
            let priorCallId = null;
            try {
                priorCallId = await CallRepository.getConflictingRingingCallId(agentId, callId);
            } catch (guardErr) {
                console.error(`[delivery] Double-assignment guard failed for call ${callId} — failing open:`, guardErr);
            }
            if (priorCallId !== null) {
                console.warn(`[delivery] Double-assignment race: suppressing call ${callId} for agent ${agentId} — call ${priorCallId} is already ringing`);
                await logDelivery(callId, tenantId, agentId, {
                    delivered: false,
                    suppression_reason: 'prior_ringing_call',
                    prior_call_id: priorCallId,
                });
                return;
            }
        }

        roomManager.broadcastToSupervisors(tenantId, 'call:incoming:supervisor', supervisorView);

        const targets = agentId ? [agentId] : (offeredAgentIds ?? []);
        if (!targets.length) {
            console.log(`[delivery] Call ${callId} waiting — no agent to offer it to yet`);
            return;
        }

        await roomManager.addUsersToCallRoom(targets, callId);
        roomManager.emitToUsers(targets, 'call:incoming', payload);
        await Promise.all(targets.map((id) => logDelivery(callId, tenantId, id, { offered_to: targets.length })));

        callPushNotifier.notifyIncoming(payload, targets)
            .catch((err) => console.error(`[delivery] Incoming push failed for call ${callId}:`, err));
    });

    // Dismiss any ringing UI for a call that ended.
    EventBus.on('call:terminated', ({ callId }) => {
        callPushNotifier.notifyCallEnded(callId)
            .catch((err) => console.error(`[delivery] Call-ended push failed for call ${callId}:`, err));
    });

    // Room membership changes requested by the core (transfers, RING_ALL declines).
    EventBus.on('call:room:broadcast', ({ callId, event, data }) => roomManager.broadcastToCall(callId, event, data));
    EventBus.on('call:room:leave', ({ userId, callId }) => { if (userId) roomManager.removeUserFromCallRoom(userId, callId); });
    EventBus.on('call:room:join', ({ userId, callId }) => { if (userId) roomManager.addUserToCallRoom(userId, callId); });

    // A RING_ALL offer this agent declined: dismiss it on their other tabs/devices.
    EventBus.on('call:offer_declined', ({ callId, userId }) => {
        roomManager.emitToUser(userId, 'call:offer_withdrawn', { callId, reason: 'declined' });
    });

    // Another member took a RING_ALL call: withdraw it from everyone else.
    EventBus.on('call:offer_taken', async ({ callId, takenBy, queueId }) => {
        try {
            const others = (await QueueRepository.getMemberIds(queueId)).filter((id) => String(id) !== String(takenBy));
            if (!others.length) return;
            roomManager.emitToUsers(others, 'call:offer_withdrawn', { callId, reason: 'taken', takenBy });
            await Promise.all(others.map((id) => roomManager.removeUserFromCallRoom(id, callId)));
        } catch (err) {
            console.error(`[delivery] Failed to withdraw RING_ALL offer for call ${callId}:`, err);
        }
    });

    EventBus.on('call:transferred', (data) => {
        const { tenantId, oldAgentId, sdpOffer, ...safeData } = data;
        console.log(`[delivery] Call ${safeData.callId} transferred`);
        roomManager.broadcastToSupervisors(tenantId, 'call:transferred', safeData);
        if (oldAgentId) roomManager.emitToUser(oldAgentId, 'call:transferred', safeData);
    });

    // A refreshed call:incoming to the exact socket that reconnected, after the
    // media-owning worker recreated the AGENT peer (RINGING_AGENT_RECONNECT).
    EventBus.on('call:ringing_reconnect_deliver', ({ socketId, payload }) => {
        roomManager.emitToSocket(socketId, 'call:incoming', payload);
    });
}
