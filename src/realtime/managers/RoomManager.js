// src/realtime/managers/RoomManager.js
import { presenceService } from "../../core/agents/PresenceService.js";
import { logger } from '../../infra/logging/logger.js';

const log = logger('realtime.RoomManager');

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
            if (socket && String(socket.callId) === String(callId)) {
                delete socket.callId;
                socket.isMonitoring = false;
            }
        });
    }

    // Clears socket.callId for one specific socket, wherever in the cluster
    // it actually lives. Local sockets are cleared directly (fast path, no
    // Redis round-trip); a socket not found locally is assumed to belong to
    // another worker and is cleared via serverSideEmit instead.
    _clearRemoteSocketCallId(socketId, callId) {
        const localSocket = this.io.sockets.sockets.get(socketId);
        if (localSocket) {
            if (String(localSocket.callId) === String(callId)) {
                delete localSocket.callId;
                localSocket.isMonitoring = false;
            }
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

    broadcastToTenant(tenantId, event, data) {
        this.io.to(`tenant:${tenantId}`).emit(event, data);
    }

    // Several agents at once (e.g. the members a RING_ALL call is offered to).
    emitToUsers(userIds, event, data) {
        const rooms = [...new Set((userIds || []).map((id) => `user:${id}`))];
        if (rooms.length) this.io.to(rooms).emit(event, data);
    }

    async addUsersToCallRoom(userIds, callId) {
        const rooms = [...new Set((userIds || []).map((id) => `user:${id}`))];
        if (rooms.length) await this.io.in(rooms).socketsJoin(`call:${callId}`);
    }

    broadcastToSupervisors(tenantId, event, data) {
        this.io.to(`supervisors:${tenantId}`).emit(event, data);
    }

    // ── Domain broadcasts ─────────────────────────────────────────────────────

    broadcastToCall(callId, event, data) {
        this.io.to(`call:${callId}`).emit(event, data);
    }

    // ── Room joins ────────────────────────────────────────────────────────────

    joinUserRoom(socket, userId) {
        socket.join(`user:${userId}`);
    }

    joinTenantRoom(socket, tenantId) {
        socket.join(`tenant:${tenantId}`);
    }

    joinSupervisorRoom(socket, tenantId) {
        socket.join(`supervisors:${tenantId}`);
    }

    joinCallRoom(socket, callId) {
        socket.join(`call:${callId}`);
    }

    // ── Room leaves ───────────────────────────────────────────────────────────

    leaveCallRoom(socket, callId) {
        if (callId) {
            socket.leave(`call:${callId}`);
            delete socket.callId;
        }
    }

    // ── Cross-worker room management ──────────────────────────────────────────

    // Takes one socket out of a call wherever in the cluster it lives: leaves
    // the room (adapter-wide) and clears its call binding.
    async detachSocketFromCall(socketId, callId) {
        if (!socketId || !callId) return;
        await this.io.in(socketId).socketsLeave(`call:${callId}`);
        this._clearRemoteSocketCallId(socketId, callId);
    }

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
            log.error({ agentId: userId, callId, err }, 'Failed to clear call binding');
        }

        await this.io.in(`user:${userId}`).socketsLeave(roomName);
    }
}

export const roomManager = new RoomManager();
