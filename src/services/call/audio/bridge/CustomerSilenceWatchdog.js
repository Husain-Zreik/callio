// services/call/audio/bridge/CustomerSilenceWatchdog.js
//
// Detects customer network drop by watching for a sustained run of all-zero
// PCM frames on the WHATSAPP incoming track.
//
// WHY we detect drop via PCM (confirmed by probe call 488):
//   • Customer network dropped → Meta's relay has nothing to forward; our
//     local jitter buffer generates mathematically all-zero PLC frames (peak=0).
//     concealedSamples in WebRTC stats grew at 48000/s (100% PLC) during drop.
//   • Customer speaking/quiet mic on → real audio with peak > 0 (any value).
//
// NOTE: We deliberately do NOT detect "muted" state. WhatsApp CNG (peak≈1 LSB)
// cannot be reliably distinguished from a very quiet but unmuted mic — both
// produce very-low-amplitude frames. A false "Muted" badge is worse than none.
//
// HOT PATH (_onFrame): runs on the libuv event-loop thread ~100×/s per call.
//   - Single scan with early-exit on the first non-zero sample.
//   - Zero allocations: only one integer counter touched per frame.
//   - No setInterval: state transitions are driven purely by frame counters.
//   - Fires onStateChange only when state actually changes (not every frame).
//
// States: 'active' | 'drop'
//   active → drop   after DROP_FRAMES consecutive all-zero frames (~3s)
//   drop   → active on the first non-zero frame (instant)
import wrtc from '@roamhq/wrtc';
import { leakMetrics } from '../../../monitoring/leakMetrics.js';

const DROP_FRAMES = 300;   // 3s × 100fps — avoids false positives from codec transitions

export class CustomerSilenceWatchdog {
    /**
     * @param {MediaStreamTrack} track  — WHATSAPP receiver track
     * @param {string|number}    callId
     * @param {Function}         onStateChange — (callId, 'active'|'drop') => void
     */
    constructor(track, callId, onStateChange) {
        const { nonstandard } = wrtc;
        if (!nonstandard?.RTCAudioSink) throw new Error('[CustomerSilenceWatchdog] RTCAudioSink unavailable');

        this.trackId     = track.id;
        this._callId     = callId;
        this._state      = 'active';
        this._zeroFrames = 0;
        this._active     = true;

        this._sink = new nonstandard.RTCAudioSink(track);
        leakMetrics.audioSinkCreated++;

        // Bind once — stable reference, no per-frame closure.
        this._sink.ondata = (data) => {
            if (!this._active) return;

            // Early-exit scan: stop as soon as we find any non-zero sample.
            const s = data.samples;
            let hasAudio = false;
            for (let i = 0; i < s.length; i++) {
                if (s[i] !== 0) { hasAudio = true; break; }
            }

            if (!hasAudio) {
                // All-zero: PLC frames from the local jitter buffer (network gone).
                if (++this._zeroFrames === DROP_FRAMES && this._state !== 'drop') {
                    this._state = 'drop';
                    console.log(`[CustomerSilenceWatchdog] ⚠ DROP call=${callId}`);
                    onStateChange(callId, 'drop');
                }
            } else {
                // Any non-zero audio: customer's signal is present (speaking, quiet, or CNG).
                this._zeroFrames = 0;
                if (this._state !== 'active') {
                    const prev = this._state;
                    this._state = 'active';
                    console.log(`[CustomerSilenceWatchdog] ✓ ACTIVE call=${callId} (was ${prev})`);
                    onStateChange(callId, 'active');
                }
            }
        };

        console.log(`[CustomerSilenceWatchdog] Attached call=${callId} track=${track.id}`);
    }

    get state() { return this._state; }

    destroy() {
        this._active = false;
        try { this._sink.stop(); } catch { /* best effort */ }
        leakMetrics.audioSinkStopped++;
        console.log(`[CustomerSilenceWatchdog] Detached call=${this._callId}`);
    }
}
