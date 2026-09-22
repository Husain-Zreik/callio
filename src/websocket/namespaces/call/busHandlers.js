// src/websocket/namespaces/call/busHandlers.js
import { registerCallStateListeners } from './handlers/state.js';
import { registerCallDeliveryListeners } from './handlers/delivery.js';
import { registerCallMediaListeners } from './handlers/media.js';
import { registerCallNetworkListeners } from './handlers/network.js';
import { registerCallIvrListeners } from './handlers/ivr.js';

export default function registerCallEventBusListeners() {
    // Shared across state (cleared on call:terminated) and
    // network (created/cleared on customer:media:state drop/active).
    const networkLossTimers = new Map();

    registerCallStateListeners(networkLossTimers);
    registerCallDeliveryListeners();
    registerCallMediaListeners();
    registerCallNetworkListeners(networkLossTimers);
    registerCallIvrListeners();
}
