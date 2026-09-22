// src/services/monitoring/leakMetrics.js
//
// DIAGNOSTIC ONLY — lightweight process-wide counters used to confirm/quantify
// the WebRTC resource leak before applying the fix. Pure data, no imports, so it
// can be required from any layer without circular-dependency risk.
//
// placeholderCreated  — incremented every time PlaceholderTrackFactory starts a
//                        100 Hz RTCAudioSource interval (one per placeholder track).
// placeholderCleared  — incremented every time such an interval is actually cleared.
//
// placeholderLive = created - cleared. On an IDLE worker (0 active calls) this
// should sit at ~0. If it grows and never returns to baseline after calls end,
// the placeholder interval/RTCAudioSource is leaking (see analysis report).
//
// Safe to leave in production: two integer increments per call, no allocations.
export const leakMetrics = {
    // Placeholder 100 Hz interval (JS timer). Confirmed NOT leaking — timers are cleared.
    placeholderCreated: 0,
    placeholderCleared: 0,
    get placeholderLive() {
        return this.placeholderCreated - this.placeholderCleared;
    },

    // Native wrtc objects — the externalMB suspects. "Stopped" is incremented ONLY
    // where code actually calls track.stop()/sink.stop() to release the native side.
    // *Live = created - stopped; if it grows and never returns to ~0 at idle, the
    // native buffer is leaking (clearing a JS timer does NOT free these).
    //
    //   source = nonstandard.RTCAudioSource  (placeholder / IVR / queue audio)
    //   sink   = nonstandard.RTCAudioSink    (recording capture / DTMF capture)
    audioSourceCreated: 0,
    audioSourceStopped: 0,
    audioSinkCreated:   0,
    audioSinkStopped:   0,
    get audioSourceLive() { return this.audioSourceCreated - this.audioSourceStopped; },
    get audioSinkLive()   { return this.audioSinkCreated   - this.audioSinkStopped;   },
};
