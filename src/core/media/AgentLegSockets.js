// src/core/media/AgentLegSockets.js
// Which agent socket a call's agent leg was set up from, on the worker
// holding the call. A reconnect from a different socket that is still live
// is a takeover: that socket is told it lost the call
// (AgentEventHandler.handleAgentReconnected).
import EventBus from '../EventBus.js';

class AgentLegSockets {
    constructor() {
        this._byCall = new Map();
        EventBus.on('call:terminated', ({ callId }) => this._byCall.delete(String(callId)));
    }

    set(callId, socketId) {
        if (socketId) this._byCall.set(String(callId), socketId);
    }

    get(callId) {
        return this._byCall.get(String(callId)) ?? null;
    }
}

export const agentLegSockets = new AgentLegSockets();
