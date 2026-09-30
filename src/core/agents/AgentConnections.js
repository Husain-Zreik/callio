// src/core/agents/AgentConnections.js
// The port the core uses to reach one agent socket: a direct emit, a
// cluster-wide liveness check, detaching a socket from a call room. realtime/
// registers the implementation (RoomManager) when the socket server starts;
// before that (CLI scripts, startup) emits are dropped and no socket is live.
class AgentConnections {
    constructor() {
        this._impl = null;
    }

    register(impl) {
        this._impl = impl;
    }

    emitToSocket(socketId, event, data) {
        this._impl?.emitToSocket(socketId, event, data);
    }

    async isSocketConnected(socketId) {
        return this._impl ? this._impl.isSocketConnected(socketId) : false;
    }

    async detachSocketFromCall(socketId, callId) {
        if (this._impl) await this._impl.detachSocketFromCall(socketId, callId);
    }
}

export const agentConnections = new AgentConnections();
