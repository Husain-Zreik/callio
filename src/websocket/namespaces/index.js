// src/websocket/namespaces/index.js
// callio only serves the call + device namespaces — chat/orders/templates/
// activities/ticket stayed behind in the monorepo (see TABLE_OWNERSHIP.md /
// this repo's README for the extraction boundary).
import registerCallSocketHandlers from "./call/socketHandlers.js";
import registerCallBusHandlers from "./call/busHandlers.js";
import registerDeviceSocketHandlers from "./device/socketHandlers.js";

export function registerAllEventBusListeners() {
    registerCallBusHandlers();
}

export function registerAllSocketListeners(socket) {
    registerCallSocketHandlers(socket);
    registerDeviceSocketHandlers(socket);
}
