/**
 * Single source of truth for all call-domain errors.
 * Every error — whether per-call or management-level — must go through here.
 * Always emits 'call:error' so the frontend has one event to handle.
 * Set callId: null for errors with no call context (query/sync failures).
 *
 * Routing:
 *   socket   provided → direct emit to that socket (socket-layer errors)
 *   socketId provided → targeted emit via roomManager (cross-worker handler errors)
 *   neither            → broadcast to call room via EventBus (internal service errors)
 */
import EventBus from '../../core/EventBus.js';
import { roomManager } from '../../../websocket/managers/RoomManager.js';

export function emitCallError({ callId = null, code, message, socket = null, socketId = null }) {
    const payload = { callId, code, message };

    if (socket) {
        socket.emit('call:error', payload);
        return;
    }

    if (socketId) {
        roomManager.emitToSocket(socketId, 'call:error', payload);
        return;
    }

    EventBus.emit('call:error', payload);
}
