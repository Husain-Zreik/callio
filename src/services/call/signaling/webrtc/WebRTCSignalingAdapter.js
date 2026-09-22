// services/call/signaling/webrtc/WebRTCSignalingAdapter.js
//
// Concrete SignalingAdapter for WebRTC — today's (only) transport. Pure facade:
// every method is a one-line delegation to the existing `sdpCoordinator`,
// `peerRegistry`, and `iceCoordinator` singletons, which live alongside this
// file in this folder. No logic is duplicated or altered here, and nothing
// outside `signaling/` imports this adapter yet — introducing it changes no
// runtime behavior (see ARCHITECTURE.md "Signaling Adapter Layer"). Wiring
// real call sites to go through this adapter instead of the singletons
// directly is a future pass.
import { SignalingAdapter } from '../SignalingAdapter.js';
import { peerRegistry } from './PeerRegistry.js';
import { sdpCoordinator } from './SDPCoordinator.js';
import { iceCoordinator } from './ice/ICECandidateCoordinator.js';
import { peerEventManager } from './PeerEventManager.js';

export class WebRTCSignalingAdapter extends SignalingAdapter {
    constructor() {
        super();
        // Re-emit PeerEventManager's connection lifecycle events under this
        // adapter's own port-level event names, so a consumer of the port
        // never needs to know PeerEventManager exists.
        peerEventManager.on('connectionReady', (data) => this.emit('connectionReady', data));
        peerEventManager.on('trackReceived', (data) => this.emit('trackReceived', data));
    }

    getOrCreateConnection(callId, connectionType) {
        return peerRegistry.getOrCreateConnection(callId, connectionType);
    }

    getConnectionData(callId, connectionType, requireReady = false) {
        return peerRegistry.getConnectionData(callId, connectionType, requireReady);
    }

    async closeConnection(callId, connectionType = null) {
        return peerRegistry.closePeerConnection(callId, connectionType);
    }

    async createOffer(callId, connectionType, { onEventSubscribe } = {}) {
        return sdpCoordinator.createSDPOffer(callId, connectionType, onEventSubscribe ?? null);
    }

    async createAnswer(callId, remoteOffer, connectionType) {
        return sdpCoordinator.createSDPAnswer(callId, remoteOffer, connectionType);
    }

    async processAnswer(callId, remoteAnswer, connectionType) {
        return sdpCoordinator.processSDPAnswer(callId, remoteAnswer, connectionType);
    }

    async addRemoteCandidate(callId, connectionType, candidate) {
        const result = peerRegistry.getConnectionData(callId, connectionType);
        const pc = result.valid ? result.data.pc : null;
        return iceCoordinator.handleInboundCandidate(pc, candidate, callId, connectionType);
    }

    setConnectionInfo(callId, connectionType, transportRef) {
        return iceCoordinator.setConnectionInfo(callId, connectionType, transportRef);
    }

    markClientReady(callId) {
        return iceCoordinator.markClientReady(callId);
    }
}

export const webRTCSignalingAdapter = new WebRTCSignalingAdapter();
