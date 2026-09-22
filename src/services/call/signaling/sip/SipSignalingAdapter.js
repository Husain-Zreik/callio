// services/call/signaling/sip/SipSignalingAdapter.js
//
// Stub SignalingAdapter for a SIP trunk/carrier (e.g. Twilio, Telnyx, a generic
// ITSP). Not implemented — every method documents intended SIP-trunk semantics
// and throws. This exists to validate the SignalingAdapter port shape against a
// second, structurally different transport before any WebRTC call site is
// migrated to depend on the port (see ARCHITECTURE.md "Signaling Adapter Layer").
//
// Media model, once implemented: a SIP trunk negotiates a static RTP
// send/receive endpoint per call leg directly in the SDP carried inside SIP
// messages — there is no trickle ICE, so `addRemoteCandidate` below is
// intentionally a no-op rather than an error. Actual audio would need a raw
// RTP send/receive path (via an external media proxy, e.g. rtpengine/FreeSWITCH,
// or a Node RTP library), feeding PCM frames into the same seam WebRTC already
// uses downstream of `RTCAudioSink.ondata` today — `MixingRelay._mixInto`,
// `AudioCaptureService` → `StereoMixBuffer` → `OpusEncoder`, and
// `DTMFCaptureService` are already transport-agnostic PCM consumers once frames
// reach them. The SIP stack/library choice and the RTP media path are deferred
// to the pass that actually implements this adapter.
import { SignalingAdapter } from '../SignalingAdapter.js';

export class SipSignalingAdapter extends SignalingAdapter {
    get name() {
        return 'SipSignalingAdapter';
    }

    // A SIP "connection" is a dialog identified by Call-ID/tags, not a
    // long-lived native object like RTCPeerConnection — getOrCreateConnection
    // would register/return that dialog's tracking state.
    getOrCreateConnection(callId, connectionType) {
        this._notImplemented('getOrCreateConnection');
    }

    getConnectionData(callId, connectionType, requireReady = false) {
        this._notImplemented('getConnectionData');
    }

    // Intended to send a SIP BYE (or CANCEL if pre-answer) and release the RTP port pair.
    async closeConnection(callId, connectionType = null) {
        this._notImplemented('closeConnection');
    }

    // Intended to send a SIP INVITE with the local SDP offer in the message body.
    async createOffer(callId, connectionType, opts = {}) {
        this._notImplemented('createOffer');
    }

    // Intended to reply to an inbound INVITE with a 200 OK carrying the local SDP answer.
    async createAnswer(callId, remoteOffer, connectionType) {
        this._notImplemented('createAnswer');
    }

    // Intended to apply the SDP carried in a 200 OK response and send the ACK.
    async processAnswer(callId, remoteAnswer, connectionType) {
        this._notImplemented('processAnswer');
    }

    // No-op by design once implemented: SIP trunks negotiate RTP endpoints via
    // SDP directly, there is no trickle-ICE candidate exchange to feed.
    async addRemoteCandidate(callId, connectionType, candidate) {
        this._notImplemented('addRemoteCandidate');
    }

    // Intended to record which internal transport (e.g. the SIP dialog's socket/UDP
    // association) outbound signaling for this call should use.
    setConnectionInfo(callId, connectionType, transportRef) {
        this._notImplemented('setConnectionInfo');
    }

    // SIP trunks have no trickle-ICE readiness handshake; likely a no-op once
    // implemented, kept as a real method so callers don't need to branch on transport.
    markClientReady(callId) {
        this._notImplemented('markClientReady');
    }
}

export const sipSignalingAdapter = new SipSignalingAdapter();
