// services/call/audio/bridge/SupervisorCapture.js
//
// Captures raw PCM from the supervisor's incoming WebRTC audio track
// (the mic that the supervisor's browser sends to the server).
//
// Exposes the latest Int16Array frame so MixingRelay instances can
// sample it on every relay tick. The copy is mandatory — wrtc reclaims
// data.samples after the ondata callback returns.
import wrtc from '@roamhq/wrtc';
import { leakMetrics } from '../../../monitoring/leakMetrics.js';

export class SupervisorCapture {
    constructor(track) {
        const { nonstandard } = wrtc;

        if (!nonstandard?.RTCAudioSink) {
            throw new Error('[SupervisorCapture] RTCAudioSink not available');
        }

        this._sink = new nonstandard.RTCAudioSink(track);
        leakMetrics.audioSinkCreated++;

        this._latestSamples = null;

        this._sink.ondata = (data) => {
            // Resize buffer only when the frame length changes (should be stable after first frame).
            if (!this._latestSamples || this._latestSamples.length !== data.samples.length) {
                this._latestSamples = new Int16Array(data.samples.length);
            }
            this._latestSamples.set(data.samples);
        };
    }

    get latestSamples() {
        return this._latestSamples;
    }

    destroy() {
        try { this._sink.stop(); } catch { /* best effort */ }
        leakMetrics.audioSinkStopped++;
        this._latestSamples = null;
    }
}
