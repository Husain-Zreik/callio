// src/services/call/audio/recording/RecordingSession.js
import RecordingRepository from '../../../../repositories/RecordingRepository.js';
import { streamUploader } from '../../../storage/StreamUploader.js';
import { encodingWorkerBridge } from './encoding/EncodingWorkerBridge.js';

/**
 * Manages recording state for a single call.
 * Produces one stereo OGG/Opus file per call:
 *   Left channel  (ch0) = customer
 *   Right channel (ch1) = agent
 *
 * Encoding pipeline (OpusEncoder + OggMuxer) runs in a dedicated worker thread.
 * StereoMixBuffer stays on the main thread; each complete stereo frame is
 * transferred zero-copy to the worker via ArrayBuffer transferables.
 * OGG pages are returned to the main thread and streamed directly to S3.
 *
 * Worker crash handling:
 *   If the worker exits unexpectedly, onError() sets _workerFailed = true.
 *   The next stop() call detects this flag and aborts the S3 upload rather than
 *   finalizing a corrupt/incomplete OGG file.
 */
export class RecordingSession {
    constructor(callId, businessId) {
        this.callId = callId;
        this.businessId = businessId;
        this.recordingId = null;

        // Single stereo S3 upload stream
        this.uploadStream = null;

        // ── Worker session state ──────────────────────────────────────────────
        this._usingWorker = false; // true while an active worker session exists
        this._workerFailed = false; // true if the worker crashed during this session

        // ── Concurrency guard ────────────────────────────────────────────────
        // Prevents two concurrent stop() calls from racing on the same session.
        this._stopping = false;

        // ── Recording state ──────────────────────────────────────────────────
        this.isRecording = false;
        this.startedAt = null;
        this.endedAt = null;
        this.bytesWritten = 0;

        // Per-channel frame counters and first-write timestamps
        this._frameCounts = { agent: 0, customer: 0 };
        this._firstWriteAt = { agent: null, customer: null };

        console.log(`[RecordingSession] Created for call ${callId}`);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Initialize recording: create DB record, open S3 upload stream, start worker session.
     * @returns {Promise<boolean>} false on any initialization failure
     */
    async start() {
        if (this.isRecording) {
            console.warn(`[RecordingSession] Call ${this.callId} already recording`);
            return false;
        }

        if (!encodingWorkerBridge.opusAvailable) {
            console.warn(`[RecordingSession] Opus unavailable — recording skipped for call ${this.callId}`);
            try {
                const { id } = await RecordingRepository.create({
                    call_id: this.callId,
                    business_id: this.businessId,
                });
                await RecordingRepository.markFailed(id, 'Recording skipped: Opus encoder not available');
            } catch (persistErr) {
                console.error(`[RecordingSession] Failed to persist Opus-unavailable failure for call ${this.callId}:`, persistErr.message);
            }
            return false;
        }

        try {
            // 1. Create database record
            const { id } = await RecordingRepository.create({
                call_id: this.callId,
                business_id: this.businessId,
            });
            this.recordingId = id;

            // 2. Open S3 upload stream
            this.uploadStream = await streamUploader.createUploadStream(
                this.recordingId, this.businessId, this.callId
            );

            // 3. Start worker session.  The worker creates the encoder and muxer,
            //    writes OGG header pages, and sends them back as 'chunk' messages
            //    — all before any PCM arrives.
            const workerStarted = encodingWorkerBridge.startSession(
                this.callId,
                (chunk) => this.uploadStream?.write(chunk),
                (errMsg) => this._onWorkerError(errMsg)
            );

            if (!workerStarted) {
                // Worker not ready (e.g. crashed and not yet restarted).
                throw new Error('Encoding worker not ready');
            }
            this._usingWorker = true;

            this.isRecording = true;
            this.startedAt = new Date();

            console.log(`[RecordingSession] ✅ Started recording for call ${this.callId} (DB ID: ${this.recordingId})`);
            return true;

        } catch (error) {
            console.error(`[RecordingSession] ❌ Failed to start recording for call ${this.callId}:`, error.message);
            if (this.recordingId) {
                await RecordingRepository.markFailed(this.recordingId, error.message);
            }
            return false;
        }
    }

    /**
     * Push raw mono PCM from one track to the encoding worker.
     * StereoMixBuffer, interleaving, and encoding all run inside the worker thread —
     * the main thread only copies the wrtc-provided buffer (unavoidable: wrtc reclaims
     * the original after the ondata callback returns).
     *
     * @param {Buffer} audioData - 16-bit PCM, 48 kHz, mono
     * @param {string} trackType - 'agent' or 'customer'
     */
    writeAudioData(audioData, trackType) {
        if (!this.isRecording || this._workerFailed) return;

        try {
            this._frameCounts[trackType] = (this._frameCounts[trackType] ?? 0) + 1;
            if (!this._firstWriteAt[trackType]) {
                this._firstWriteAt[trackType] = Date.now();
                const lagMs = this.startedAt
                    ? this._firstWriteAt[trackType] - this.startedAt.getTime()
                    : '?';
                console.log(
                    `[RecordingSession] ✏️ First ${trackType} frame for call ${this.callId} ` +
                    `(${lagMs}ms after session start)`
                );
            }

            // Copy into an owned ArrayBuffer — audioData.buffer may be the Node.js
            // slab pool (allocUnsafe); transferring it would detach the entire slab.
            const ab = new ArrayBuffer(audioData.length);
            new Uint8Array(ab).set(audioData);
            encodingWorkerBridge.sendFrame(this.callId, trackType, ab);
            this.bytesWritten += audioData.length;
        } catch (error) {
            console.error(`[RecordingSession] writeAudioData error (${trackType}):`, error.message);
        }
    }

    /**
     * Reset the mix buffer and encoder on agent track replacement.
     * Customer recording continues uninterrupted; stale agent PCM is discarded.
     * Both operations run inside the worker — single round-trip.
     */
    resetAgentEncoder() {
        encodingWorkerBridge.resetEncoder(this.callId);
        console.log(`[RecordingSession] Encoder reset for call ${this.callId}`);
    }

    /**
     * Mark a channel active/inactive in the worker's mix buffer.
     * When inactive, silence fills that channel so the other side is not blocked.
     *
     * @param {'agent'|'customer'} channel
     * @param {boolean}            active
     */
    setTrackActive(channel, active) {
        encodingWorkerBridge.setTrackActive(this.callId, channel, active);
    }

    /**
     * Stop recording and finalize the stereo OGG stream.
     *
     * Flushes the mix buffer, sends the last frame to the worker, then awaits
     * the worker's 'stopped' ACK — which arrives only after every OGG page
     * (including the EOS page) has been written to the upload stream.
     *
     * If the worker crashed during this session (_workerFailed), the upload is
     * aborted to prevent a corrupt/partial OGG file from landing in S3.
     *
     * @returns {Promise<boolean>}
     */
    async stop() {
        if (!this.isRecording) {
            console.warn(`[RecordingSession] Call ${this.callId} not recording`);
            return false;
        }
        if (this._stopping) {
            console.warn(`[RecordingSession] stop() already in progress for call ${this.callId}`);
            return false;
        }

        this._stopping = true;
        this.isRecording = false;
        this.endedAt = new Date();

        const durationSeconds = Math.floor((this.endedAt - this.startedAt) / 1000);
        // Capture before any await — concurrent cleanup() nulls this.uploadStream
        // between the DB await and the end() call at the final step.
        const uploadStream = this.uploadStream;

        console.log(`[RecordingSession] Stopping recording for call ${this.callId} (${durationSeconds}s)`);

        try {
            // Signal the worker to flush its mix buffer + encoder, write the OGG EOS
            // page, and send back all remaining chunks.  The worker flushes internally
            // (FIFO ordering) before sending 'stopped', so when this resolves every
            // byte is already written to uploadStream.
            await encodingWorkerBridge.stop(this.callId);
            this._usingWorker = false;

            // 1. Worker crashed while this session was active — the OGG stream is
            //    incomplete.  Abort the S3 upload instead of finalizing corrupt data.
            if (this._workerFailed) {
                console.error(`[RecordingSession] ❌ Worker failed during call ${this.callId} — aborting upload`);
                await streamUploader.abortUploads(this.callId);
                await RecordingRepository.markFailed(
                    this.recordingId,
                    'Recording failed: encoding worker crashed mid-session'
                );
                this.uploadStream = null;
                return false;
            }

            // 2. Register duration so StreamUploader.upload.done() can call
            //    markCompleted once S3 confirms the upload.
            streamUploader.setCompletionData(this.callId, this.recordingId, durationSeconds);

            // 3. Set status to "processing" — waiting for S3 multipart finalization.
            await RecordingRepository.updateStatus(this.recordingId, 'processing');

            // 4. End the PassThrough — triggers the AWS SDK Upload.done() flow.
            //    Use the captured local ref so a concurrent cleanup() cannot prevent
            //    this call from firing.
            uploadStream?.end();
            this.uploadStream = null;

            console.log(
                `[RecordingSession] ✅ Stopped call ${this.callId} — ` +
                `bytes=${this.bytesWritten}, ` +
                `agent=${this._frameCounts.agent} frames, customer=${this._frameCounts.customer} frames, ` +
                `duration=${durationSeconds}s`
            );
            return true;

        } catch (error) {
            console.error(`[RecordingSession] ❌ Failed to stop recording for call ${this.callId}:`, error.message);
            if (this.recordingId) {
                await RecordingRepository.markFailed(this.recordingId, error.message);
            }
            return false;
        } finally {
            this._stopping = false;
        }
    }

    /**
     * Abort recording without saving (called on startup failures or explicit abort).
     */
    async abort() {
        console.log(`[RecordingSession] Aborting recording for call ${this.callId}`);

        try {
            // Tell the worker to free its encoder/muxer before aborting the upload,
            // so any in-flight chunks are discarded cleanly.
            if (this._usingWorker) {
                encodingWorkerBridge.discardSession(this.callId);
                this._usingWorker = false;
            }

            await streamUploader.abortUploads(this.callId);

            if (this.recordingId) {
                await RecordingRepository.markFailed(this.recordingId, 'Recording aborted');
            }

            this.isRecording = false;
            console.log(`[RecordingSession] ✅ Aborted recording for call ${this.callId}`);
            return true;

        } catch (error) {
            console.error(`[RecordingSession] ❌ Failed to abort recording for call ${this.callId}:`, error.message);
            return false;
        }
    }

    /**
     * Release in-process references after stop() or abort() has completed.
     * Does NOT destroy uploadStream — the AWS SDK Upload holds its own reference
     * and must finish reading buffered data before upload.done() can resolve.
     */
    cleanup() {
        if (this._stopping) {
            // stop() is mid-flight — cleanup() was called too early.
            // Log and proceed: nulling references is safe; stop()'s captured
            // local `uploadStream` reference keeps the stream alive.
            console.warn(`[RecordingSession] cleanup() called while stop() in progress for call ${this.callId}`);
        }

        // Defensive: discard any lingering worker session (e.g. crash path where
        // stop() was never called).  No-op if already stopped normally.
        if (this._usingWorker) {
            encodingWorkerBridge.discardSession(this.callId);
            this._usingWorker = false;
        }

        this._workerFailed = false;
        this.uploadStream = null; // null the ref; do NOT call destroy()

        console.log(`[RecordingSession] Cleaned up for call ${this.callId}`);
    }

    /**
     * Snapshot of current recording state.
     */
    getStatus() {
        return {
            callId: this.callId,
            recordingId: this.recordingId,
            isRecording: this.isRecording,
            startedAt: this.startedAt,
            duration: this.startedAt ? Math.floor((new Date() - this.startedAt) / 1000) : 0,
            bytesWritten: this.bytesWritten,
        };
    }

    // ── Private ──────────────────────────────────────────────────────────────

    /**
     * Called by EncodingWorkerBridge when the worker crashes or reports a
     * per-session error.  Sets the _workerFailed flag so stop() can abort the
     * upload rather than finalizing an incomplete OGG file.
     */
    _onWorkerError(errMsg) {
        console.error(`[RecordingSession] Worker error for call ${this.callId}:`, errMsg);
        this._usingWorker = false;
        this._workerFailed = true;
        // Do not set isRecording = false here — stop() must still be called by the
        // caller to trigger DB cleanup and release the session from RecordingManager.
    }
}
