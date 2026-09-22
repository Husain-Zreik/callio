// services/call/signaling/webrtc/Peer.js
// Per-connection WebRTC peer lifecycle, SDP state, and WhatsApp flags.
// Replaces ConnectionData.js — depends on a shared CallContext and per-connection AudioTrackState.
import CallConnectionRepository from '../../../../repositories/CallConnectionRepository.js';
import CallRepository from '../../../../repositories/CallRepository.js';
import { ConnectionType } from '../../constants/CallConstants.js';
import { AudioTrackState } from './AudioTrackState.js';
import { placeholderTrackFactory } from '../../audio/PlaceholderTrackFactory.js';

export class Peer {
    constructor(pc, connectionType, callContext) {
        if (!pc) throw new Error('Peer requires a peer connection');
        if (!Object.values(ConnectionType).includes(connectionType))
            throw new Error(`Invalid connectionType: ${connectionType}`);
        if (!callContext) throw new Error('Peer requires a CallContext');

        this.pc = pc;
        this.connectionId = null;
        this.connectionType = connectionType;
        this.context = callContext;  // shared CallContext reference
        this.audio = new AudioTrackState();

        this.isReady = false;
        this.sdpType = null;
        this.localSdp = null;
        this.remoteSdp = null;
        this.whatsappTriggering = false;
        this.whatsappTriggered = false;
        this.whatsappConnected = false;

        console.log(`${connectionType} connection created for call ${callContext.callId}`);
    }

    // ── Convenience getters ────────────────────────────────────────────────────

    get callId() { return this.context.callId; }
    get isMonitor() { return this.connectionType === ConnectionType.MONITOR; }
    get isFrontend() { return this.connectionType === ConnectionType.FRONTEND; }
    get isWhatsapp() { return this.connectionType === ConnectionType.WHATSAPP; }

    // ── Boolean state setters ──────────────────────────────────────────────────

    setReady(v) { this.isReady = Boolean(v); }
    setWhatsappTriggering(v) { this.whatsappTriggering = Boolean(v); }
    setWhatsappTriggered(v) { this.whatsappTriggered = Boolean(v); }
    setWhatsappConnected(v) { this.whatsappConnected = Boolean(v); }

    // ── Audio proxy methods (backward-compat shims → conn.audio.*) ─────────────

    get hasRealTrack() { return this.audio.hasRealTrack; }
    get placeholderSenders() { return this.audio.placeholderSenders; }
    get trackBuffer() { return this.audio.trackBuffer; }
    set trackBuffer(v) { this.audio.trackBuffer = v; }

    setHasRealTrack(v) { this.audio.setHasRealTrack(v); }
    addPlaceholderSender(sender) { this.audio.addPlaceholderSender(sender); }
    getActivePlaceholderSender() { return this.audio.getActivePlaceholderSender(); }
    shiftPlaceholderSender() { return this.audio.shiftPlaceholderSender(); }
    clearPlaceholderSenders() { this.audio.clearPlaceholderSenders(); }

    // ── Track delivery ────────────────────────────────────────────────────────

    /**
     * Deliver a real audio track to this peer, replacing the placeholder sender
     * if one is queued, or adding a new sender otherwise.
     * Encapsulates all audio-state mutation so bridges never reach into Peer internals.
     */
    deliverTrack(track, stream) {
        const activeSender = this.audio.getActivePlaceholderSender();
        try {
            if (activeSender && !this.audio.hasRealTrack) {
                const displaced = activeSender._placeholderTrack;
                activeSender.replaceTrack(track);
                activeSender._placeholderTrack = null;
                // The placeholder tone is now detached from the sender — stop its
                // interval and release the native RTCAudioSource right away.
                placeholderTrackFactory.releaseGeneratedTrack(displaced);
                this.audio.setHasRealTrack(true);
            } else if (!activeSender) {
                const sender = this.pc.addTrack(track, stream);
                this.audio.addPlaceholderSender(sender);
                this.audio.setHasRealTrack(true);
            } else {
                activeSender.replaceTrack(track);
            }
        } catch (error) {
            console.error(`[Peer] deliverTrack failed for call ${this.context.callId}: ${error.message}`);
        }
    }

