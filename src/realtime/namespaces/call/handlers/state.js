// src/realtime/namespaces/call/handlers/state.js
// Call state, agent statuses and queue snapshots: each to its audience — a
// call's events to its call room and the board, an agent's status to their own
// sockets and the board, queue snapshots to the board (managers/Board.js).
import EventBus from '../../../../core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';
import { board, Tier } from '../../../managers/Board.js';
import { logger } from '../../../../infra/logging/logger.js';

const log = logger('realtime.state');

export function registerCallStateListeners() {
    EventBus.on('call:status', (data) => {
        board.callEvent(Tier.TEAM, data.callId, 'call:status', data);
    });

    EventBus.on('call:success', (data) => {
        const { callId, message, code } = data;
        roomManager.broadcastToCall(callId, 'call:success', { callId, message, code });
    });

    EventBus.on('call:error', (data) => {
        const { callId, message, code } = data;
        roomManager.broadcastToCall(callId, 'call:error', { callId, message, code });
    });

    EventBus.on('call:handled', (data) => {
        const { callId, tenantId, userId, agentName, deviceId, action } = data;
        log.debug({ callId, agentId: userId }, `Call ${action} by ${agentName}`);
        board.callEvent(Tier.TEAM, callId, 'call:handled', { callId, tenantId, userId, agentName, deviceId: deviceId ?? null, action },
            { extraAgentIds: [userId] });
    });

    // Only the socket that asked gets the answer: other devices in the call
    // room must not apply an SDP answer meant for another peer connection.
    // sdpAnswer answers the agent's offer; sdpOffer (a reconnect without an
    // offer) waits for call:reconnect:answer.
    EventBus.on('call:reconnected', ({ callId, userId, sdpAnswer, sdpOffer, socketId, deviceId }) => {
        log.debug({ callId, agentId: userId }, 'Call reconnected by user');
        if (socketId) {
            roomManager.emitToSocket(socketId, 'call:reconnected', {
                callId, userId, deviceId: deviceId ?? null, ...(sdpOffer ? { sdpOffer } : { sdpAnswer }),
            });
        }
    });

    EventBus.on('call:reconnect:completed', ({ callId, userId, socketId, deviceId }) => {
        if (socketId) roomManager.emitToSocket(socketId, 'call:reconnect:completed', { callId, userId, deviceId: deviceId ?? null });
    });

    EventBus.on('call:terminated', (data) => {
        const { callId, reason } = data;
        log.debug({ callId }, `Call terminated: reason=${reason}`);
        board.callEvent(Tier.TEAM, callId, 'call:terminated', data);
    });

    EventBus.on('call:agent_queue', (data) => {
        board.queueSnapshot(data.tenantId, data.queueId, 'call:agent_queue', data);
    });

    EventBus.on('call:agent_availability', (data) => {
        board.agentStatus(data.tenantId, data.userId, 'call:agent_availability', data);
    });
}
