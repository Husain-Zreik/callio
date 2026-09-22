// services/call/audio/PlaceholderTrackFactory.js
//
// Single responsibility: create and manage the lifecycle of WebRTC placeholder
// audio tracks (silence / reconnecting tones) that fill the audio pipe
// whenever the real agent track is absent.
//
// Ownership of _placeholderInterval cleanup lives here, not in RecordingManager.
import wrtc from '@roamhq/wrtc';
import { leakMetrics } from '../../monitoring/leakMetrics.js';

const _buildToneTable = (freq, rate = 48000) => {
    const period = Math.round(rate / freq);
    const t = new Float32Array(period);
    for (let i = 0; i < period; i++) t[i] = Math.sin(2 * Math.PI * i / period);
    return t;
};
// Pre-computed reconnecting tone cycle: 600 → 750 → 900 Hz (0.2s each) + 1.2s silence.
// Total = 86,400 samples at 48 kHz = exactly 180 × 480-sample frames — no wrap-around mid-frame.
// Built once at module load; the interval callback becomes a single typed-array copy.
// Tone tables are local to this function so they are GC'd after _RECONNECTING_CYCLE is assigned.
const _buildReconnectingCycle = (rate = 48000) => {
    const tone600 = _buildToneTable(600);
    const tone750 = _buildToneTable(750);
    const tone900 = _buildToneTable(900);
    const t1 = Math.round(rate * 0.2);   // 9,600  samples — 600 Hz tone
    const t2 = Math.round(rate * 0.2);   // 9,600  samples — 750 Hz tone
    const t3 = Math.round(rate * 0.2);   // 9,600  samples — 900 Hz tone
    const pause = Math.round(rate * 1.2);   // 57,600 samples — silence
    const buf = new Int16Array(t1 + t2 + t3 + pause);
    let pos = 0;
    const fillTone = (table, duration) => {
        for (let s = 0; s < duration; s++, pos++) {
            const progress = s / duration;
            const envelope = progress < 0.15 ? progress / 0.15
                : progress > 0.85 ? (1.0 - progress) / 0.15
                    : 1.0;
            buf[pos] = Math.round(table[s % table.length] * envelope * 0.08 * 32767);
        }
    };
    fillTone(tone600, t1);
    fillTone(tone750, t2);
    fillTone(tone900, t3);
    // pause region stays 0 (Int16Array zero-initialized)
    return buf;
};
const _RECONNECTING_CYCLE = _buildReconnectingCycle();

class PlaceholderTrackFactory {
    constructor() {
        // callId -> MediaStreamTrack (for interval cleanup on reconnect / stop)
        this._tracks = new Map();
    }

    /**
     * Create a placeholder MediaStreamTrack backed by an RTCAudioSource.
     *
     * @param {'reconnecting'|'silence'} type
     * @param {((pcm: Buffer) => void)|null} onFrame  Optional callback fired every 10 ms
     *        with the raw PCM Buffer — used to pipe placeholder audio into a recording session.
     * @returns {Promise<MediaStreamTrack|null>}
     */
    async createTrack(type = 'reconnecting', onFrame = null) {
        const { nonstandard } = wrtc;

        try {
            if (!nonstandard?.RTCAudioSource) {
                return null;
            }

            const audioSource = new nonstandard.RTCAudioSource();
            leakMetrics.audioSourceCreated++;   // DIAGNOSTIC (native): placeholder source
            const track = audioSource.createTrack();

            const sampleRate = 48000;
            const frameSize = 480;
            const samples = new Int16Array(frameSize);
            let cycleOffset = 0;

            const interval = setInterval(() => {
                if (type === 'reconnecting') {
                    samples.set(_RECONNECTING_CYCLE.subarray(cycleOffset, cycleOffset + frameSize));
                    cycleOffset = (cycleOffset + frameSize) % _RECONNECTING_CYCLE.length;
                }
                // silence: samples is Int16Array — all-zero on creation, never written to

                audioSource.onData({
                    samples,
                    sampleRate,
                    numberOfFrames: frameSize,
                    channelCount: 1,
                });

                if (onFrame) {
                    // Buffer.from(samples.buffer) creates a view — no copy.
                    // writeAudioData copies into its own ArrayBuffer synchronously before returning,
                    // so the view is never stale when the next tick overwrites samples.
                    onFrame(Buffer.from(samples.buffer));
                }
            }, 10);

            track._placeholderInterval = interval;
            track._audioSource = audioSource;
            track._isGeneratedSource = true;    // marks an RTCAudioSource-backed track for releaseGeneratedTrack()
            leakMetrics.placeholderCreated++;   // DIAGNOSTIC: count live placeholder intervals
            return track;

        } catch (error) {
            console.error('[PlaceholderTrackFactory] Cannot create audio source:', error.message);
            return null;
        }
    }

    /**
     * Register a track under callId so its interval can be stopped later.
     * Automatically clears any previously registered track for the same call.
     */
    registerTrack(callId, track) {
        this.clearTrack(callId); // prevent leaked intervals
        this._tracks.set(callId, track);
    }

    /**
     * Stop the placeholder interval for callId and remove the registration.
     */
    clearTrack(callId) {
        const track = this._tracks.get(callId);
        if (!track) return;

        if (this.releaseGeneratedTrack(track)) {
            console.log(`[PlaceholderTrackFactory] 🔇 Placeholder released for call ${callId}`);
        }

        this._tracks.delete(callId);
    }

    /**
     * Fully release a generated-source track (placeholder tone, IVR prompt, or
     * queue audio). Stops the 100 Hz generation interval (if any) AND stops the
     * MediaStreamTrack so wrtc frees the native RTCAudioSource (externalMB).
     *
     * Idempotent (guarded by _isGeneratedSource) and safe to call on real
     * receiver tracks — those are not marked, so they are left untouched.
     *
     * @param {MediaStreamTrack|null|undefined} track
     * @returns {boolean} true if a generated source was released by this call
     */
    releaseGeneratedTrack(track, { stopTrack = false } = {}) {
        if (!track || !track._isGeneratedSource) return false;

        if (track._placeholderInterval) {
            clearInterval(track._placeholderInterval);
            track._placeholderInterval = null;
            leakMetrics.placeholderCleared++;   // DIAGNOSTIC
        }

        // track.stop() frees the underlying native RTCAudioSource (externalMB). But in
        // wrtc 0.4.7 replaceTrack() does NOT detach the original track from its sender
        // (sender.track still points at it), so stopping a track whose sender is still
        // live kills that sender's audio — this is what broke placeholder/reconnect
        // audio. It is therefore ONLY safe when the owning RTCPeerConnection has already
        // been closed, i.e. final teardown (caller passes stopTrack: true). On mid-call
        // paths (replace / shift) we must NOT stop — clearing the interval above already
        // stops the CPU leak; the native source is reclaimed when the pc later closes.
        if (stopTrack) {
            try { track.stop?.(); } catch { /* best effort */ }
        }
        track._audioSource = null;
        track._isGeneratedSource = false;   // idempotency guard — never double-release
        leakMetrics.audioSourceStopped++;   // DIAGNOSTIC
        return true;
    }

    /**
     * Convenience: create a track AND register it under callId in one call.
     */
    async createAndRegister(callId, type = 'reconnecting', onFrame = null) {
        const track = await this.createTrack(type, onFrame);
        if (track) {
            this.registerTrack(callId, track);
        }
        return track;
    }
}

export const placeholderTrackFactory = new PlaceholderTrackFactory();
