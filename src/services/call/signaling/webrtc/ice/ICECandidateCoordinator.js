// services/calling/ICECandidateCoordinator.js
/**
 * ICECandidateCoordinator
 *
 * Central coordinator for all ICE candidate management (both inbound and outbound).
 * Provides a clean API to CallManager, hiding internal buffering and dispatching complexity.
 * This is the single entry point for all ICE-related operations.
 */

import { OutboundICECandidateManager } from './OutboundICECandidateManager.js';
import { OutboundICECandidateBuffer } from './OutboundICECandidateBuffer.js';
import { PreConnectionICEBuffer } from './PreConnectionICEBuffer.js';
import { ICECandidateDispatcher } from './ICECandidateDispatcher.js';
import { ICECandidateManager } from './ICECandidateManager.js';

export class ICECandidateCoordinator {
    constructor() {
        this.preConnectionBuffer = new PreConnectionICEBuffer();
        this.outboundBuffer = new OutboundICECandidateBuffer();
        this.dispatcher = new ICECandidateDispatcher();

        this.inboundManager = new ICECandidateManager(this.preConnectionBuffer);
        this.outboundManager = new OutboundICECandidateManager(this.outboundBuffer, this.dispatcher);
    }

    async handleInboundCandidate(peerConnection, candidate, callId, connectionType) {
        if (!peerConnection) {
            this.preConnectionBuffer.add(callId, connectionType, candidate);
            return true;
        }

        return await this.inboundManager.addCandidate(peerConnection, candidate, callId, connectionType);
    }

    handleOutboundCandidate(callId, candidate, connectionType) {
        this.outboundManager.handleCandidate(callId, candidate);
    }

    setConnectionInfo(callId, connectionType, socketId) {
        this.outboundManager.setConnectionInfo(callId, connectionType, socketId);
    }

    getConnectionInfo(callId) {
        return this.outboundManager.getConnectionInfo(callId);
    }

    markClientReady(callId) {
        this.outboundManager.markClientReady(callId);
    }

    resetOutbound(callId) {
        this.outboundManager.cleanup(callId);
    }

    async flushPreConnectionCandidates(peerConnection, callId, connectionType) {
        await this.inboundManager.flushPreConnectionCandidates(peerConnection, callId, connectionType);
    }

    async flushPostConnectionCandidates(peerConnection, callId, connectionType) {
        await this.inboundManager.flushPostConnectionCandidates(peerConnection, callId, connectionType);
    }

    cleanup(callId) {
        this.inboundManager.cleanup(callId);
        this.outboundManager.cleanup(callId);
    }
}

export const iceCoordinator = new ICECandidateCoordinator();
