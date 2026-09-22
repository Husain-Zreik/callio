// src/websocket/managers/RoomManager.js
// src/websocket/managers/RoomManager.js
import { presenceService } from "../../services/redis/PresenceService.js";

class RoomManager {
    io = null;

    setIO(io) {
        this.io = io;
        // Cross-worker receiver for _clearRemoteSocketCallId's fallback below.
        // serverSideEmit reaches every OTHER Socket.IO server process in the
        // cluster (never the one that calls it — that's why
        // _clearRemoteSocketCallId always checks locally first). Whichever
        // worker actually owns this socketId clears the property directly;
        // every other worker's lookup below is just a harmless no-op miss.
        this.io.on('call:clear_socket_binding', (socketId, callId) => {
            const socket = this.io.sockets.sockets.get(socketId);
            if (socket && String(socket.callId) === String(callId)) delete socket.callId;
        });
    }

    // Clears socket.callId for one specific socket, wherever in the cluster
    // it actually lives. Local sockets are cleared directly (fast path, no
    // Redis round-trip); a socket not found locally is assumed to belong to
    // another worker and is cleared via serverSideEmit instead.
    _clearRemoteSocketCallId(socketId, callId) {
        const localSocket = this.io.sockets.sockets.get(socketId);
        if (localSocket) {
            if (String(localSocket.callId) === String(callId)) delete localSocket.callId;
            return;
        }
        this.io.serverSideEmit('call:clear_socket_binding', socketId, callId);
    }

    // ── Point-to-point ────────────────────────────────────────────────────────

    emitToSocket(socketId, event, data) {
        this.io.to(socketId).emit(event, data);
    }

    // Cluster-wide liveness check (this deployment runs multiple workers
    // behind the Redis adapter — a plain local `io.sockets.sockets.has(...)`
    // would only see sockets connected to THIS process and wrongly report
    // "disconnected" for one that's actually live on another worker).
    // fetchSockets() queries the adapter's authoritative live state, not a
    // potentially-stale presence cache.
    async isSocketConnected(socketId) {
        const sockets = await this.io.in(socketId).fetchSockets();
        return sockets.length > 0;
    }

    // Room-based delivery — every socket joins user:${userId} at auth time;
    // Socket.IO removes it on disconnect, so the room is always the live set.
    emitToUser(userId, event, data) {
        this.io.to(`user:${userId}`).emit(event, data);
    }

    // ── Business broadcasts ───────────────────────────────────────────────────

    broadcastToBusiness(businessId, event, data) {
        this.io.to(`business:${businessId}`).emit(event, data);
    }

    broadcastToManagers(businessId, event, data) {
        this.io.to(`managers:${businessId}`).emit(event, data);
    }

    // Broadcasts to the target business AND the SUPER_ADMIN room.
    // Use for ticket events where both the tenant and admins need the update.
    broadcastToBusinessAndAdmins(businessId, event, data) {
        this.io.to(`business:${businessId}`).emit(event, data);
        if (businessId !== "SUPER_ADMIN") {
            this.io.to("business:SUPER_ADMIN").emit(event, data);
        }
    }

    // ── Domain broadcasts ─────────────────────────────────────────────────────

    broadcastToCall(callId, event, data) {
        this.io.to(`call:${callId}`).emit(event, data);
    }

    broadcastToChat(chatId, event, data) {
        this.io.to(`chat:${chatId}`).emit(event, data);
    }

    // Excludes the sender — use when the sender's UI already applied the update optimistically.
    broadcastToTicketRoom(socket, ticketId, event, data) {
        socket.to(`ticket:${ticketId}`).emit(event, data);
    }

    broadcastToTicketAdminRoom(socket, ticketId, event, data) {
        socket.to(`ticket:${ticketId}:admin`).emit(event, data);
    }

    // ── Room joins ────────────────────────────────────────────────────────────

    joinUserRoom(socket, userId) {
        socket.join(`user:${userId}`);
    }

    joinBusinessRoom(socket, businessId) {
        socket.join(`business:${businessId}`);
    }

    joinManagerRoom(socket, businessId) {
        socket.join(`managers:${businessId}`);
    }

    joinCallRoom(socket, callId) {
        socket.join(`call:${callId}`);
    }

    joinChatRoom(socket, chatId) {
        socket.join(`chat:${chatId}`);
    }

    joinTicketRoom(socket, ticketId) {
        socket.join(`ticket:${ticketId}`);
        if (socket.user?.isAdmin) {
            socket.join(`ticket:${ticketId}:admin`);
        }
    }

    // ── Room leaves ───────────────────────────────────────────────────────────

    leaveBusinessRoom(socket, businessId) {
        if (businessId) socket.leave(`business:${businessId}`);
    }

    leaveCallRoom(socket, callId) {
        if (callId) {
            socket.leave(`call:${callId}`);
            delete socket.callId;
        }
    }

    leaveChatRoom(socket, chatId) {
        if (chatId) socket.leave(`chat:${chatId}`);
    }

    leaveTicketRoom(socket, ticketId) {
        socket.leave(`ticket:${ticketId}`);
        socket.leave(`ticket:${ticketId}:admin`);
    }

    // ── Cross-worker room management ──────────────────────────────────────────

    async addUserToCallRoom(userId, callId) {
        // io.in(room).socketsJoin() broadcasts the join instruction through the
        // Redis adapter to every worker, joining call:${callId} for all sockets
        // in user:${userId}. This is the only correct cross-worker path —
        // local socket lookup silently misses sockets on other workers.
        await this.io.in(`user:${userId}`).socketsJoin(`call:${callId}`);
        const socketIds = await presenceService.getUserSockets(userId);
        return socketIds.length;
    }

    async removeUserFromCallRoom(userId, callId) {
        // Room membership (socketsLeave below) is cluster-wide and always
        // correct, but it says nothing about each socket's own local
        // socket.callId property — that property is what the disconnect
        // handler (socketHandlers.js) reads to decide which call a dropped
        // connection belonged to. Left uncleared, a later disconnect of one
        // of this user's OTHER, unrelated sessions (e.g. this exact one,
        // after being transferred away from this call) would misreport
        // itself as this call's frontend dropping — see
        // ConnectionEventHandler.handleFrontendDisconnected's own ownership
        // guard for what that causes downstream. Find which of this user's
        // sockets actually have this call's room (usually zero or one, but a
        // user can have several devices/tabs), then clear each one's
        // binding — locally if it's on this worker, via serverSideEmit
        // (registered in setIO) if it's on another.
        const roomName = `call:${callId}`;
        try {
            const userSockets = await this.io.in(`user:${userId}`).fetchSockets();
            for (const socket of userSockets) {
                if (socket.rooms.has(roomName)) {
                    this._clearRemoteSocketCallId(socket.id, callId);
                }
            }
        } catch (err) {
            console.error(`[RoomManager] Failed to clear call binding for user ${userId}, call ${callId}:`, err.message);
        }

        await this.io.in(`user:${userId}`).socketsLeave(roomName);
    }
}

export const roomManager = new RoomManager();
