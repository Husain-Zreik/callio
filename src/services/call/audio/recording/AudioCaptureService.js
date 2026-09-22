// src/services/call/audio/recording/AudioCaptureService.js
import wrtc from '@roamhq/wrtc';
import { leakMetrics } from '../../../monitoring/leakMetrics.js';

// A gap of >2s without any RTP frame means the audio stream is interrupted.
// Normal DTX / comfort-noise gaps from WebRTC are <500ms, so 2s filters those out
// cleanly while catching real network drops (which stop frames immediately).
const MEDIA_GAP_THRESHOLD_MS = 2000;
const GAP_WATCHER_INTERVAL_MS = 500;   // check frequency — detection latency ≤ 500ms

/**
 * Captures audio from WebRTC peer connections for recording.
 * Tracks per-sink media flow in real time (frame counts, gaps, first/last frame
 * timestamps) so every call produces a full media-flow fingerprint at close time.
 */
export class AudioCaptureService {
    constructor() {
        this.activeSinks = new Map(); // callId -> { agent: AudioSink, customer: AudioSink }
    }

    /**
     * Start capturing audio from a track.
     * @param {string} callId
     * @param {MediaStreamTrack} track - WebRTC audio track
     * @param {string} trackType - 'agent' or 'customer'
     * @param {Function} onAudioData - Callback(audioData: Buffer, trackType: string)
     */
    startCapture(callId, track, trackType, onAudioData) {
        const { nonstandard } = wrtc;

        if (!track || track.kind !== 'audio') {
            console.error(`[AudioCapture] Invalid track for ${trackType}`);
            return false;
        }

        if (!nonstandard?.RTCAudioSink) {
            console.error('[AudioCapture] RTCAudioSink not available (wrtc library issue)');
            return false;
        }

        try {
            // Log track state BEFORE attaching the sink. A track that is already
            // 'ended' or muted here means the RTP stream never arrived from Meta —
            // the sink will attach but ondata will never fire (138021 diagnostic).
            console.log(
                `[AudioCapture] Attaching ${trackType} sink for call ${callId}: ` +
                `readyState=${track.readyState}, muted=${track.muted}, enabled=${track.enabled}, id=${track.id}`
            );

            const audioSink = new nonstandard.RTCAudioSink(track);
            leakMetrics.audioSinkCreated++;   // DIAGNOSTIC (native): recording sink

            // ── Media-flow tracking ───────────────────────────────────────────────
            // These three timestamps + gap history form the full media-flow fingerprint:
            //
            //   first_frame=NEVER, last_frame=NEVER, gaps=[]
            //     → Meta never sent RTP from the start (138021: no media from client)
            //
            //   first_frame=Xms, last_frame=~21s before close, gaps=[{durationMs: ~21000}]
            //     → Client dropped network mid-call; Meta's 20-21s watchdog fired (client-side)
            //
            //   first_frame=Xms, last_frame=~0s before close, gaps=[]
            //     → Audio flowed uninterrupted until call end (healthy call)
            const captureStartedAt = Date.now();
            let firstFrameAt = null;
            let lastFrameAt = null;
            let frameCount = 0;

            // Gap history — each entry is { startedAt, endedAt, durationMs }.
            // A final gap that never resumed is added at stopCapture time.
            const gaps = [];
            let gapStartedAt = null;  // non-null while a gap is active

            audioSink.ondata = (data) => {
                frameCount++;
                const now = Date.now();

                if (frameCount === 1) {
                    firstFrameAt = now;
                    console.log(
                        `[AudioCapture] 🔊 FIRST FRAME: ${trackType} call ${callId} — ` +
                        `${firstFrameAt - captureStartedAt}ms after sink attach, ` +
                        `rate=${data.sampleRate}Hz frames=${data.numberOfFrames}`
                    );
                }

                // If a gap was active, it just ended — audio has resumed.
                if (gapStartedAt !== null) {
                    const durationMs = now - gapStartedAt;
                    gaps.push({ startedAt: gapStartedAt, endedAt: now, durationMs });
                    console.log(
                        `[AudioCapture] ▶️  MEDIA RESUMED: ${trackType} call ${callId} — ` +
                        `gap was ${durationMs}ms`
                    );
                    gapStartedAt = null;
                }

                lastFrameAt = now;
                const audioBuffer = this._convertToBuffer(data);
                onAudioData(audioBuffer, trackType);
            };

            // ── Gap watcher ───────────────────────────────────────────────────────
            // Fires every 500ms to detect when RTP frames stop arriving.
            // Only activates once the first frame has been received — before that
            // we don't yet know whether audio will ever arrive (separate signal).
            const gapWatcher = setInterval(() => {
                if (!lastFrameAt) return;   // no frames yet — handled by first_frame=NEVER

                const silentMs = Date.now() - lastFrameAt;
                if (silentMs >= MEDIA_GAP_THRESHOLD_MS && gapStartedAt === null) {
                    gapStartedAt = lastFrameAt;   // gap started right after the last frame
                    console.log(
                        `[AudioCapture] ⚠️  MEDIA GAP: ${trackType} call ${callId} — ` +
                        `no frames for ${silentMs}ms`
                    );
                }
            }, GAP_WATCHER_INTERVAL_MS);

            // Expose closures for retrieval at stopCapture time
            audioSink._captureStartedAt = captureStartedAt;
            audioSink._getFirstFrameAt = () => firstFrameAt;
            audioSink._getLastFrameAt = () => lastFrameAt;
            audioSink._getFrameCount = () => frameCount;
            audioSink._getGapStartedAt = () => gapStartedAt;
            audioSink._getGaps = () => gaps;
            audioSink._gapWatcher = gapWatcher;

            // Store sink reference
            if (!this.activeSinks.has(callId)) {
                this.activeSinks.set(callId, {});
            }
            this.activeSinks.get(callId)[trackType] = audioSink;

            console.log(`[AudioCapture] ✅ Started capturing ${trackType} audio for call ${callId}`);
            return true;

        } catch (error) {
            console.error(`[AudioCapture] ❌ Failed to start ${trackType} capture:`, error.message);
            return false;
        }
    }

