// services/calling/ICECandidateManager.js
/**
 * ICECandidateManager
 *
 * Manages inbound ICE candidates (client -> server). Handles two-stage buffering:
 * 1. Pre-connection: candidates arrive before peer connection exists
 * 2. Post-connection: candidates arrive before remote description is set
 */

import wrtc from '@roamhq/wrtc';
import CallConnectionRepository from '../../../../../repositories/CallConnectionRepository.js';

export class ICECandidateManager {
    constructor(preConnectionBuffer) {
        this.preConnectionBuffer = preConnectionBuffer;
        this.postConnectionBuffer = new Map(); // Map: "callId-connectionType" -> candidate[]
    }

    async addCandidate(peerConnection, candidateData, callId, connectionType) {
        try {
            await CallConnectionRepository.addICECandidate(callId, connectionType, candidateData);

            if (!peerConnection) {
                console.warn(`No peer connection for ${connectionType} [${callId}] - should have been pre-buffered`);
                return false;
            }

            if (!peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
                if (peerConnection.signalingState === 'closed') return false;
                const key = `${callId}-${connectionType}`;
                if (!this.postConnectionBuffer.has(key)) {
                    this.postConnectionBuffer.set(key, []);
                }
                this.postConnectionBuffer.get(key).push(candidateData);
                return true;
            }

            const rtcCandidate = new wrtc.RTCIceCandidate(candidateData);
            await peerConnection.addIceCandidate(rtcCandidate);
            return true;

        } catch (error) {
            console.error(`Failed to add ICE candidate to ${connectionType}: ${error.message}`);
            return false;
        }
    }

    async flushPreConnectionCandidates(peerConnection, callId, connectionType) {
        const preCandidates = this.preConnectionBuffer.flush(callId, connectionType);

        if (preCandidates.length === 0) {
            return;
        }

        for (const candidate of preCandidates) {
            await this.addCandidate(peerConnection, candidate, callId, connectionType);
        }
    }

    async flushPostConnectionCandidates(peerConnection, callId, connectionType) {
        const key = `${callId}-${connectionType}`;
        const bufferedCandidates = this.postConnectionBuffer.get(key);

        if (!bufferedCandidates || bufferedCandidates.length === 0) {
            return;
        }

        if (!peerConnection) {
            console.warn(`Cannot flush candidates: no peer connection for ${connectionType}`);
            return;
        }

        if (!peerConnection.remoteDescription || peerConnection.signalingState !== 'stable') {
            return;
        }

        for (const candidate of bufferedCandidates) {
            try {
                const rtcCandidate = new wrtc.RTCIceCandidate(candidate);
                await peerConnection.addIceCandidate(rtcCandidate);
            } catch (error) {
                // ICE candidate failures are normal in WebRTC
            }
        }

        this.postConnectionBuffer.delete(key);
    }

    clearBuffer(callId, connectionType = null) {
        if (connectionType) {
            const key = `${callId}-${connectionType}`;
            this.postConnectionBuffer.delete(key);
        } else {
            for (const key of this.postConnectionBuffer.keys()) {
                if (key.startsWith(`${callId}-`)) {
                    this.postConnectionBuffer.delete(key);
                }
            }
        }
    }

    cleanup(callId) {
        this.clearBuffer(callId);
        this.preConnectionBuffer.cleanup(callId);
    }
}
