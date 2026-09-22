// Health check handlers — two endpoints, two audiences:
//   handleWorkerHealth  GET /health      — lightweight infra probe for PM2, nginx,
//                                          and load-balancer health checks. Sync, fast.
//   handleHealth        GET /api/health  — detailed per-worker diagnostics for dashboards
//                                          and on-call engineers. Async (event-loop lag).
import { redisClient } from '../services/redis/RedisClient.js';
import { peerRegistry } from '../services/call/signaling/webrtc/PeerRegistry.js';
import { recordingManager } from '../services/call/audio/recording/RecordingManager.js';
import { workerStatsService } from '../services/monitoring/WorkerStatsService.js';
import { encodingWorkerBridge } from '../services/call/audio/recording/encoding/EncodingWorkerBridge.js';
import { dtmfWorkerBridge } from '../services/call/audio/dtmf/DTMFWorkerBridge.js';

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
// Returns 200 when encoding workers are ready, 503 otherwise.
export function handleWorkerHealth(_req, res) {
    const workerStats = workerStatsService.snapshot();
    const encodingStats = encodingWorkerBridge.getStats();
    const dtmfStats = dtmfWorkerBridge.getStats();
    const activeCalls = peerRegistry.peerConnections.size;
    const ok = encodingStats.ready && workerStats.ok !== false;
    res.status(ok ? 200 : 503).json({
        ok,
        activeCalls,
        ...workerStats,
        encodingWorker: encodingStats,
        dtmfWorker: dtmfStats,
    });
}

// Detailed per-worker diagnostic endpoint — memory, event loop lag, connections.
export async function handleHealth(req, res) {
    const mem = process.memoryUsage();
    const lag = await measureEventLoopLag();

    const activeCalls = peerRegistry.peerConnections.size;
    const activeRecordings = recordingManager.activeSessions.size;
    const status = lag > 500 ? 'degraded' : 'ok';

    res.status(status === 'ok' ? 200 : 503).json({
        status,
        worker:           process.env.pm_id ?? 0,
        pid:              process.pid,
        uptime:           Math.floor(process.uptime()) + 's',
        activeCalls,
        activeRecordings,
        memory: {
            rss:       toMB(mem.rss),
            heapUsed:  toMB(mem.heapUsed),
            heapTotal: toMB(mem.heapTotal),
        },
        eventLoopLag: lag + 'ms',
        redis: redisClient.isConnected ? 'connected' : 'disconnected',
    });
}
