// services/calling/PreConnectionICEBuffer.js
/**
 * PreConnectionICEBuffer
 *
 * Buffers ICE candidates that arrive before the peer connection is created.
 * This solves the race condition where candidates are sent from the client
 * before the server has initialized the corresponding RTCPeerConnection.
 */

export class PreConnectionICEBuffer {
    constructor() {
        this.buffer = new Map(); // Map: "callId:connectionType" -> candidate[]
    }

    add(callId, connectionType, candidate) {
        const key = `${callId}:${connectionType}`;

        if (!this.buffer.has(key)) {
            this.buffer.set(key, []);
        }

        this.buffer.get(key).push(candidate);
    }

    flush(callId, connectionType) {
        const key = `${callId}:${connectionType}`;
        const candidates = this.buffer.get(key) || [];
        this.buffer.delete(key);
        return candidates;
    }

    hasCandidates(callId, connectionType) {
        const key = `${callId}:${connectionType}`;
        return this.buffer.has(key) && this.buffer.get(key).length > 0;
    }

    count(callId, connectionType) {
        const key = `${callId}:${connectionType}`;
        return this.buffer.get(key)?.length || 0;
    }

    cleanup(callId, connectionType = null) {
        if (connectionType) {
            const key = `${callId}:${connectionType}`;
            this.buffer.delete(key);
        } else {
            for (const key of this.buffer.keys()) {
                if (key.startsWith(`${callId}:`)) {
                    this.buffer.delete(key);
                }
            }
        }
    }
}
