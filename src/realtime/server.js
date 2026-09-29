// src/realtime/server.js
import { registerAllEventBusListeners } from "./namespaces/index.js";
import { redisPubSubService } from "../infra/redis/RedisPubSubService.js";
import { handleConnection } from "./handlers/connectionHandler.js";
import { authMiddleware } from "./middleware/authMiddleware.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { roomManager } from "./managers/RoomManager.js";
import { config } from "../../config/envConfig.js";
import { Server } from "socket.io";
import { logger } from '../infra/logging/logger.js';

const log = logger('realtime.server');

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
        // WebSocket only. Polling needs every request of a session to reach the
        // same worker, which the load balancer's per-connection routing doesn't
        // guarantee across PM2 workers — a polling session would break its own
        // handshake. Media (WebRTC) needs a direct path anyway.
        transports: ["websocket"],
    });

    // ── Redis adapter ──────────────────────────────────────────────────────────
    try {
        const { pubClient, subClient } = redisPubSubService.getAdapterClients();
        io.adapter(createAdapter(pubClient, subClient));
        log.info('Socket.IO Redis adapter initialized');
    } catch (error) {
        log.error({ err: error }, 'Failed to initialize Redis adapter');
        throw error;
    }

    roomManager.setIO(io);
    io.use(authMiddleware);
    registerAllEventBusListeners();

    io.on("connection", handleConnection);

    io.engine.on("connection_error", (err) => {
        log.error({ code: err.code,
            message: err.message,
            context: err.context }, 'Connection error');
    });

    return io;
}
