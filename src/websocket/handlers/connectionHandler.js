// src/websocket/handlers/connectionHandler.js
import { presenceService } from "../../services/redis/PresenceService.js";
import { redisPubSubService } from "../../services/redis/RedisPubSubService.js";
import { redisBaseService } from "../../services/redis/RedisBaseService.js";
import CallRepository from "../../repositories/CallRepository.js";
import { callLifecycleLogger } from "../../services/call/lifecycle/CallLifecycleLogger.js";
import { EventTypes } from "../../services/call/events/EventTypes.js";
import { registerAllSocketListeners } from "../namespaces/index.js";
import { agentAssignmentCoordinator } from "../../services/call/assignment/AgentAssignmentCoordinator.js";

export async function handleConnection(socket) {
    const userName = socket.user?.name || "Unknown";
    const userId = socket.user?.id || "Unknown";
    const businessId = socket.business?.id || "Unknown";
    // See authMiddleware.js's own doc comment on `connectionPurpose` — a
    // 'session' connection is the main app; anything else (CallkitWatch's
    // watcher, the decline-reject socket) is a short-lived auxiliary
    // connection that authenticates as this same user/device but must not
    // participate in presence tracking, online/offline broadcasts, or
    // reconnect-redelivery — all of that logic below assumes exactly one
    // connection per gate, which an auxiliary connection sharing this
    // device's identity would otherwise silently violate.
    const isSessionConnection = (socket.connectionPurpose || 'session') === 'session';

    console.log(
        `[WS] User connected - Name: ${userName}, UserID: ${userId}, BusinessID: ${businessId}, SocketID: ${socket.id}, Purpose: ${socket.connectionPurpose || 'session'}, Worker: ${redisPubSubService.workerId}`,
    );

    if (userId !== "Unknown" && businessId !== "Unknown" && isSessionConnection) {
        let isFirstSocket = false;
        try {
            await presenceService.trackConnection(userId, businessId, socket.id, socket.user?.fcmToken);
            const socketCount = await presenceService.getUserSocketCount(userId);
            isFirstSocket = socketCount === 1;
        } catch (error) {
            console.error(`[WS] Failed to handle presence for user ${userId}:`, error.message);
        }

        await _handlePendingCallRedelivery(socket, userId, businessId);
        agentAssignmentCoordinator.assignOldestUnassignedCall(businessId).catch((err) =>
            console.error(`[WS] Queue assignment trigger failed on connect for user ${userId}:`, err.message)
        );

        // Notify managers that this agent just came online (first socket only —
        // opening a second tab should not re-broadcast).
        if (isFirstSocket) {
            agentAssignmentCoordinator.emitQueueUpdate(businessId).catch((err) =>
                console.error(`[WS] Queue update failed on agent connect for user ${userId}:`, err.message)
            );
        }
    }

    registerAllSocketListeners(socket);

    socket.on("disconnect", async (reason) => {
        console.log(
            `[WS] User disconnected - Name: ${userName}, UserID: ${userId}, SocketID: ${socket.id}, Reason: ${reason}, Purpose: ${socket.connectionPurpose || 'session'}`,
        );
        if (userId !== "Unknown" && businessId !== "Unknown" && isSessionConnection) {
            await presenceService.trackDisconnection(userId, businessId, socket.id);

            // Intentional logout — clear the role cache so the next login always
            // fetches a fresh role from the DB. Transport drops ('transport close',
            // 'transport error') keep the cache alive to absorb reconnect storms.
            if (reason === 'client namespace disconnect') {
                await redisBaseService.del(`auth:role:${businessId}:${userId}`);
            }

            // Notify managers that this agent just went offline (last socket only —
            // closing one tab when another is still open should not flip the indicator).
            const remainingSockets = await presenceService.getUserSocketCount(userId).catch(() => -1);
            if (remainingSockets === 0) {
                agentAssignmentCoordinator.emitQueueUpdate(businessId).catch((err) =>
                    console.error(`[WS] Queue update failed on agent disconnect for user ${userId}:`, err.message)
                );
            }
        }
    });

    socket.on("error", (error) => {
        console.error(`[WS] Socket error - User: ${userName} (ID: ${userId}), Socket: ${socket.id}`, error);
    });
}

// If the agent was assigned a ringing inbound call while disconnected, log the reconnect
// and re-deliver the call (or skip re-delivery if they already accepted via push notification).
//
// Uses findPendingInboundCallForUser (not a RINGING-only query) to catch the push-notification
// race: a mobile agent can accept natively before this connect handler runs, leaving the call
// already IN_PROGRESS by the time we query — a RINGING-only query would silently miss it.
async function _handlePendingCallRedelivery(socket, userId, businessId) {
    try {
        const pendingCall = await CallRepository.findPendingInboundCallForUser(businessId, userId);
        if (!pendingCall) return;

        const previousSockets = await presenceService.getUserSocketCount(userId);
        const isFirstSocket = previousSockets <= 1;
        const alreadyAccepted = pendingCall.status === 'IN_PROGRESS';

        // Only log on the first socket for an already-accepted call — an agent
        // who was online when they accepted and opens another tab is not a reconnect.
        // For RINGING calls, log on every socket so phantom-socket transitions are visible.
        const shouldLog = !alreadyAccepted || isFirstSocket;

        if (shouldLog) {
            await callLifecycleLogger.logAgentConnected(pendingCall.id, businessId, userId, {
                socket_id: socket.id,
                device_id: socket.user?.deviceId || null,
                user_agent: socket.handshake?.headers?.['user-agent'] || null,
                transport: socket.conn?.transport?.name || null,
                call_status: pendingCall.status,
                call_created_at: pendingCall.created_at,
                seconds_since_assignment: Math.floor(
                    (Date.now() - new Date(pendingCall.ringing_at).getTime()) / 1000
                ),
                previous_socket_count: Math.max(0, previousSockets - 1),
                is_first_socket: isFirstSocket,
                // True when the call is still RINGING and we re-deliver.
                // False when the acceptance raced ahead of this handler.
                re_delivered: isFirstSocket && !alreadyAccepted,
            });
        }

        if (alreadyAccepted) {
            console.log(
                `[WS] Agent ${userId} connected (socket=${socket.id}) but call ` +
                `${pendingCall.id} was already accepted — lifecycle logged, no re-delivery needed`
            );
        } else if (isFirstSocket) {
            // Route the FRONTEND reset through Redis to the SUBSCRIBED WORKER —
            // the same worker that owns the WHATSAPP peer. Creating the FRONTEND
            // peer here (on the socket worker) could land on a different process
            // where peerRegistry has no WHATSAPP peer, making checkAndStartBridging
            // impossible. The subscribed worker handles RINGING_AGENT_RECONNECT by
            // closing the old FRONTEND, creating a fresh one (same process as WHATSAPP),
            // and emitting call:incoming back to this exact socket via emitToSocket.
            await redisPubSubService.publishCallEvent(
                pendingCall.id,
                EventTypes.RINGING_AGENT_RECONNECT,
                { callId: pendingCall.id, socketId: socket.id, userId, businessId },
            );

            console.log(
                `[WS] Re-delivered pending call ${pendingCall.id} to agent ${userId} ` +
                `on late connect (socket=${socket.id})`
            );
        } else {
            console.log(
                `[WS] Agent ${userId} reconnected (socket=${socket.id}) but already had ` +
                `${previousSockets - 1} live socket(s) — lifecycle logged, re-delivery skipped`
            );
        }
    } catch (err) {
        console.error(`[WS] Pending call re-delivery check failed for user ${userId}:`, err.message);
    }
}
