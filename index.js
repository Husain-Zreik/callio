// Entry point — wires the application together and starts the HTTP/WebSocket server.
// Keep this file as an orchestrator only: no business logic, no service implementation.
// Init sequences → src/server/bootstrap.js  |  Shutdown → src/server/shutdown.js
// HTTP → src/http/  |  Agent sockets → src/realtime/  (layout: PLATFORM_ARCHITECTURE.md §7)

// Logging must be the very first thing installed so no import-time
// console.log slips through before the dated files are open.
import { appLogService } from "./src/infra/logging/AppLogService.js";
appLogService.install();

import { config } from "./config/envConfig.js";
import { createWebSocketServer } from "./src/realtime/server.js";
import { peerRegistry } from "./src/media/webrtc/PeerRegistry.js";
import { workerStatsService } from "./src/infra/monitoring/WorkerStatsService.js";
import { initRedis, initOptionalServices, startCoreServices } from "./src/server/bootstrap.js";
import { shutdown } from "./src/server/shutdown.js";
import registerRoutes from "./src/http/routes/index.js";
import { registerChannels } from "./src/channels/index.js";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";

const fastify = Fastify({ bodyLimit: 10 * 1024 * 1024 });
let server = null;
let io = null;

async function startServer() {
    try {
        console.log("🚀 Starting server...");

        await fastify.register(fastifyCors, { origin: config.node.corsAllowedOrigins });

        await initRedis();
        await initOptionalServices();

        registerChannels();
        await fastify.register(registerRoutes);

        await fastify.ready();
        server = fastify.server;

        io = createWebSocketServer(server);

        // Reject new Socket.IO connections when this worker is at capacity.
        // The client's built-in reconnect + the load balancer route the retry to
        // a less-loaded worker.
        const MAX_CALLS_PER_WORKER = config.call.workers.maxCallsPerWorker;
        io.use((socket, next) => {
            if (peerRegistry.peerConnections.size >= MAX_CALLS_PER_WORKER) {
                console.warn(`[AdmissionControl] Worker at capacity (${peerRegistry.peerConnections.size}/${MAX_CALLS_PER_WORKER}) — rejecting connection`);
                return next(new Error('SERVER_AT_CAPACITY'));
            }
            next();
        });

        await startCoreServices();

        process.on("SIGINT",  () => shutdown(server, io));
        process.on("SIGTERM", () => shutdown(server, io));
        workerStatsService.start();

        await fastify.listen({ port: config.node.port, host: config.node.host });
        console.log(`🚀 Server running on ${config.node.host}:${config.node.port}`);
        console.log(`📡 Agent gateway: ws://${config.node.host}:${config.node.port}/socket.io`);
        console.log(`🌐 Management API: http://${config.node.host}:${config.node.port}/v1`);
    } catch (error) {
        console.error("❌ Server startup failed:", error);
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
