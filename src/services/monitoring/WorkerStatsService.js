// src/services/monitoring/WorkerStatsService.js
//
// Writes per-worker resource metrics to a dedicated daily log file:
//   logs/stats/worker-{id}-{YYYY-MM-DD}.log
//
// Each line is a human-readable summary followed by the raw JSON on the same
// line, separated by "  ||  ", so you can read it with the naked eye and also
// grep / jq it programmatically.
//
// Files rotate at midnight automatically (new file = new date).
// Files older than RETENTION_DAYS are deleted on startup.

import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import { monitorEventLoopDelay } from 'perf_hooks';
import { peerRegistry } from '../call/signaling/webrtc/PeerRegistry.js';
import { recordingManager } from '../call/audio/recording/RecordingManager.js';
import { leakMetrics } from './leakMetrics.js';
import { callStateCensus } from './callStateCensus.js';
import { config } from '../../../config/envConfig.js';
import EventBus from '../core/EventBus.js';

const INTERVAL_MS = 30_000;  // write a line every 30 s
const RETENTION_DAYS = 7;       // keep the last 7 days of stat files

// Resolve log directory relative to the project root (two levels above src/)
const LOG_DIR = path.resolve(
    new URL('../../../logs/stats', import.meta.url).pathname
        .replace(/^\/([A-Z]:)/, '$1')   // fix Windows paths like /C:/...
);

class WorkerStatsService {
    constructor() {
        this._timer = null;
        this._lastCpuUsage = process.cpuUsage();
        this._lastCpuAt = Date.now();
        this._workerId = config.runtime?.workerId ?? process.env.WORKER_ID ?? 'unknown';

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

        // File-writer state
        this._stream = null;   // current write stream
        this._streamDay = null;   // YYYY-MM-DD the stream was opened for
    }

    // ── Public API ────────────────────────────────────────────────────────────

    start() {
        if (this._timer) return;

        this._ensureLogDir();
        this._pruneOldFiles();
        this._openStream();

        this._timer = setInterval(() => this._write('periodic'), INTERVAL_MS);
        if (this._timer.unref) this._timer.unref();

        console.log(
            `[WorkerStats] Writing to ${LOG_DIR}/worker-${this._workerId}-*.log ` +
            `(every ${INTERVAL_MS / 1000}s, kept ${RETENTION_DAYS} days)`
        );
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._loopMonitor.disable();
        this._closeStream();
    }

