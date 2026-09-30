// src/realtime/namespaces/call/handlers/network.js
// Customer-network relays to the call room. The policy (grace period, warning,
// ending the call) is core/calls/CustomerNetworkLossPolicy.
import EventBus from '../../../../core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';

export function registerCallNetworkListeners() {
    // Agent and monitor UIs update immediately.
    EventBus.on('customer:media:state', ({ callId, state }) => {
        roomManager.broadcastToCall(callId, 'call:customer:media:state', { callId, state });
    });

    // The call ends in a few seconds unless the customer's audio comes back.
    EventBus.on('call:network:terminating', ({ callId }) => {
        roomManager.broadcastToCall(callId, 'call:network:terminating', { callId });
    });
}
