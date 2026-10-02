// src/infra/monitoring/WorkerStatsService.js
//
// Worker resource and leak diagnostics, in one snapshot():
//   - /health (healthController) returns it;
//   - every SNAPSHOT_INTERVAL_MS it is logged as one record (component
//     infra.monitoring.WorkerStatsService, "Worker snapshot"), and on shutdown
//     and crashes too (logSnapshot) — same files, npm run logs and Loki as the
//     rest of the logs;
//   - its leak counters are Prometheus gauges (metrics.js, collected at scrape).
//
// Read the snapshot's comments below for what healthy values look like.
import fs from 'fs';
import v8 from 'v8';
import { monitorEventLoopDelay } from 'perf_hooks';
import { callMedia } from '../../core/media/CallMedia.js';
import { leakMetrics } from './leakMetrics.js';
import { callStateCensus } from './callStateCensus.js';
import { config } from '../../../config/envConfig.js';
import EventBus from '../../core/EventBus.js';
import { logger } from '../logging/logger.js';

const log = logger('infra.monitoring.WorkerStatsService');

const SNAPSHOT_INTERVAL_MS = 5 * 60_000;   // one snapshot record every 5 minutes
// Snapshots taken because something went wrong are logged as errors.
const FAILURE_REASONS = new Set(['uncaught_exception', 'unhandled_rejection']);

