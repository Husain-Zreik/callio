// src/services/call/audio/recording/encoding/EncodingWorkerBridge.js
//
// Main-thread client for a pool of EncodingWorker threads.
// ENCODING_WORKER_COUNT workers per PM2 process (default 2) share the
// recording load via round-robin session assignment.  Each worker is
// independently resilient — if one crashes only its sessions are affected
// and it restarts with exponential backoff while the others continue.
//
// Resilience guarantees (per worker):
//   • Worker init times out after WORKER_INIT_TIMEOUT_MS (10 s).
//   • Each stop() ACK times out after STOP_ACK_TIMEOUT_MS (30 s).
//   • Unexpected exits are restarted up to MAX_RESTART_ATTEMPTS times.
//   • The _terminating flag suppresses restart attempts during shutdown.
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from '../../../../../../config/envConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKER_COUNT = config.call.workers.encodingWorkerCount;
const WORKER_INIT_TIMEOUT_MS = 10_000;
const STOP_ACK_TIMEOUT_MS = 30_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BASE_DELAY_MS = 500; // doubles each attempt: 500ms → 1s → 2s

class EncodingWorkerBridge {
    constructor() {
        // Array of { worker: Worker|null, ready: boolean, restartAttempts: number }
        this._workers = [];
        this._workerCount = WORKER_COUNT;
        this._nextWorkerIdx = 0;   // round-robin counter
        this._terminating = false;
        this.opusAvailable = false;

        // callId -> { onChunk: (Buffer) => void, onError: (string) => void, workerIdx: number }
        this._sessions = new Map();

        // callId -> { resolve: () => void, reject: (Error) => void, _timeout: Timeout }
        this._pendingStops = new Map();
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Spawn all worker threads and wait for their 'ready' handshakes.
     * Must be called once at process startup before any recording begins.
     * Throws only if every worker fails to initialise.
     */
    async init() {
        const results = await Promise.allSettled(
            Array.from({ length: this._workerCount }, (_, i) => this._spawn(i))
        );

        const readyCount = this._workers.filter(ws => ws?.ready).length;

        if (readyCount === 0) {
            const reasons = results.map((r, i) =>
                r.status === 'rejected' ? `worker[${i}]: ${r.reason?.message}` : null
            ).filter(Boolean).join('; ');
            throw new Error(`All ${this._workerCount} encoding workers failed to initialize. ${reasons}`);
        }

        if (readyCount < this._workerCount) {
            console.warn(`[EncodingWorkerBridge] ${readyCount}/${this._workerCount} workers ready — recording will continue at reduced capacity`);
        }
    }

    /**
     * Terminate all worker threads.
     * Call during graceful shutdown AFTER all recording sessions have been stopped.
     */
    async terminate() {
        this._terminating = true;
        for (const ws of this._workers) if (ws) ws.ready = false;

        for (const { reject: rej, _timeout } of this._pendingStops.values()) {
            clearTimeout(_timeout);
            rej(new Error('Bridge terminated'));
        }
        this._pendingStops.clear();
        this._sessions.clear();

        await Promise.allSettled(
            this._workers.map(ws => ws?.worker?.terminate())
        );
        this._workers = [];
    }

    // ── Session API (called by RecordingSession) ──────────────────────────────

    /**
     * Register a new recording session and start its encoder/muxer in the
     * next available worker (round-robin).
     *
     * @param {string}            callId
     * @param {(Buffer) => void}  onChunk  Called for every OGG page produced
     * @param {(string) => void}  onError  Called if the worker crashes mid-session
     * @returns {boolean}  false if no workers are ready
     */
    startSession(callId, onChunk, onError) {
        const workerIdx = this._pickWorker();
        if (workerIdx === -1) {
            console.warn(`[EncodingWorkerBridge] startSession: no ready workers — call ${callId} cannot be recorded`);
            return false;
        }
        this._sessions.set(callId, { onChunk, onError, workerIdx });
        this._workers[workerIdx].worker.postMessage({ type: 'start', callId });
        console.log(`[EncodingWorkerBridge] Session started: ${callId} → worker[${workerIdx}] (active=${this._sessions.size})`);
        return true;
    }

    /**
     * Transfer one stereo PCM frame to the assigned worker for encoding.
     * The ArrayBuffer is transferred (zero-copy) — do not use it after this call.
     *
     * @param {string}              callId
     * @param {'agent'|'customer'}  channel
     * @param {ArrayBuffer}         arrayBuffer  Mono 16-bit PCM
     */
    sendFrame(callId, channel, arrayBuffer) {
        const session = this._sessions.get(callId);
        if (!session) return;
        const ws = this._workers[session.workerIdx];
        if (!ws?.ready) return;
        ws.worker.postMessage({ type: 'audio', callId, channel, buffer: arrayBuffer }, [arrayBuffer]);
    }

    /**
     * Reset the mix buffer and encoder for a call (called on agent track replacement).
     */
    resetEncoder(callId) {
        const session = this._sessions.get(callId);
        if (!session) return;
        const ws = this._workers[session.workerIdx];
        if (!ws?.ready) return;
        ws.worker.postMessage({ type: 'reset', callId });
    }

    /**
     * Mark a channel active or inactive in the worker's mix buffer.
     * When inactive the mix buffer fills that channel with silence so the
     * active channel is not blocked waiting for the paused side.
     *
     * @param {string}              callId
     * @param {'agent'|'customer'}  channel
     * @param {boolean}             active
     */
    setTrackActive(callId, channel, active) {
        const session = this._sessions.get(callId);
        if (!session) return;
        const ws = this._workers[session.workerIdx];
        if (!ws?.ready) return;
        ws.worker.postMessage({ type: 'track_active', callId, channel, active });
    }

    /**
     * Flush, finalize the OGG stream, and wait until all OGG pages have been
     * delivered to the main thread.
     *
     * @param   {string}        callId
     * @returns {Promise<void>}
     */
    stop(callId) {
        const session = this._sessions.get(callId);
        if (!session) return Promise.resolve();
        const ws = this._workers[session.workerIdx];
        if (!ws?.ready) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const _timeout = setTimeout(() => {
                this._pendingStops.delete(callId);
                reject(new Error(`Stop ACK timed out for call ${callId} (${STOP_ACK_TIMEOUT_MS / 1000} s)`));
            }, STOP_ACK_TIMEOUT_MS);

            this._pendingStops.set(callId, { resolve, reject, _timeout });
            ws.worker.postMessage({ type: 'stop', callId });
        });
    }

    /**
     * Discard a session without waiting for the final chunks (abort path).
     */
    discardSession(callId) {
        const session = this._sessions.get(callId);
        if (!session) return;
        const ws = this._workers[session.workerIdx];
        this._sessions.delete(callId);
        if (ws?.worker && ws.ready) {
            ws.worker.postMessage({ type: 'stop', callId });
        }
        console.log(`[EncodingWorkerBridge] Session discarded: ${callId} (active=${this._sessions.size})`);
    }

    /**
     * Snapshot for the /health endpoint.
     */
    getStats() {
        const workerStats = this._workers.map((ws, i) => ({
            index: i,
            ready: ws?.ready ?? false,
            restartAttempts: ws?.restartAttempts ?? 0,
        }));
        const readyCount = workerStats.filter(w => w.ready).length;
        return {
            ready: readyCount > 0,
            workerCount: this._workerCount,
            readyWorkers: readyCount,
            opusAvailable: this.opusAvailable,
            activeSessions: this._sessions.size,
            pendingStops: this._pendingStops.size,
            workers: workerStats,
        };
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * Round-robin over all worker slots, skipping those that are not ready.
     * Cycles through all slots (not just ready ones) so load is evenly
     * distributed when a crashed worker recovers.
     *
     * @returns {number} worker index, or -1 if no workers are ready
     */
    _pickWorker() {
        for (let attempt = 0; attempt < this._workerCount; attempt++) {
            const idx = this._nextWorkerIdx % this._workerCount;
            this._nextWorkerIdx++;
            // Prevent integer overflow after long uptime
            if (this._nextWorkerIdx >= 1e9) this._nextWorkerIdx = 0;
            if (this._workers[idx]?.ready) return idx;
        }
        return -1;
    }

    async _spawn(idx) {
        if (!this._workers[idx]) {
            this._workers[idx] = { worker: null, ready: false, restartAttempts: 0 };
        }
        const ws = this._workers[idx];

        await new Promise((resolve, reject) => {
            const worker = new Worker(
                join(__dirname, 'EncodingWorker.js'),
                { type: 'module' }
            );

            const initTimer = setTimeout(() => {
                worker.terminate();
                reject(new Error(`Encoding worker[${idx}] init timed out (10 s)`));
            }, WORKER_INIT_TIMEOUT_MS);

            const onInitError = (err) => {
                clearTimeout(initTimer);
                worker.terminate();
                reject(err);
            };
            worker.once('error', onInitError);

            worker.once('message', (msg) => {
                clearTimeout(initTimer);
                worker.off('error', onInitError);

                if (msg.type !== 'ready') {
                    worker.terminate();
                    return reject(new Error(`Unexpected first message from worker[${idx}]: ${msg.type}`));
                }

                ws.worker = worker;
                ws.ready = true;
                ws.restartAttempts = 0;
                if (!this.opusAvailable && msg.opusAvailable) this.opusAvailable = true;

                worker.on('message', (m) => this._onMessage(m, idx));
                worker.on('error', (err) => { if (!this._terminating) this._onWorkerDown(idx, `Worker error: ${err.message}`); });
                worker.on('exit', (code) => { if (code !== 0 && !this._terminating) this._onWorkerDown(idx, `Worker exited with code ${code}`); });

                console.log(`[EncodingWorkerBridge] Worker[${idx}] ready (threadId=${worker.threadId}, opusAvailable=${msg.opusAvailable})`);
                resolve();
            });
        });
    }

    _onWorkerDown(idx, reason) {
        const ws = this._workers[idx];
        if (!ws?.ready) return; // already handling a previous down event

        console.error(`[EncodingWorkerBridge] Worker[${idx}] down — ${reason}`);
        ws.ready = false;
        ws.worker = null;

        // Notify all sessions that were on this worker
        for (const [callId, session] of this._sessions.entries()) {
            if (session.workerIdx !== idx) continue;
            try { session.onError?.(reason); } catch { /* never let error handler throw */ }
        }

        // Reject pending stops for sessions on this worker
        for (const [callId, pending] of this._pendingStops.entries()) {
            if (this._sessions.get(callId)?.workerIdx !== idx) continue;
            clearTimeout(pending._timeout);
            pending.reject(new Error(reason));
            this._pendingStops.delete(callId);
        }

        // Remove dead sessions
        for (const [callId, session] of this._sessions.entries()) {
            if (session.workerIdx === idx) this._sessions.delete(callId);
        }

        if (this._workers.every(w => !w?.ready)) {
            this.opusAvailable = false;
        }

        if (this._terminating || ws.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            if (!this._terminating) {
                console.error(`[EncodingWorkerBridge] Worker[${idx}] max restart attempts reached — recording on this slot disabled until process restart`);
            }
            return;
        }

        ws.restartAttempts++;
        const delay = RESTART_BASE_DELAY_MS * (2 ** (ws.restartAttempts - 1));
        console.warn(`[EncodingWorkerBridge] Restarting worker[${idx}] (attempt ${ws.restartAttempts}/${MAX_RESTART_ATTEMPTS}) in ${delay} ms...`);

        setTimeout(() => {
            this._spawn(idx)
                .then(() => console.log(`[EncodingWorkerBridge] Worker[${idx}] restarted successfully`))
                .catch((err) => {
                    console.error(`[EncodingWorkerBridge] Worker[${idx}] restart failed:`, err.message);
                    this._onWorkerDown(idx, `Restart failed: ${err.message}`);
                });
        }, delay);
    }

    _onMessage(msg, workerIdx) {
        switch (msg.type) {

            case 'ready': {
                // Should never arrive after init — indicates a worker-side bug.
                console.error(`[EncodingWorkerBridge] Unexpected second "ready" from worker[${workerIdx}] — ignoring`);
                break;
            }

            case 'chunk': {
                const session = this._sessions.get(msg.callId);
                if (session) session.onChunk(Buffer.from(msg.buffer));
                break;
            }

            case 'stopped': {
                const pending = this._pendingStops.get(msg.callId);
                if (pending) {
                    clearTimeout(pending._timeout);
                    this._pendingStops.delete(msg.callId);
                    pending.resolve();
                }
                this._sessions.delete(msg.callId);
                console.log(`[EncodingWorkerBridge] Session stopped: ${msg.callId} (active=${this._sessions.size})`);
                break;
            }

            case 'error': {
                console.error(`[EncodingWorkerBridge] Session error — call ${msg.callId}:`, msg.message);
                const session = this._sessions.get(msg.callId);
                session?.onError?.(msg.message);
                this._sessions.delete(msg.callId);

                const pending = this._pendingStops.get(msg.callId);
                if (pending) {
                    clearTimeout(pending._timeout);
                    this._pendingStops.delete(msg.callId);
                    pending.reject(new Error(msg.message));
                }
                break;
            }
        }
    }
}

export const encodingWorkerBridge = new EncodingWorkerBridge();
