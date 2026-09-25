// src/websocket/namespaces/index.js
// Registers the call-domain socket listeners. Push-token registration is an
// HTTP concern, not a socket one.
import registerCallSocketHandlers from "./call/socketHandlers.js";
import registerCallBusHandlers from "./call/busHandlers.js";

export function registerAllEventBusListeners() {
    registerCallBusHandlers();
}

export function registerAllSocketListeners(socket) {
    registerCallSocketHandlers(socket);
}