    /**
     * Relay a track to a monitor connection — shifts (not peeks) the next queued
     * placeholder sender and replaces it, or adds directly if none available.
     */
    deliverMonitorTrack(track) {
        const sender = this.audio.getActivePlaceholderSender();
        try {
            if (sender) {
                sender.replaceTrack(track);
                this.audio.shiftPlaceholderSender();
            } else {
                this.pc.addTrack(track);
            }
        } catch (error) {
            console.error(`[Peer] deliverMonitorTrack failed for call ${this.context.callId}: ${error.message}`);
        }
    }

    // ── SDP setters ───────────────────────────────────────────────────────────

    setSdp({ type, local, remote }) {
        if (type) {
            const t = type.toUpperCase();
            if (!['OFFER', 'ANSWER'].includes(t)) throw new Error(`Invalid SDP type: ${type}`);
            this.sdpType = t;
        }
        if (local) this.localSdp = local;
        if (remote) this.remoteSdp = remote;
    }

    /**
     * Merge call business data into the shared CallContext.
     * Accepts the same shape as the old ConnectionData.setCallData().
     */
    setCallData(data = {}) {
        this.context.update(data);
    }

    setWacid(wacid) {
        this.context.setWacid(wacid);
    }

    // ── DB operations ─────────────────────────────────────────────────────────

    async insertConnectionRecord() {
        try {
            // Fast path: reuse an already-existing row without the businessId
            // lookup/write below. This SELECT can still race a concurrent
            // caller's SELECT (both see nothing, both fall through) — that's
            // fine, CallConnectionRepository.create() below is an atomic
            // upsert (unique index on call_id+connection_type), so the loser
            // of that race gets the winner's row id back instead of creating
            // a duplicate row.
            const existing = await CallConnectionRepository.findByCallAndType(
                this.context.callId,
                this.connectionType
            );

            if (existing) {
                this.connectionId = existing.id;
                console.log(`Existing connection record used: ${this.connectionId}`);
                return;
            }

            // Use the businessId already on the context when available to avoid
            // an extra round-trip; fall back to a DB lookup only when needed.
            const businessId = this.context.businessId
                ?? (await CallRepository.findById(this.context.callId))?.business_id
                ?? null;

            const { id } = await CallConnectionRepository.create({
                call_id: this.context.callId,
                business_id: businessId,
                connection_type: this.connectionType,
            });

            this.connectionId = id;
            console.log(`Connection record created: ${this.connectionId}`);

        } catch (error) {
            console.error(`Connection record insert failed: ${error.message}`);
        }
    }

    async cleanup() {
        // Close peer connection
        if (this.pc && this.pc.signalingState !== 'closed') {
            this.pc.close();
        }
        // Null the reference immediately so V8 can GC the RTCPeerConnection wrapper
        // in the same collection cycle that reclaims this Peer.  wrtc spawns OS threads
        // (libjingle worker pool + audio thread) that are only destroyed when the C++
        // destructor runs — which requires the JS wrapper to be collected.  Holding
        // this.pc after close() delays that by one or more GC cycles, causing the
        // thread count to drift upward over many calls.
        this.pc = null;

        // Stop all placeholder audio intervals and clear the sender list
        this.audio.clearPlaceholderSenders();
        this.audio.clearTrackBuffer();

        // Reset internal state
        this.isReady = false;

        if (this.isMonitor) {
            await CallConnectionRepository.cleanupConnection(this.context.callId, this.connectionType)
                .catch(err => console.error('Failed to delete connection in DB:', err));
        } else {
            // terminateConnection takes this row's own id (connectionId), not
            // the call's id — unlike cleanupConnection above, which is
            // call_id-scoped. Passing context.callId here (a calls.id value)
            // into a `WHERE id = ?` lookup meant this almost never matched
            // this connection's own row, and could occasionally match and
            // overwrite an unrelated older call's row that happened to share
            // that numeric id.
            await CallConnectionRepository.terminateConnection(this.connectionId, this.connectionType)
                .catch(err => console.error('Failed to terminate connection in DB:', err));
        }

        console.log(`Peer cleanup done for call ${this.context.callId}`);
    }
}