class WorkerStatsService {
    constructor() {
        this._timer = null;
        this._lastCpuUsage = process.cpuUsage();
        this._lastCpuAt = Date.now();
        this._workerId = config.runtime?.workerId ?? 'unknown';

        // Event loop delay monitor — 10 ms resolution histogram.
        // Measures how long the event loop is blocked between iterations.
        // p50/p95/p99 in the stats log are the direct signal for main-thread saturation:
        //   < 5 ms  → healthy (normal libuv/V8 overhead)
        //   5–20 ms → mild pressure
        //   > 20 ms → main thread is overloaded (CPU-bound work blocking the loop)
        // After the encoding worker extraction, these values should stay near baseline
        // even under concurrent recordings, confirming Opus encoding no longer blocks
        // the event loop.
        this._loopMonitor = monitorEventLoopDelay({ resolution: 10 });
        this._loopMonitor.enable();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this.logSnapshot('periodic'), SNAPSHOT_INTERVAL_MS);
        this._timer.unref?.();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._loopMonitor.disable();
    }

    /**
     * Returns a plain-object snapshot — used by the /health endpoint.
     */
    snapshot() {
        const mem = process.memoryUsage();
        const cpu = this._cpuPercent();
        const calls = this._activeCalls();

        const heapStats = v8.getHeapStatistics();

        return {
            workerId: this._workerId,
            pid: process.pid,
            uptimeSeconds: Math.floor(process.uptime()),
            cpu: {
                userPercent: cpu.user,
                systemPercent: cpu.system,
                totalPercent: Math.round((cpu.user + cpu.system) * 10) / 10,
            },
            memory: {
                heapUsedMB: this._mb(mem.heapUsed),
                heapTotalMB: this._mb(mem.heapTotal),
                rssMB: this._mb(mem.rss),
                externalMB: this._mb(mem.external),
                // arrayBuffers is the SUBSET of external that is Node Buffers/ArrayBuffers
                // (recording → Opus/OGG → S3 upload pipeline). If externalMB climbs during
                // a call but arrayBuffersMB stays flat, the growth is wrtc native (sinks /
                // peer connection), not our buffers.
                arrayBuffersMB: this._mb(mem.arrayBuffers ?? 0),
            },
            activeCalls: {
                count: calls.length,
                callIds: calls,
            },
            // ── Leak diagnostics ───────────────────────────────────────────────
            // handles.timers should sit at a small constant on an IDLE worker.
            // placeholderLive should return to ~0 after every call ends. Growth of
            // either while activeCalls.count is 0 == the placeholder leak (see report).
            handles: this._handles(),
            leaks: {
                placeholderCreated: leakMetrics.placeholderCreated,
                placeholderCleared: leakMetrics.placeholderCleared,
                placeholderLive: leakMetrics.placeholderLive,
                audioSourceCreated: leakMetrics.audioSourceCreated,
                audioSourceStopped: leakMetrics.audioSourceStopped,
                audioSourceLive: leakMetrics.audioSourceLive,
                audioSinkCreated: leakMetrics.audioSinkCreated,
                audioSinkStopped: leakMetrics.audioSinkStopped,
                audioSinkLive: leakMetrics.audioSinkLive,
            },
            // Per-call state census — every registry keyed by callId. `retained.total`
            // MUST be 0 at idle (Calls 0). Non-zero == an ended call left state behind.
            // retained.breakdown.placeholderTracks specifically MUST be 0 at idle:
            // non-zero means AudioCoordinator.cleanup() failed to call clearTrack() for
            // a call whose agent disconnected mid-call (the reconnect placeholder leak).
            retained: callStateCensus(),
            // ── Process-level diagnostics ──────────────────────────────────────
            // threads:          OS thread count (read from /proc/self/status). Grows by
            //                   ~4 per wrtc peer connection and should stabilise once wrtc
            //                   releases its audio-processing workers after pc.close().
            //                   Steady growth over days with no call activity == wrtc thread leak.
            // v8.detachedCtx:   V8 contexts that were detached but not yet GC'd. Anything
            //                   above 0 at idle means a JS closure is holding a stale context.
            // v8.nativeCtx:     Should always be 1 (the main context). Growing == context leak.
            // v8.mallocedMB:    Native C++ memory malloc'd by V8 internals (not heap, not wrtc).
            // eventBusListeners: Total listener count across all EventBus channels. Should be
            //                   constant (~28 at startup). Growth means a per-call handler was
            //                   registered without a matching off().
            process: {
                threads: this._threadCount(),
                v8: {
                    detachedCtx: heapStats.number_of_detached_contexts,
                    nativeCtx: heapStats.number_of_native_contexts,
                    mallocedMB: this._mb(heapStats.malloced_memory),
                },
                eventBusListeners: this._eventBusListeners(),
            },
            // ── Event loop delay (main thread only, since the previous snapshot) ──
            // Measures how long the main thread event loop was blocked between
            // iterations.  The histogram is reset after every snapshot so each
            // snapshot shows the worst blocking since the previous one, not lifetime.
            //
            // Healthy baseline (idle):          p50 ≈ 0–2 ms,  p99 ≈ 2–5 ms
            // Under concurrent recordings:
            //   OLD (synchronous Opus):          p50 ≈ 2–5 ms,  p99 ≈ 10–30 ms
            //   NEW (worker thread extraction):  p50 ≈ 0–2 ms,  p99 ≈ 2–8 ms
            //
            // Values > 20 ms on p99 mean the event loop is saturated and WebSocket
            // events / ICE candidates are being delayed by that amount.
            eventLoopDelay: this._eventLoopDelay(),
        };
    }

    /**
     * The leak counters alone, without side effects (snapshot() resets the CPU
     * sample) — read by Prometheus at every scrape (metrics.js).
     */
    diagnostics() {
        const heapStats = v8.getHeapStatistics();
        return {
            handles: this._handles(),
            leaks: { ...leakMetrics },
            retained: callStateCensus(),
            threads: this._threadCount(),
            detachedContexts: heapStats.number_of_detached_contexts,
            eventBusListeners: this._eventBusListeners(),
        };
    }

    /**
     * Snapshot of libuv active handles by category. Uses process.getActiveResourcesInfo()
     * (Node 17+). `timers` counts live setInterval/setTimeout — the authoritative,
     * bookkeeping-free signal for the orphaned-interval leak.
     */
    _handles() {
        try {
            if (typeof process.getActiveResourcesInfo !== 'function') {
                return { total: null, timers: null };
            }
            const res = process.getActiveResourcesInfo();
            const timers = res.filter(r => r === 'Timeout' || r === 'Immediate').length;
            return { total: res.length, timers };
        } catch {
            return { total: null, timers: null };
        }
    }

    /**
     * Log a snapshot tagged with why it was taken ('periodic', 'graceful_shutdown',
     * 'uncaught_exception', …). Synchronous — safe in crash handlers.
     */
    logSnapshot(reason = 'periodic') {
        try {
            const { workerId, pid, ...snapshot } = this.snapshot();   // every record already names the worker
            // The event-loop histogram restarts so each snapshot covers its own period.
            this._loopMonitor.reset();
            log[FAILURE_REASONS.has(reason) ? 'error' : 'info']({ reason, ...snapshot }, 'Worker snapshot');
        } catch (err) {
            log.error({ err }, 'Worker snapshot failed');
        }
    }

    // ── Metrics helpers ───────────────────────────────────────────────────────

    _threadCount() {
        try {
            const status = fs.readFileSync('/proc/self/status', 'utf8');
            const match = status.match(/^Threads:\s+(\d+)/m);
            return match ? parseInt(match[1], 10) : null;
        } catch { return null; }
    }

    _eventBusListeners() {
        try {
            return EventBus.eventNames().reduce((sum, e) => sum + EventBus.listenerCount(e), 0);
        } catch { return null; }
    }

    _cpuPercent() {
        const now = Date.now();
        const elapsed = (now - this._lastCpuAt) * 1000; // µs
        const usage = process.cpuUsage(this._lastCpuUsage);

        this._lastCpuUsage = process.cpuUsage();
        this._lastCpuAt = now;

        const user = elapsed > 0 ? Math.min(100, (usage.user / elapsed) * 100) : 0;
        const system = elapsed > 0 ? Math.min(100, (usage.system / elapsed) * 100) : 0;
        return {
            user: Math.round(user * 10) / 10,
            system: Math.round(system * 10) / 10,
        };
    }

    _activeCalls() {
        try { return callMedia.activeCallIds(); }
        catch { return []; }
    }

    _eventLoopDelay() {
        const ns2ms = (ns) => Math.round(ns / 1e6 * 10) / 10;
        return {
            p50: ns2ms(this._loopMonitor.percentile(50)),
            p95: ns2ms(this._loopMonitor.percentile(95)),
            p99: ns2ms(this._loopMonitor.percentile(99)),
            max: ns2ms(this._loopMonitor.max),
        };
    }

    _mb(bytes) {
        return Math.round(bytes / 1024 / 1024 * 10) / 10;
    }
}

export const workerStatsService = new WorkerStatsService();
