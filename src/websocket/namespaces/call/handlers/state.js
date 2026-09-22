// src/websocket/namespaces/call/handlers/state.js
import EventBus from '../../../../services/core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';

export function registerCallStateListeners(networkLossTimers) {
    EventBus.on('call:status', (data) => {
        const { businessId } = data;
        roomManager.broadcastToBusiness(businessId, 'call:status', data);
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
        const { callId, businessId, userId, agentName, deviceId, action } = data;
        console.log(`[EventBus] Call ${callId} ${action} by ${agentName} (${userId})`);
        roomManager.broadcastToBusiness(businessId, 'call:handled', { callId, businessId, userId, agentName, deviceId: deviceId ?? null, action });
    });

    EventBus.on('call:reconnected', (data) => {
        const { callId, userId } = data;
        console.log(`[EventBus] Call ${callId} reconnected by user ${userId}`);
        roomManager.broadcastToCall(callId, 'call:reconnected', data);
    });

    EventBus.on('call:terminated', (data) => {
        const { callId, businessId, reason } = data;
        console.log(`[EventBus] Call terminated: ${callId} reason=${reason}`);

        // Cancel any pending network-loss timers so they don't fire a phantom
        // CALL_TERMINATED event after the call has already been cleaned up.
        const timerKey = String(callId);
        const pendingTimers = networkLossTimers.get(timerKey);
        if (pendingTimers) {
            clearTimeout(pendingTimers.warnTimer);
            clearTimeout(pendingTimers.terminateTimer);
            networkLossTimers.delete(timerKey);
        }

        roomManager.broadcastToBusiness(businessId, 'call:terminated', data);
    });

    EventBus.on('call:agent_queue', (data) => {
        const { businessId } = data;
        roomManager.broadcastToBusiness(businessId, 'call:agent_queue', data);
    });

    EventBus.on('call:agent_availability', (data) => {
        const { businessId } = data;
        roomManager.broadcastToBusiness(businessId, 'call:agent_availability', data);
    });
}
