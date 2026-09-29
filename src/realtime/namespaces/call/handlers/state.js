// src/realtime/namespaces/call/handlers/state.js
import EventBus from '../../../../core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';
import { logger } from '../../../../infra/logging/logger.js';

const log = logger('realtime.state');

export function registerCallStateListeners(networkLossTimers) {
    EventBus.on('call:status', (data) => {
        const { tenantId } = data;
        roomManager.broadcastToTenant(tenantId, 'call:status', data);
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
        log.info({ callId, agentId: userId }, `Call ${action} by ${agentName}`);
        roomManager.broadcastToTenant(tenantId, 'call:handled', { callId, tenantId, userId, agentName, deviceId: deviceId ?? null, action });
    });

    // Only the socket that asked gets the answer: other devices in the call
    // room must not apply an SDP answer meant for another peer connection.
    EventBus.on('call:reconnected', ({ callId, userId, sdpAnswer, socketId, deviceId }) => {
        log.info({ callId, agentId: userId }, 'Call reconnected by user');
        if (socketId) roomManager.emitToSocket(socketId, 'call:reconnected', { callId, userId, deviceId: deviceId ?? null, sdpAnswer });
    });

    EventBus.on('call:terminated', (data) => {
        const { callId, tenantId, reason } = data;
        log.info({ callId }, `Call terminated: reason=${reason}`);

        // Cancel any pending network-loss timers so they don't fire a phantom
        // CALL_TERMINATED event after the call has already been cleaned up.
        const timerKey = String(callId);
        const pendingTimers = networkLossTimers.get(timerKey);
        if (pendingTimers) {
            clearTimeout(pendingTimers.warnTimer);
            clearTimeout(pendingTimers.terminateTimer);
            networkLossTimers.delete(timerKey);
        }

        roomManager.broadcastToTenant(tenantId, 'call:terminated', data);
    });

    EventBus.on('call:agent_queue', (data) => {
        const { tenantId } = data;
        roomManager.broadcastToTenant(tenantId, 'call:agent_queue', data);
    });

    EventBus.on('call:agent_availability', (data) => {
        const { tenantId } = data;
        roomManager.broadcastToTenant(tenantId, 'call:agent_availability', data);
    });
}
