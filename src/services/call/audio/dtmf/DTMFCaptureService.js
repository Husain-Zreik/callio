// services/call/audio/dtmf/DTMFCaptureService.js
//
// Manages one RTCAudioSink per call on the WhatsApp (customer) track and
// forwards PCM frames to DTMFWorkerBridge for Goertzel processing off the
// main event loop. Emits 'call:dtmf' on EventBus when a digit is confirmed.
//
// Mirrors AudioCaptureService in structure and lifecycle contract.
import wrtc from '@roamhq/wrtc';
import { dtmfWorkerBridge } from './DTMFWorkerBridge.js';
import EventBus from '../../../core/EventBus.js';
import { leakMetrics } from '../../../monitoring/leakMetrics.js';

class DTMFCaptureService {
    constructor() {
        // callId -> { sink: RTCAudioSink }
        this.activeSinks = new Map();
        // callId -> RTCAudioSink that has been soft-stopped (ondata detached) but
        // whose native sink is intentionally NOT released yet — see stopCapture().
        // These are hard-released in destroy() at final call teardown.
        this._idleSinks = new Map();
    }

    startCapture(callId, customerTrack) {
        if (this.activeSinks.has(callId)) {
            console.warn(`[DTMFCapture] Already active for call ${callId} — skipping`);
            return false;
        }

        // A prior soft-stopped sink for this call would otherwise linger. Drop the
        // reference WITHOUT calling sink.stop() — this is mid-call, and the customer
        // track may still be live (sink.stop() ends the shared track). The orphaned
        // native sink is released when the call finally tears down.
        if (this._idleSinks.has(callId)) this._idleSinks.delete(callId);

        if (!customerTrack || customerTrack.kind !== 'audio') {
            console.error(`[DTMFCapture] Invalid customer track for call ${callId}`);
            return false;
        }

        const { nonstandard } = wrtc;
        if (!nonstandard?.RTCAudioSink) {
            console.error('[DTMFCapture] RTCAudioSink unavailable — wrtc issue');
            return false;
        }

        try {
            // Register the worker session so digit callbacks are wired before any
            // frames arrive (even though the sink starts paused with ondata=null).
            dtmfWorkerBridge.startSession(callId, (digit) => {
                console.log(`[DTMFCapture] Digit '${digit}' on call ${callId}`);
                EventBus.emit('call:dtmf', { callId, digit });
            });

            const sink = new nonstandard.RTCAudioSink(customerTrack);
            leakMetrics.audioSinkCreated++;   // DIAGNOSTIC (native): DTMF sink (note: stopCapture never calls sink.stop)

            // Start forwarding frames immediately — DTMFCoordinator (non-IVR path)
            // relies on this being active right away and never calls resumeCapture().
            // IvrCoordinator immediately follows startCapture() with pauseCapture(),
            // which nulls ondata before any frames arrive — this set is a no-op cost.
            sink.ondata = this._makeFrameHandler(callId);

            // pausedSincePriorResume starts true: no digit state exists yet, so the
            // first resumeCapture() may as well take the (harmless) full-reset path.
            this.activeSinks.set(callId, { sink, pausedSincePriorResume: true });
            console.log(`[DTMFCapture] ✅ Started for call ${callId}, track=${customerTrack.id}`);
            return true;

        } catch (error) {
            console.error(`[DTMFCapture] ❌ Failed to start for call ${callId}:`, error.message);
            return false;
        }
    }

    /**
     * Disable frame forwarding without destroying the sink or the worker session.
     * Used when transitioning away from an ivr_menu node.
     */
    pauseCapture(callId) {
        const entry = this.activeSinks.get(callId);
        if (!entry) return false;
        entry.sink.ondata = null;
        entry.pausedSincePriorResume = true;
        return true;
    }

    /**
     * Re-enable frame forwarding to the DTMF worker.
     * Used when entering an ivr_menu node.
     */
    resumeCapture(callId) {
        const entry = this.activeSinks.get(callId);
        if (!entry) return false;
        // Reset stale detector state from the previous menu node so that:
        // - leftover _buffer samples don't contaminate the first window
        // - _pendingDigit from a partial confirm can't fire as a false positive
        //
        // _activeDigit/_lastEmit are only cleared (full: true) when capture was
        // actually paused since the last resume — e.g. an ivr_play node played in
        // between. With frames genuinely stopped, _onNullWindow never ran, so a
        // stale _activeDigit would otherwise sit frozen and could swallow an
        // entire new press once resumed. For a direct ivr_menu -> ivr_menu
        // transition (no pause — frames kept flowing), full stays false so a
        // trailing tone from the routing digit can't re-fire on the new menu.
        // See DTMFDetector.reset() for the full rationale.
        dtmfWorkerBridge.resetSession(callId, { full: entry.pausedSincePriorResume });
        entry.pausedSincePriorResume = false;
        entry.sink.ondata = this._makeFrameHandler(callId);
        return true;
    }

