// src/realtime/handlers/connectionHandler.js
import { presenceService } from "../../core/agents/PresenceService.js";
import { redisPubSubService } from "../../infra/redis/RedisPubSubService.js";
import CallRepository from "../../persistence/CallRepository.js";
import { callLifecycleLogger } from "../../core/calls/CallLifecycleLogger.js";
import { EventTypes } from "../../core/events/EventTypes.js";
import { registerAllSocketListeners } from "../namespaces/index.js";
import { agentAssignmentCoordinator } from "../../core/routing/AgentAssignmentCoordinator.js";
import { iceServersFor } from "../../media/webrtc/IceServers.js";
import { AGENT_PROTOCOL_VERSION } from "../middleware/authMiddleware.js";

// What a client needs before it can take calls: who it is, and the ICE
// servers (with TURN credentials minted for this agent) for its peer
// connections. Sent on every connect; session:refresh asks again, e.g. when
// the TURN credentials are about to expire.
function sessionReady(socket) {
    const { iceServers, expiresAt } = iceServersFor(String(socket.user?.id ?? 'agent'));
    return {
        protocol: AGENT_PROTOCOL_VERSION,
        agent: {
            id: socket.user?.id ?? null,
            ref: socket.user?.externalRef ?? null,
            name: socket.user?.name ?? null,
            role: socket.user?.role ?? null,
        },
        tenant: { id: socket.tenant?.id ?? null, ref: socket.tenant?.externalRef ?? null },
        deviceId: socket.user?.deviceId ?? null,
        purpose: socket.connectionPurpose || 'session',
        iceServers,
        iceServersExpireAt: expiresAt,
        serverTime: new Date().toISOString(),
    };
}

export async function handleConnection(socket) {
    const userName = socket.user?.name || "Unknown";
    const userId = socket.user?.id || "Unknown";
    const tenantId = socket.tenant?.id || "Unknown";
    // Only the agent's main 'session' connection takes part in presence,
    // online/offline broadcasts and reconnect redelivery — see authMiddleware's
    // note on connectionPurpose.
    const isSessionConnection = (socket.connectionPurpose || 'session') === 'session';

    console.log(
        `[WS] Agent connected - Name: ${userName}, AgentID: ${userId}, TenantID: ${tenantId}, SocketID: ${socket.id}, Purpose: ${socket.connectionPurpose || 'session'}, Worker: ${redisPubSubService.workerId}`,
    );

    const tracksPresence = userId !== "Unknown" && tenantId !== "Unknown" && isSessionConnection;

    // First, before anything that can deliver a call to this socket.
    socket.emit("session:ready", sessionReady(socket));
    socket.on("session:refresh", () => socket.emit("session:ready", sessionReady(socket)));

    if (tracksPresence) {
        let isFirstSocket = false;
        try {
            await presenceService.trackConnection(userId, socket.id);
            const socketCount = await presenceService.getUserSocketCount(userId);
            isFirstSocket = socketCount === 1;
        } catch (error) {
            console.error(`[WS] Failed to handle presence for user ${userId}:`, error.message);
        }

        await _handlePendingCallRedelivery(socket, userId, tenantId);
        agentAssignmentCoordinator.assignOldestUnassignedCall(tenantId).catch((err) =>
            console.error(`[WS] Queue assignment trigger failed on connect for user ${userId}:`, err.message)
        );

        // Notify managers that this agent just came online (first socket only —
        // opening a second tab should not re-broadcast).
        if (isFirstSocket) {
            agentAssignmentCoordinator.emitQueueUpdate(tenantId).catch((err) =>
                console.error(`[WS] Queue update failed on agent connect for user ${userId}:`, err.message)
            );
        }
    }

    registerAllSocketListeners(socket);


    socket.on("disconnect", async (reason) => {
        console.log(
            `[WS] User disconnected - Name: ${userName}, UserID: ${userId}, SocketID: ${socket.id}, Reason: ${reason}, Purpose: ${socket.connectionPurpose || 'session'}`,
        );
        if (tracksPresence) {
            await presenceService.trackDisconnection(userId, socket.id);

            // Notify managers that this agent just went offline (last socket only —
            // closing one tab when another is still open should not flip the indicator).
            const remainingSockets = await presenceService.getUserSocketCount(userId).catch(() => -1);
            if (remainingSockets === 0) {
                agentAssignmentCoordinator.emitQueueUpdate(tenantId).catch((err) =>
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
async function _handlePendingCallRedelivery(socket, userId, tenantId) {
    try {
        const pendingCall = await CallRepository.findPendingInboundCallForUser(tenantId, userId);
        if (!pendingCall) return;

        const previousSockets = await presenceService.getUserSocketCount(userId);
        const isFirstSocket = previousSockets <= 1;
        const alreadyAccepted = pendingCall.status === 'IN_PROGRESS';

        // Only log on the first socket for an already-accepted call — an agent
        // who was online when they accepted and opens another tab is not a reconnect.
        // For RINGING calls, log on every socket so phantom-socket transitions are visible.
        const shouldLog = !alreadyAccepted || isFirstSocket;

        if (shouldLog) {
            await callLifecycleLogger.logAgentConnected(pendingCall.id, tenantId, userId, {
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
            // Route the AGENT reset through Redis to the SUBSCRIBED WORKER —
            // the same worker that owns the CUSTOMER peer. Creating the AGENT
            // peer here (on the socket worker) could land on a different process
            // where peerRegistry has no CUSTOMER peer, making checkAndStartBridging
            // impossible. The subscribed worker handles RINGING_AGENT_RECONNECT by
            // closing the old AGENT, creating a fresh one (same process as CUSTOMER),
            // and emitting call:incoming back to this exact socket via emitToSocket.
            await redisPubSubService.publishCallEvent(
                pendingCall.id,
                EventTypes.RINGING_AGENT_RECONNECT,
                { callId: pendingCall.id, socketId: socket.id, userId, tenantId },
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
