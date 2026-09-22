// services/call/audio/dtmf/DTMFWorkerBridge.js
//
// Main-thread client for DTMFWorker thread.
// One shared worker per PM2 process serves all concurrent IVR/DTMF sessions.
//
// Resilience: up to MAX_RESTART_ATTEMPTS restarts with exponential backoff,
// matching the pattern used by EncodingWorkerBridge.  On crash, active session
// callbacks are silently cleared — in-progress IVR calls degrade to no digit
// detection until the next call, which is better than crashing the worker.
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKER_INIT_TIMEOUT_MS = 10_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BASE_DELAY_MS = 500; // doubles each attempt: 500ms → 1s → 2s

class DTMFWorkerBridge {
    constructor() {
        this._worker = null;
        this._ready = false;
        this._terminating = false;
        this._restartAttempts = 0;

        // callId -> (digit: string) => void
        this._callbacks = new Map();
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Spawn the worker thread and wait for its 'ready' handshake.
     * Must be called once at process startup before any IVR session begins.
     */
    async init() {
        this._restartAttempts = 0;
        await this._spawn();
    }

    /**
     * Terminate the worker thread.
     * Call during graceful shutdown after all active IVR sessions have been
     * stopped — dtmfWorkerBridge.terminate() should come after ivrCoordinator
     * teardown in the shutdown sequence.
     */
    async terminate() {
        this._terminating = true;
        this._ready = false;
        this._callbacks.clear();

        if (this._worker) {
            await this._worker.terminate();
            this._worker = null;
        }
    }

    // ── Session API (called by DTMFCaptureService) ────────────────────────────

    /**
     * Register a session and initialize a DTMFDetector in the worker.
     *
     * @param {string}   callId
     * @param {Function} onDigit  Called with (digit: string) when a digit is confirmed
     * @returns {boolean}  false if the worker is not ready
     */
    startSession(callId, onDigit) {
        if (!this._ready) {
            console.warn(`[DTMFWorkerBridge] startSession: worker not ready — DTMF detection disabled for call ${callId}`);
            return false;
        }
        this._callbacks.set(callId, onDigit);
        this._worker.postMessage({ type: 'start', callId });
        return true;
    }

    /**
     * Forward one PCM frame to the worker for digit detection.
     * `buffer` must be a freshly-copied ArrayBuffer — wrtc reclaims the original
     * samples.buffer after the sink.ondata callback returns, so it cannot be
     * transferred directly.
     *
     * @param {string}      callId
     * @param {ArrayBuffer} buffer     Int16 mono PCM (copied from wrtc)
     * @param {number}      sampleRate
     */
    sendFrame(callId, buffer, sampleRate) {
        if (!this._ready || !this._callbacks.has(callId)) return;
        this._worker.postMessage({ type: 'frame', callId, buffer, sampleRate }, [buffer]);
    }

    /**
     * Reset detector state between IVR menu node entries.
     * Always clears buffered samples and pending-digit state so a partial
     * confirm from the previous node cannot fire as a false positive on the
     * new one. Pass `full: true` only when frame delivery was paused since
     * the last reset (see DTMFDetector.reset() for why that distinction
     * matters) to also clear the active-digit/cooldown state.
     */
    resetSession(callId, { full = false } = {}) {
        if (!this._ready || !this._callbacks.has(callId)) return;
        this._worker.postMessage({ type: 'reset', callId, full });
    }

    /**
     * Remove the session and free detector state in the worker.
     * Called from DTMFCaptureService.stopCapture() at IVR transfer time,
     * and from DTMFCaptureService.destroy() at final call teardown.
     */
    stopSession(callId) {
        if (!this._callbacks.has(callId)) return;
        this._callbacks.delete(callId);
        if (this._worker && this._ready) {
            this._worker.postMessage({ type: 'stop', callId });
        }
    }

    isReady() {
        return this._ready;
    }

    /**
     * Snapshot for the /health endpoint.
     */
    getStats() {
        return {
            ready: this._ready,
            activeSessions: this._callbacks.size,
            restartAttempts: this._restartAttempts,
        };
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    async _spawn() {
        await new Promise((resolve, reject) => {
            const worker = new Worker(
                join(__dirname, 'DTMFWorker.js'),
                { type: 'module' }
            );

            const initTimer = setTimeout(() => {
                worker.terminate();
                reject(new Error('DTMF worker init timed out (10 s)'));
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
                    return reject(new Error(`Unexpected first worker message: ${msg.type}`));
                }

                this._worker = worker;
                this._ready = true;

                worker.on('message', (m) => this._onMessage(m));
                worker.on('error', (err) => { if (!this._terminating) this._onWorkerDown(`Worker error: ${err.message}`); });
                worker.on('exit', (code) => { if (code !== 0 && !this._terminating) this._onWorkerDown(`Worker exited with code ${code}`); });

                console.log(`[DTMFWorkerBridge] Worker ready (threadId=${worker.threadId})`);
                resolve();
            });
        });
    }

    _onWorkerDown(reason) {
        if (!this._ready) return;

        console.error(`[DTMFWorkerBridge] Worker down — ${reason}`);
        this._ready = false;
        this._worker = null;
        this._callbacks.clear();

        if (this._terminating || this._restartAttempts >= MAX_RESTART_ATTEMPTS) {
            if (!this._terminating) {
                console.error('[DTMFWorkerBridge] Max restart attempts reached — DTMF detection disabled until process restart');
            }
            return;
        }

        this._restartAttempts++;
        const delay = RESTART_BASE_DELAY_MS * (2 ** (this._restartAttempts - 1));
        console.warn(`[DTMFWorkerBridge] Restarting worker (attempt ${this._restartAttempts}/${MAX_RESTART_ATTEMPTS}) in ${delay} ms...`);

        setTimeout(() => {
            this._spawn()
                .then(() => {
                    this._restartAttempts = 0;
                    console.log('[DTMFWorkerBridge] Worker restarted successfully');
                })
                .catch((err) => {
                    console.error('[DTMFWorkerBridge] Worker restart failed:', err.message);
                    this._onWorkerDown(`Restart failed: ${err.message}`);
                });
        }, delay);
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'digit': {
                const onDigit = this._callbacks.get(msg.callId);
                if (onDigit) {
                    try { onDigit(msg.digit); } catch { /* never let callback throw */ }
                }
                break;
            }
            case 'error': {
                console.error(`[DTMFWorkerBridge] Session error — call ${msg.callId}:`, msg.message);
                break;
            }
        }
    }
}

export const dtmfWorkerBridge = new DTMFWorkerBridge();
