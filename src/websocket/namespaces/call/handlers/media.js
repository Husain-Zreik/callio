// src/websocket/namespaces/call/handlers/media.js
import EventBus from '../../../../services/core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';

export function registerCallMediaListeners() {
    EventBus.on('connection:ice-candidate', (data) => {
        const { callId } = data;
        roomManager.broadcastToCall(callId, 'connection:ice-candidate:server', data);
    });

    EventBus.on('call:monitor:started', (data) => {
        const { callId, sdpAnswer, socketId } = data;
        roomManager.emitToSocket(socketId, 'call:monitor:started', { callId, sdpAnswer });
    });

    EventBus.on('call:monitor:mode:changed', (data) => {
        const { callId, mode, socketId } = data;
        // Confirm to the supervisor's own socket…
        roomManager.emitToSocket(socketId, 'call:monitor:mode:changed', { callId, mode });
        // …and reflect to the agent so the active-call UI shows whether the supervisor
        // is whispering or barged in.
        roomManager.broadcastToCall(callId, 'call:supervisor:mode', { callId, mode });
    });

    // Fired by AudioBridge._refreshAgentTrackInMonitor after the monitor's agent-audio
    // sender is seamlessly refreshed with the new FRONTEND track.
    EventBus.on('call:monitor:agent:reconnected', ({ callId, supervisorMode, agentPrivate }) => {
        console.log(`[EventBus] Monitor audio restored after agent reconnect for call ${callId} (mode=${supervisorMode}, private=${agentPrivate})`);
        roomManager.broadcastToCall(callId, 'call:monitor:agent:reconnected', { callId });

        // Re-deliver the active supervisor mode so the reconnected agent sees the correct
        // whisper/barge badge without requiring the manager to manually re-select it.
        if (supervisorMode && supervisorMode !== 'listen') {
            roomManager.broadcastToCall(callId, 'call:supervisor:mode', { callId, mode: supervisorMode });
        }

        // Re-deliver agent-private state so the agent's "speaking only to supervisor" UI
        // banner is restored if they were in private mode before the reconnect.
        if (agentPrivate) {
            roomManager.broadcastToCall(callId, 'call:agent:private:changed', { callId, active: true });
        }
    });

    EventBus.on('call:monitor:ended', (data) => {
        const { callId, socketId, userId } = data;
        roomManager.emitToSocket(socketId, 'call:monitor:ended', { callId, userId });
        // Clear the agent's whisper/barge indicator — the supervisor has left.
        roomManager.broadcastToCall(callId, 'call:supervisor:mode', { callId, mode: 'listen' });
    });

    EventBus.on('call:agent:private:changed', (data) => {
        const { callId, active } = data;
        // Reaches the agent (confirms their toggle) and the supervisor (indicator).
        roomManager.broadcastToCall(callId, 'call:agent:private:changed', { callId, active });
    });

    // Fired by CustomerNetworkMonitor every ~4s with jitter/packet-loss derived quality.
    EventBus.on('call:network:quality:customer', ({ callId, ...quality }) => {
        roomManager.broadcastToCall(callId, 'call:network:quality:customer', { callId, ...quality });
    });

    EventBus.on('call:dtmf', ({ callId, digit }) => {
        roomManager.broadcastToCall(callId, 'call:dtmf', { callId, digit });
    });
}
