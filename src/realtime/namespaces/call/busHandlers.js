// src/realtime/namespaces/call/busHandlers.js
import { registerCallStateListeners } from './handlers/state.js';
import { registerCallDeliveryListeners } from './handlers/delivery.js';
import { registerCallMediaListeners } from './handlers/media.js';
import { registerCallNetworkListeners } from './handlers/network.js';
import { registerCallIvrListeners } from './handlers/ivr.js';

export default function registerCallEventBusListeners() {
    registerCallStateListeners();
    registerCallDeliveryListeners();
    registerCallMediaListeners();
    registerCallNetworkListeners();
    registerCallIvrListeners();
}
