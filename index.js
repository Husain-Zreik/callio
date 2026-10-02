// Entry point — wires the application together and starts the HTTP/WebSocket server.
// Keep this file as an orchestrator only: no business logic, no service implementation.
// Init sequences → src/server/bootstrap.js  |  Shutdown → src/server/shutdown.js
// HTTP → src/http/  |  Agent sockets → src/realtime/  (layout: CLAUDE.md → Layout; how it fits: docs/architecture.md)

// Logging first: the log files open and console.* (libraries) is bridged
// into the logger before any other import can write a line.
import "./src/infra/logging/serverLogging.js";
import { logger, flushLogs, onLogDrops } from "./src/infra/logging/logger.js";
import { COMPONENTS } from "./src/infra/logging/policy.js";

import { config } from "./config/envConfig.js";
import { createWebSocketServer } from "./src/realtime/server.js";
import { callMedia } from "./src/core/media/CallMedia.js";
import { workerStatsService } from "./src/infra/monitoring/WorkerStatsService.js";
import { initRedis, initOptionalServices, startCoreServices } from "./src/server/bootstrap.js";
import { shutdown } from "./src/server/shutdown.js";
import registerRoutes from "./src/http/routes/index.js";
import { registerChannels } from "./src/channels/index.js";
import { randomUUID } from "crypto";
import Fastify, { LogController } from "fastify";
import fastifyCors from "@fastify/cors";
import { registerAccessLog } from "./src/http/accessLog.js";
import { metrics, registerRuntimeGauges } from "./src/infra/monitoring/metrics.js";

const log = logger('server');

const fastify = Fastify({
    bodyLimit: 10 * 1024 * 1024,
    loggerInstance: logger(COMPONENTS.http),
    // http/accessLog.js writes one line per request instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID().slice(0, 12),
});
registerAccessLog(fastify);
let server = null;
let io = null;

async function startServer() {
    try {
        log.info('Starting');

        await fastify.register(fastifyCors, { origin: config.node.corsAllowedOrigins });

        await initRedis();
        await initOptionalServices();

        registerChannels();
        await fastify.register(registerRoutes);

        await fastify.ready();
        server = fastify.server;

        io = createWebSocketServer(server);
        registerRuntimeGauges({
            activeMediaCalls: () => callMedia.activeCallIds().length,
            agentSockets: () => io.engine.clientsCount,
            diagnostics: () => workerStatsService.diagnostics(),
        });
        onLogDrops(({ buffer, cap }) => {
            if (buffer) metrics.logDropped.inc({ reason: 'buffer' }, buffer);
            if (cap) metrics.logDropped.inc({ reason: 'cap' }, cap);
        });

        // Reject new Socket.IO connections when this worker is at capacity.
        // The client's built-in reconnect + the load balancer route the retry to
        // a less-loaded worker.
        const MAX_CALLS_PER_WORKER = config.call.workers.maxCallsPerWorker;
        io.use((socket, next) => {
            const held = callMedia.activeCallIds().length;
            if (held >= MAX_CALLS_PER_WORKER) {
                log.warn(`Worker at capacity (${held}/${MAX_CALLS_PER_WORKER}) — rejecting connection`);
                return next(new Error('SERVER_AT_CAPACITY'));
            }
            next();
        });

        await startCoreServices();

        process.on("SIGINT",  () => shutdown(server, io));
        process.on("SIGTERM", () => shutdown(server, io));
        workerStatsService.start();

        await fastify.listen({ port: config.node.port, host: config.node.host });
        log.info(`Server running on ${config.node.host}:${config.node.port}`);
        log.info(`Agent gateway: ws://${config.node.host}:${config.node.port}/socket.io`);
        log.info(`Management API: http://${config.node.host}:${config.node.port}/v1`);
    } catch (error) {
        log.error({ err: error }, 'Server startup failed');
        process.exit(1);
    }
}

process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, 'Unhandled rejection');
    workerStatsService.logSnapshot('unhandled_rejection');
});

process.on("uncaughtException", (err) => {
    log.fatal({ err }, 'Uncaught exception');
    workerStatsService.logSnapshot('uncaught_exception');
    flushLogs();
    process.exit(1);
});

startServer();
