// Health check handlers — two endpoints, two audiences:
//   handleWorkerHealth  GET /health      — lightweight infra probe for PM2, nginx,
//                                          and load-balancer health checks. Sync, fast.
//   handleHealth        GET /api/health  — detailed per-worker diagnostics for dashboards
//                                          and on-call engineers. Async (event-loop lag).
import { redisClient } from '../../infra/redis/RedisClient.js';
import { workerStatsService } from '../../infra/monitoring/WorkerStatsService.js';
import { callMedia } from '../../core/media/CallMedia.js';
import { bootId } from '../../infra/cluster/WorkerBoot.js';
import { config } from '../../../config/envConfig.js';

function toMB(bytes) {
    return Math.round(bytes / 1024 / 1024) + ' MB';
}

function measureEventLoopLag() {
    return new Promise((resolve) => {
        const start = Date.now();
        setImmediate(() => resolve(Date.now() - start));
    });
}

// Lightweight infra health check — used by PM2, nginx, and load-balancer probes.
// `media.connected` says whether this worker reaches the media server; the
// worker stays up (the API and sockets work) while it reconnects.
export function handleWorkerHealth(_request, reply) {
    const workerStats = workerStatsService.snapshot();
    const media = callMedia.stats();
    const ok = workerStats.ok !== false;
    reply.code(ok ? 200 : 503).send({
        ok,
        // This process's boot id — the value in the leases of the calls it runs.
        boot: bootId,
        activeCalls: media.rooms,
        ...workerStats,
        media,
    });
}

// Detailed per-worker diagnostic endpoint — memory, event loop lag, connections.
export async function handleHealth(request, reply) {
    const mem = process.memoryUsage();
    const lag = await measureEventLoopLag();

    const media = callMedia.stats();
    const activeCalls = media.rooms;
    const status = lag > 500 ? 'degraded' : 'ok';

    reply.code(status === 'ok' ? 200 : 503).send({
        status,
        worker:           config.runtime.pmId ?? config.runtime.workerId,
        pid:              process.pid,
        uptime:           Math.floor(process.uptime()) + 's',
        activeCalls,
        media,
        memory: {
            rss:       toMB(mem.rss),
            heapUsed:  toMB(mem.heapUsed),
            heapTotal: toMB(mem.heapTotal),
        },
        eventLoopLag: lag + 'ms',
        redis: redisClient.isConnected ? 'connected' : 'disconnected',
    });
}
