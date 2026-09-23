// Entry point — wires the application together and starts the HTTP/WebSocket server.
// Keep this file as an orchestrator only: no business logic, no service implementation.
// Init sequences → src/server/bootstrap.js  |  Shutdown → src/server/shutdown.js
// Routes → src/routes/  |  Handlers → src/controllers/

// Logging must be the very first thing installed so no import-time
// console.log slips through before the dated files are open.
import { appLogService } from "./src/services/monitoring/AppLogService.js";
appLogService.install();

import { config } from "./config/envConfig.js";
import { createWebSocketServer } from "./src/websocket/server.js";
import { presenceService } from "./src/services/redis/PresenceService.js";
import { redisCleanupService } from "./src/services/redis/RedisCleanupService.js";
import { callCleanupService } from "./src/services/call/cleanup/CallCleanupService.js";
import { peerRegistry } from "./src/services/call/signaling/webrtc/PeerRegistry.js";
import { workerStatsService } from "./src/services/monitoring/WorkerStatsService.js";
import { initRedis, initOptionalServices } from "./src/server/bootstrap.js";
import { shutdown } from "./src/server/shutdown.js";
import { handleWorkerHealth } from "./src/controllers/healthController.js";
import apiRoutes from "./src/routes/apiRoutes.js";
import express from "express";
import http from "http";
import cors from "cors";

const app = express();
const server = http.createServer(app);
let io = null;

app.use(cors({ origin: config.node.corsAllowedOrigins }));
app.use(express.json({ limit: "10mb" }));

async function startServer() {
    try {
        console.log("🚀 Starting server...");

        await initRedis();
        await initOptionalServices();

        app.use("/api", apiRoutes);
        app.get("/health", handleWorkerHealth);

        io = createWebSocketServer(server);

        // Reject new Socket.IO connections when this worker is at capacity.
        // The client's built-in reconnect + Nginx least_conn routes the retry to
        // a less-loaded worker. Error 400 (Socket.IO default) — not 503 because
        // Nginx cannot intercept Socket.IO upgrade errors.
        const MAX_CALLS_PER_WORKER = config.call.workers.maxCallsPerWorker;
        io.use((socket, next) => {
            if (peerRegistry.peerConnections.size >= MAX_CALLS_PER_WORKER) {
                console.warn(`[AdmissionControl] Worker at capacity (${peerRegistry.peerConnections.size}/${MAX_CALLS_PER_WORKER}) — rejecting connection`);
                return next(new Error('SERVER_AT_CAPACITY'));
            }
            next();
        });

        await presenceService.clearAllPresence();
        redisCleanupService.start();
        callCleanupService.start();

        process.on("SIGINT",  () => shutdown(server, io));
        process.on("SIGTERM", () => shutdown(server, io));
        workerStatsService.start();

        server.listen(config.node.port, config.node.host, () => {
            console.log(`🚀 Server running on ${config.node.host}:${config.node.port}`);
            console.log(`📡 WebSocket: ws://${config.node.host}:${config.node.port}/socket.io`);
            console.log(`🌐 API: http://${config.node.host}:${config.node.port}/api`);
        });
    } catch (error) {
        console.error("❌ Server startup failed:", error.message);
        process.exit(1);
    }
}

process.on("unhandledRejection", (reason) => {
    console.error("❌ Unhandled Rejection:", reason);
    workerStatsService.logSnapshot('unhandled_rejection');
});

process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err.message, err.stack);
    workerStatsService.logSnapshot('uncaught_exception');
    process.exit(1);
});

startServer();
