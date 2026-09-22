// services/call/signaling/SignalingAdapter.js
//
// Hexagonal port for call-leg signaling. Defines the transport-agnostic
// contract the call domain (event handlers, coordinators) can eventually
// depend on instead of reaching into WebRTC-specific singletons directly.
//
// This is scaffolding only (see ARCHITECTURE.md "Signaling Adapter Layer"):
// no existing call site has been migrated to use this contract yet. The
// method shapes below were not invented — they mirror the already-existing
// public APIs of `SDPCoordinator`, `PeerRegistry`, and `ICECandidateCoordinator`
// (each annotated below), which are the three singletons every event handler
// currently calls through for signaling. A concrete adapter is expected to
// extend this class and implement every method; the base class only throws,
// so a half-implemented adapter fails loudly instead of silently no-op'ing.
import { EventEmitter } from '../../core/EventEmitter.js';

export class NotImplementedError extends Error {
    constructor(adapterName, methodName) {
        super(`${adapterName} does not implement ${methodName}()`);
        this.name = 'NotImplementedError';
    }
}

/**
 * @typedef {'connectionReady'|'trackReceived'|'connectionFailed'} SignalingAdapterEvent
 * Emitted by concrete adapters (via EventEmitter):
 *   - 'connectionReady'   { callId, connectionType }
 *   - 'trackReceived'     { callId, connectionType, track, stream } — WebRTC today;
 *                          a future SIP/RTP adapter would emit an equivalent PCM-producing
 *                          handle here rather than a MediaStreamTrack (see AudioCoordinator's
 *                          PCM seam downstream of RTCAudioSink.ondata in ARCHITECTURE.md).
 *   - 'connectionFailed'  { callId, connectionType, reason }
 */
export class SignalingAdapter extends EventEmitter {
    /** Human-readable name used in NotImplementedError messages. Override in subclasses. */
    get name() {
        return this.constructor.name;
    }

    _notImplemented(methodName) {
        throw new NotImplementedError(this.name, methodName);
    }

    // ── Connection lifecycle — mirrors PeerRegistry ─────────────────────────

    /**
     * Get the existing leg for (callId, connectionType) or create a new one.
     * Mirrors `peerRegistry.getOrCreateConnection(callId, connectionType)`.
     * @returns {{ connectionData: object, reused: boolean }}
     */
    getOrCreateConnection(callId, connectionType) {
        this._notImplemented('getOrCreateConnection');
    }

    /**
     * Look up an existing leg without creating one.
     * Mirrors `peerRegistry.getConnectionData(callId, connectionType, requireReady)`.
     * @returns {{ valid: true, data: object } | { valid: false, reason: string }}
     */
    getConnectionData(callId, connectionType, requireReady = false) {
        this._notImplemented('getConnectionData');
    }

    /**
     * Tear down one leg, or every leg of a call when connectionType is omitted.
     * Mirrors `peerRegistry.closePeerConnection(callId, connectionType)`.
     * @returns {Promise<boolean>}
     */
    async closeConnection(callId, connectionType = null) {
        this._notImplemented('closeConnection');
    }

    // ── SDP / offer-answer negotiation — mirrors SDPCoordinator ─────────────

    /**
     * Create a local offer for a new leg.
     * Mirrors `sdpCoordinator.createSDPOffer(callId, connectionType, callEventHandler)`.
     * @param {{ onEventSubscribe?: Function }} [opts] - callback to subscribe this leg
     *   to call-scoped events, matching SDPCoordinator's optional `callEventHandler` param.
     * @returns {Promise<string>} local offer (SDP string for WebRTC; adapter-defined for others)
     */
    async createOffer(callId, connectionType, opts = {}) {
        this._notImplemented('createOffer');
    }

    /**
     * Create a local answer in response to a remote offer.
     * Mirrors `sdpCoordinator.createSDPAnswer(callId, sdpOffer, connectionType)`.
     * @returns {Promise<string>} local answer
     */
    async createAnswer(callId, remoteOffer, connectionType) {
        this._notImplemented('createAnswer');
    }

    /**
     * Apply a remote answer to a leg this adapter offered.
     * Mirrors `sdpCoordinator.processSDPAnswer(callId, sdpAnswer, connectionType)`.
     * @returns {Promise<void>}
     */
    async processAnswer(callId, remoteAnswer, connectionType) {
        this._notImplemented('processAnswer');
    }

    // ── Candidate / transport-readiness exchange — mirrors ICECandidateCoordinator ──

    /**
     * Feed a remote-provided candidate into this leg.
     * Mirrors `iceCoordinator.handleInboundCandidate(pc, candidate, callId, connectionType)`.
     * For transports without trickle ICE (e.g. a SIP trunk, where RTP endpoints are
     * negotiated directly in the SDP body), implementations should treat this as a no-op.
     * @returns {Promise<boolean>} whether the candidate was accepted/buffered
     */
    async addRemoteCandidate(callId, connectionType, candidate) {
        this._notImplemented('addRemoteCandidate');
    }

    /**
     * Register the transport reference (e.g. a socket id) outbound candidates/events
     * for this call should be dispatched to.
     * Mirrors `iceCoordinator.setConnectionInfo(callId, connectionType, socketId)`.
     */
    setConnectionInfo(callId, connectionType, transportRef) {
        this._notImplemented('setConnectionInfo');
    }

    /**
     * Signal that the remote side is ready to receive buffered outbound candidates/events.
     * Mirrors `iceCoordinator.markClientReady(callId)`.
     */
    markClientReady(callId) {
        this._notImplemented('markClientReady');
    }
}
