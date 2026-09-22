// services/call/audio/bridge/MixingRelay.js
//
// PCM mixing intermediary between an incoming WebRTC track and a sender.
//
// Attaches an RTCAudioSink to a source track, reads each 10ms frame, optionally
// mixes in supervisor PCM from a SupervisorCapture, and pushes the result into
// an RTCAudioSource whose output track is used as the sender track.
//
// HOT PATH (_onFrame): runs on the libuv event-loop thread ~100×/s per relay.
// It is allocation-free —
//   - passthrough forwards the wrtc frame object unchanged (zero copy),
//   - the mixing path reuses one exact-size _mixBuffer and one reused _outFrame
//     object, so there is no per-frame object/subarray allocation.
// wrtc copies the samples into its native buffer synchronously inside onData(),
// so reusing _mixBuffer on the next frame is safe.
//
// Peak levels are accumulated inside the existing mix loop (a few comparisons
// per sample) and logged once per ~second per relay, so the cost is negligible
// while still surfacing whether the real call audio (srcPeak) reaches the mixer,
// the manager level (supPeak), the mixed output (outPeak), and any rate mismatch.
import wrtc from '@roamhq/wrtc';
import { placeholderTrackFactory } from '../PlaceholderTrackFactory.js';
import { leakMetrics } from '../../../monitoring/leakMetrics.js';

const LOG_EVERY = 100; // log cadence in frames (~1s at 10ms/frame)
const INT16_MAX = 32767;
const INT16_MIN = -32768;

export class MixingRelay {
    constructor(sourceTrack, label = 'relay') {
        const { nonstandard } = wrtc;
        if (!nonstandard?.RTCAudioSink || !nonstandard?.RTCAudioSource) {
            throw new Error('[MixingRelay] RTCAudioSink/RTCAudioSource not available');
        }

        this._label = label;
        this._sourceTrackId = sourceTrack?.id ?? 'unknown';

        // wrtc primitives: read the source track, emit the mixed output track.
        this._sink = new nonstandard.RTCAudioSink(sourceTrack);
        leakMetrics.audioSinkCreated++;
        this._source = new nonstandard.RTCAudioSource();
        leakMetrics.audioSourceCreated++;
        this._outputTrack = this._source.createTrack();
        this._outputTrack._isGeneratedSource = true;

        // Mix state.
        this._supervisorCapture = null;
        this._active = true;
        this._mixBuffer = null; // Int16Array, exact frame size, allocated once
        // Reused output frame — fields overwritten each frame (no allocation).
        this._outFrame = { samples: null, sampleRate: 0, bitsPerSample: 16, channelCount: 1, numberOfFrames: 0 };

        // Rolling peak window for the throttled diagnostic log.
        this._diag = { frames: 0, mixFrames: 0, srcPeak: 0, supPeak: 0, outPeak: 0, srcRate: 0, supLen: 0 };

        // Bind once so the hot path is a stable method reference (no per-frame closure).
        this._sink.ondata = this._onFrame.bind(this);
    }

    // ── Public API ──────────────────────────────────────────────────────────

    get outputTrack() {
        return this._outputTrack;
    }

    setSupervisorCapture(capture) {
        this._supervisorCapture = capture;
    }

    destroy() {
        this._active = false;
        try { this._sink.stop(); } catch { /* best effort */ }
        leakMetrics.audioSinkStopped++;
        // stopTrack:false — destroy() runs mid-call (mode step-down / supervisor leaving)
        // while this output track is still wired to a live call sender. Per the wrtc 0.4.7
        // behaviour documented in PlaceholderTrackFactory, replaceTrack() does not detach,
        // so stopping it now would kill that sender's audio. The native RTCAudioSource is
        // reclaimed when the peer connection closes (same convention as placeholders).
        placeholderTrackFactory.releaseGeneratedTrack(this._outputTrack, { stopTrack: false });
        this._outputTrack = null;
        this._supervisorCapture = null;
        this._mixBuffer = null;
        this._outFrame = null;
    }

    // ── Hot path ────────────────────────────────────────────────────────────

    _onFrame(data) {
        if (!this._active) return;
        this._diag.frames++;

        const supSamples = this._supervisorCapture?.latestSamples;
        if (!supSamples) {
            // No supervisor audio — forward the wrtc frame untouched (zero copy).
            this._source.onData(data);
            this._maybeLog();
            return;
        }

        this._mixInto(data, supSamples);
        this._maybeLog();
    }

    // Mix `supSamples` into `data` and emit the result, tracking peaks in the
    // same pass. Allocation-free: reuses _mixBuffer (exact size) and _outFrame.
    _mixInto(data, supSamples) {
        const d = this._diag;
        d.mixFrames++;
        d.srcRate = data.sampleRate;
        d.supLen = supSamples.length;

        const src = data.samples;
        const relayLen = src.length;
        if (!this._mixBuffer || this._mixBuffer.length !== relayLen) {
            this._mixBuffer = new Int16Array(relayLen);
        }
        const mix = this._mixBuffer;
        const overlap = relayLen < supSamples.length ? relayLen : supSamples.length;

        let srcPeak = 0, supPeak = 0, outPeak = 0;
        for (let i = 0; i < overlap; i++) {
            const a = src[i]; const aAbs = a < 0 ? -a : a; if (aAbs > srcPeak) srcPeak = aAbs;
            const s = supSamples[i]; const sAbs = s < 0 ? -s : s; if (sAbs > supPeak) supPeak = sAbs;
            let v = a + s;
            if (v > INT16_MAX) v = INT16_MAX; else if (v < INT16_MIN) v = INT16_MIN;
            mix[i] = v;
            const vAbs = v < 0 ? -v : v; if (vAbs > outPeak) outPeak = vAbs;
        }
        // Source frame longer than the supervisor frame — pass the tail through.
        for (let i = overlap; i < relayLen; i++) {
            const a = src[i]; const aAbs = a < 0 ? -a : a; if (aAbs > srcPeak) srcPeak = aAbs;
            mix[i] = a;
        }

        if (srcPeak > d.srcPeak) d.srcPeak = srcPeak;
        if (supPeak > d.supPeak) d.supPeak = supPeak;
        if (outPeak > d.outPeak) d.outPeak = outPeak;

        const out = this._outFrame;
        out.samples = mix;
        out.sampleRate = data.sampleRate;
        out.bitsPerSample = data.bitsPerSample;
        out.channelCount = data.channelCount;
        out.numberOfFrames = data.numberOfFrames;
        this._source.onData(out);
    }

    // ── Diagnostics ─────────────────────────────────────────────────────────

    _maybeLog() {
        const d = this._diag;
        if (d.frames % LOG_EVERY !== 0) return;
        console.log(
            `[MixingRelay:${this._label}] src=${this._sourceTrackId} frames=${d.frames} mix=${d.mixFrames} ` +
            `srcPeak=${d.srcPeak} supPeak=${d.supPeak} outPeak=${d.outPeak} srcRate=${d.srcRate} supLen=${d.supLen}`
        );
        d.srcPeak = 0; d.supPeak = 0; d.outPeak = 0;
    }
}