    stopCapture(callId) {
        const entry = this.activeSinks.get(callId);
        if (!entry) {
            console.log(`[DTMFCapture] No active capture for call ${callId} — already cleaned up`);
            return false;
        }

        try {
            // Detach the data handler only — do NOT call sink.stop().
            // wrtc's RTCAudioSink.stop() calls track.stop() at the C++ layer,
            // which ends the MediaStreamTrack (readyState → 'ended'). For IVR
            // transfers the customer track is the WHATSAPP receiver track: ending
            // it silences the caller and breaks _relayWhatsAppTrackToFrontend()
            // when the agent later accepts from the queue.
            entry.sink.ondata = null;
            // Free the worker session — detector state is no longer needed once
            // the IVR session ends (transferred, hung_up, etc.).
            dtmfWorkerBridge.stopSession(callId);
            // Retain the native sink (do NOT stop it here) so the shared WHATSAPP
            // track survives IVR transfer. It is hard-released in destroy() at teardown.
            this._idleSinks.set(callId, entry.sink);
            this.activeSinks.delete(callId);
            console.log(`[DTMFCapture] ✅ Soft-stopped for call ${callId} (sink retained for teardown)`);
            return true;
        } catch (error) {
            console.error(`[DTMFCapture] ❌ Failed to stop for call ${callId}:`, error.message);
            this.activeSinks.delete(callId);
            return false;
        }
    }

    /**
     * Hard-release the RTCAudioSink at FINAL call teardown — frees the native sink.
     *
     * Only call this once the owning peer connection is already closed (it is invoked
     * via audioCoordinator.cleanup() → after closePeerConnection has closed the pc, and
     * on graceful shutdown). At that point the customer track is already ending, so
     * sink.stop() — which ends the track in this wrtc build — is safe. This is the same
     * teardown-only pattern proven safe for placeholder/IVR audio sources.
     *
     * It must NOT be called mid-call (e.g. from startCapture) — that path drops the
     * reference without stopping, since the shared track is still live.
     */
    destroy(callId) {
        const entry = this.activeSinks.get(callId);
        if (entry?.sink) {
            try {
                entry.sink.ondata = null;
                // Safety: free worker session if stopCapture() was never called
                // (e.g. direct destroy on an error path).
                dtmfWorkerBridge.stopSession(callId);
                entry.sink.stop();
                leakMetrics.audioSinkStopped++;   // DIAGNOSTIC (native): DTMF sink released
            } catch (error) {
                console.error(`[DTMFCapture] Failed to destroy active sink for call ${callId}:`, error.message);
            }
            this.activeSinks.delete(callId);
        }

        const idleSink = this._idleSinks.get(callId);
        if (idleSink) {
            try {
                idleSink.stop();
                leakMetrics.audioSinkStopped++;   // DIAGNOSTIC (native): DTMF sink released
            } catch (error) {
                console.error(`[DTMFCapture] Failed to destroy idle sink for call ${callId}:`, error.message);
            }
            this._idleSinks.delete(callId);
        }
    }

    _makeFrameHandler(callId) {
        // Copy into a fresh buffer before transferring: wrtc reclaims
        // samples.buffer after this callback returns, so we cannot transfer
        // the original — that would detach memory wrtc still owns.
        return ({ samples, sampleRate }) => {
            const ab = new ArrayBuffer(samples.byteLength);
            new Int16Array(ab).set(samples);
            dtmfWorkerBridge.sendFrame(callId, ab, sampleRate);
        };
    }

    isActive(callId) {
        return this.activeSinks.has(callId);
    }

    cleanup() {
        const ids = new Set([...this.activeSinks.keys(), ...this._idleSinks.keys()]);
        console.log(`[DTMFCapture] Cleaning up ${ids.size} capture(s)...`);
        for (const callId of ids) {
            this.destroy(callId);
        }
        console.log('[DTMFCapture] ✅ Cleanup complete');
    }
}

export const dtmfCaptureService = new DTMFCaptureService();
