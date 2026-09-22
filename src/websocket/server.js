// src/websocket/server.js
import { registerAllEventBusListeners } from "./namespaces/index.js";
import { redisPubSubService } from "../services/redis/RedisPubSubService.js";
import { handleConnection } from "./handlers/connectionHandler.js";
import { authMiddleware } from "./middleware/authMiddleware.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { roomManager } from "./managers/RoomManager.js";
import { config } from "../../config/envConfig.js";
import { Server } from "socket.io";

export function createWebSocketServer(httpServer) {
    const io = new Server(httpServer, {
        cors: {
            origin: config.node.corsAllowedOrigins,
            methods: ["GET", "POST"],
            credentials: true,
        },
        path: "/socket.io",
        pingInterval: 15000,
        pingTimeout: 30000,
        // Allow both WebSocket and HTTP long-polling so clients behind corporate
        // proxies or restrictive firewalls that block WebSocket upgrades can still
        // receive real-time events via polling fallback.  The client already has
        // transports: ['websocket', 'polling'] and will always prefer WebSocket;
        // polling is only used when the WebSocket handshake is blocked.
        transports: ["websocket", "polling"],
        allowEIO3: true,
    });

    // ── Redis adapter ──────────────────────────────────────────────────────────
    try {
        const { pubClient, subClient } = redisPubSubService.getAdapterClients();
        io.adapter(createAdapter(pubClient, subClient));
        console.log(`[WS] ✅ Socket.IO Redis adapter initialized for worker ${redisPubSubService.workerId}`);
    } catch (error) {
        console.error(`[WS] ❌ Failed to initialize Redis adapter:`, error.message);
        throw error;
    }

    roomManager.setIO(io);
    io.use(authMiddleware);
    registerAllEventBusListeners();

    io.on("connection", handleConnection);

    io.engine.on("connection_error", (err) => {
        console.error("[WS] Connection error:", {
            code: err.code,
            message: err.message,
            context: err.context,
        });
    });

    return io;
}
