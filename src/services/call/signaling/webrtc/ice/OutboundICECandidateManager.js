// services/calling/OutboundICECandidateManager.js
/**
 * OutboundICECandidateManager
 *
 * Manages outbound ICE candidates (server -> client). Coordinates buffering
 * and dispatching based on client readiness state.
 */

export class OutboundICECandidateManager {
    constructor(buffer, dispatcher) {
        this.buffer = buffer;
        this.dispatcher = dispatcher;
        this.connectionInfo = new Map(); // callId -> { connectionType, socketId }
    }

    setConnectionInfo(callId, connectionType, socketId) {
        this.connectionInfo.set(callId, { connectionType, socketId });
    }

    getConnectionInfo(callId) {
        return this.connectionInfo.get(callId) ?? null;
    }

    handleCandidate(callId, candidate) {
        const info = this.connectionInfo.get(callId);

        if (this.buffer.isReady(callId)) {
            this.dispatcher.dispatch(callId, candidate, info?.connectionType, info?.socketId);
        } else {
            this.buffer.buffer(callId, candidate);
        }
    }

    markClientReady(callId) {
        const wasNotReady = this.buffer.markReady(callId);

        if (wasNotReady) {
            const bufferedCandidates = this.buffer.flush(callId);
            const info = this.connectionInfo.get(callId);

            if (bufferedCandidates.length > 0) {
                this.dispatcher.dispatchBatch(callId, bufferedCandidates, info?.connectionType, info?.socketId);
            }
        }
    }

    cleanup(callId) {
        this.buffer.cleanup(callId);
        this.connectionInfo.delete(callId);
    }
}