    /**
     * Convert RTCAudioSink data to Buffer for streaming.
     * Creates a zero-copy view over the existing ArrayBuffer — safe because
     * StereoMixBuffer.push() copies the data synchronously before this
     * ondata handler returns, so wrtc cannot reclaim the buffer in the interim.
     * @param {Object} data - { samples: Int16Array, sampleRate, channelCount, numberOfFrames }
     */
    _convertToBuffer(data) {
        return Buffer.from(data.samples.buffer, data.samples.byteOffset, data.samples.byteLength);
    }

    /**
     * Stop capturing audio for a specific track.
     * Logs a full media-flow summary before releasing the sink.
     */
    stopCapture(callId, trackType) {
        const sinks = this.activeSinks.get(callId);
        if (!sinks || !sinks[trackType]) {
            console.log(`[AudioCapture] No ${trackType} sink found for call ${callId} — already cleaned up`);
            return false;
        }

        try {
            const sink = sinks[trackType];
            const stopAt = Date.now();

            // Stop the gap watcher first so it doesn't fire after the sink is released.
            if (sink._gapWatcher) clearInterval(sink._gapWatcher);

            // Collect final metrics
            const startedAt = sink._captureStartedAt;
            const firstFrame = sink._getFirstFrameAt?.() ?? null;
            const lastFrame = sink._getLastFrameAt?.() ?? null;
            const frames = sink._getFrameCount?.() ?? '?';
            const gaps = sink._getGaps?.() ?? [];
            const activeGap = sink._getGapStartedAt?.() ?? null;

            // If a gap was still active when we stopped, record it as a final gap.
            if (activeGap !== null) {
                const durationMs = stopAt - activeGap;
                gaps.push({ startedAt: activeGap, endedAt: stopAt, durationMs, final: true });
            }

            const firstMsg = firstFrame != null ? `${firstFrame - startedAt}ms after attach` : 'NEVER';
            const lastMsg = lastFrame != null ? `${stopAt - lastFrame}ms before close` : 'NEVER';

            // Gap summary — for future analysis: total gap time, count, longest gap.
            let gapSummary = 'gaps=0';
            if (gaps.length > 0) {
                const totalSilentMs = gaps.reduce((s, g) => s + g.durationMs, 0);
                const longestMs = Math.max(...gaps.map(g => g.durationMs));
                gapSummary = `gaps=${gaps.length} longest=${longestMs}ms total_silent=${totalSilentMs}ms`;
            }

            console.log(
                `[AudioCapture] 📊 Sink closed: ${trackType} call ${callId} — ` +
                `frames=${frames}, first_frame=${firstMsg}, last_frame=${lastMsg}, ${gapSummary}`
            );

            // Stop the audio sink
            sink.stop();
            leakMetrics.audioSinkStopped++;   // DIAGNOSTIC (native): recording sink released

            delete sinks[trackType];
            if (Object.keys(sinks).length === 0) {
                this.activeSinks.delete(callId);
            }

            console.log(`[AudioCapture] ✅ Stopped ${trackType} capture for call ${callId}`);
            return true;

        } catch (error) {
            console.error(`[AudioCapture] ❌ Failed to stop ${trackType} capture:`, error.message);
            return false;
        }
    }

    /**
     * Stop all captures for a call.
     */
    stopAllCaptures(callId) {
        const sinks = this.activeSinks.get(callId);
        if (!sinks) {
            console.log(`[AudioCapture] No sinks found for call ${callId} — already cleaned up`);
            return false;
        }

        console.log(`[AudioCapture] Stopping all captures for call ${callId}`);

        for (const trackType of Object.keys(sinks)) {
            this.stopCapture(callId, trackType);
        }

        return true;
    }

    /**
     * Cleanup all captures (graceful shutdown).
     */
    cleanup() {
        console.log(`[AudioCapture] Cleaning up ${this.activeSinks.size} active captures...`);
        for (const callId of this.activeSinks.keys()) {
            this.stopAllCaptures(callId);
        }
        console.log('[AudioCapture] ✅ Cleanup complete');
    }
}

// Singleton instance
export const audioCaptureService = new AudioCaptureService();
