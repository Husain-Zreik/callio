// src/websocket/namespaces/device/socketHandlers.js
import { presenceService } from "../../../services/redis/PresenceService.js";

export default function registerDeviceSocketListeners(socket) {
    const userId = socket.user?.id || "Unknown";

    // The client emits this after login (or whenever the FCM token refreshes).
    // Payload: { device_id, fcm_token, device_info? }
    socket.on("device:register", async ({ device_id, fcm_token, device_info } = {}) => {
        if (!device_id || !fcm_token) {
            socket.emit("device:register:ack", { success: false, error: "device_id and fcm_token are required" });
            return;
        }
        try {
            await presenceService.registerDevice(userId, device_id, fcm_token, device_info ?? {});
            socket.emit("device:register:ack", { success: true, device_id });
        } catch (err) {
            console.error(`[WS] device:register failed for user ${userId}:`, err.message);
            socket.emit("device:register:ack", { success: false, error: "Registration failed" });
        }
    });

    // The client emits this on explicit logout or before a token unlink.
    // Payload: { device_id }
    socket.on("device:unregister", async ({ device_id } = {}) => {
        if (!device_id) {
            socket.emit("device:unregister:ack", { success: false, error: "device_id is required" });
            return;
        }
        try {
            await presenceService.unregisterDevice(userId, device_id);
            socket.emit("device:unregister:ack", { success: true, device_id });
        } catch (err) {
            console.error(`[WS] device:unregister failed for user ${userId}:`, err.message);
            socket.emit("device:unregister:ack", { success: false, error: "Unregister failed" });
        }
    });
}