    /**
     * Returns a plain-object snapshot — used by the /health endpoint.
     */
    snapshot() {
        const mem = process.memoryUsage();
        const cpu = this._cpuPercent();
        const calls = this._activeCalls();
        const recordings = this._activeRecordings();

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
            activeRecordings: {
                count: recordings.length,
                callIds: recordings,
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
            // ── Event loop delay (main thread only, last 30 s window) ───────────
            // Measures how long the main thread event loop was blocked between
            // iterations.  The histogram is reset after every snapshot so each
            // line represents the worst blocking in that 30 s period, not lifetime.
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
     * Write a snapshot with the given reason tag.
     * Safe to call from crash handlers before process.exit().
     */
    logSnapshot(reason = 'periodic') {
        this._write(reason);
    }

    // ── File management ───────────────────────────────────────────────────────

    _ensureLogDir() {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    _today() {
        return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }

    _filePath(day) {
        return path.join(LOG_DIR, `worker-${this._workerId}-${day}.log`);
    }

    _openStream() {
        const day = this._today();
        if (this._streamDay === day && this._stream) return; // already correct

        this._closeStream();
        this._streamDay = day;
        this._stream = fs.createWriteStream(this._filePath(day), { flags: 'a' });
        this._stream.on('error', (err) =>
            console.error(`[WorkerStats] Log write error:`, err.message)
        );
    }

    _closeStream() {
        if (this._stream) {
            try { this._stream.end(); } catch { /* best effort */ }
            this._stream = null;
            this._streamDay = null;
        }
    }

    _pruneOldFiles() {
        try {
            const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
            const prefix = `worker-${this._workerId}-`;
            for (const name of fs.readdirSync(LOG_DIR)) {
                if (!name.startsWith(prefix) || !name.endsWith('.log')) continue;
                const full = path.join(LOG_DIR, name);
                if (fs.statSync(full).mtimeMs < cutoff) {
                    fs.unlinkSync(full);
                    console.log(`[WorkerStats] Pruned old stats file: ${name}`);
                }
            }
        } catch { /* non-fatal */ }
    }

    // ── Core write ────────────────────────────────────────────────────────────

    _write(reason) {
        try {
            // Rotate file if the date rolled over
            this._openStream();

            const s = this.snapshot();
            // Reset the histogram so the NEXT snapshot shows only the next 30 s window,
            // not the lifetime maximum.  Called after snapshot() so the current line
            // captures the worst lag in the period just measured.
            this._loopMonitor.reset();

            const ts = new Date().toISOString();
            const time = ts.slice(11, 19); // HH:MM:SS

            // ── Human-readable line ───────────────────────────────────────────
            const callList = s.activeCalls.callIds.join(', ') || 'none';
            const recList = s.activeRecordings.callIds.join(', ') || 'none';
            const el = s.eventLoopDelay;
            const readable =
                `[${ts.slice(0, 10)} ${time}]` +
                `  ${this._padReason(reason)}` +
                `  CPU ${String(s.cpu.totalPercent).padStart(5)}%` +
                `  EL p50 ${String(el.p50).padStart(4)}ms  p99 ${String(el.p99).padStart(4)}ms  max ${String(el.max).padStart(4)}ms` +
                `  Heap ${String(s.memory.heapUsedMB).padStart(6)}/${s.memory.heapTotalMB} MB` +
                `  RSS ${String(s.memory.rssMB).padStart(6)} MB` +
                `  Ext ${String(s.memory.externalMB).padStart(5)} MB` +
                `  AB ${String(s.memory.arrayBuffersMB).padStart(5)} MB` +
                `  Timers ${String(s.handles.timers).padStart(4)}` +
                `  Threads ${String(s.process.threads ?? '?').padStart(4)}` +
                `  DetCtx ${String(s.process.v8.detachedCtx).padStart(3)}` +
                `  EvtLis ${String(s.process.eventBusListeners).padStart(4)}` +
                `  PHlive ${String(s.leaks.placeholderLive).padStart(4)}` +
                `  PHtrk ${String(s.retained.breakdown.placeholderTracks).padStart(3)}` +
                `  SrcLive ${String(s.leaks.audioSourceLive).padStart(4)}` +
                `  SnkLive ${String(s.leaks.audioSinkLive).padStart(4)}` +
                `  Retained ${String(s.retained.total).padStart(3)}` +
                `  Calls(${s.activeCalls.count}): [${callList}]` +
                `  Rec(${s.activeRecordings.count}): [${recList}]`;

            // ── Raw JSON for grep/jq ──────────────────────────────────────────
            const json = JSON.stringify({ reason, ...s, ts });

            const line = `${readable}  ||  ${json}\n`;

            if (this._stream) {
                this._stream.write(line);
            } else {
                // Fallback: write to stdout if file is unavailable
                process.stdout.write(line);
            }
        } catch (err) {
            console.error('[WorkerStats] Write failed:', err.message);
        }
    }

    _padReason(reason) {
        const labels = {
            periodic: 'PERIODIC  ',
            graceful_shutdown: 'SHUTDOWN  ',
            uncaught_exception: 'CRASH !!!  ',
            unhandled_rejection: 'REJECTION  ',
        };
        return labels[reason] ?? reason.toUpperCase().padEnd(10);
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
        try { return [...peerRegistry.peerConnections.keys()]; }
        catch { return []; }
    }

    _activeRecordings() {
        try { return [...recordingManager.activeSessions.keys()]; }
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
