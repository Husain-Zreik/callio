// services/calling/ICECandidateDispatcher.js
/**
 * ICECandidateDispatcher
 *
 * Responsible for dispatching outbound ICE candidates to clients via EventBus.
 * Abstracts the transport layer (WebSocket/EventBus) from the ICE management logic.
 */

import { roomManager } from "../../../../../websocket/managers/RoomManager.js";

export class ICECandidateDispatcher {
    dispatch(callId, candidate, connectionType, socketId) {
        roomManager.emitToSocket(socketId, 'connection:ice-candidate:server', {
            callId,
            candidate: {
                candidate: candidate.candidate,
                sdpMLineIndex: candidate.sdpMLineIndex,
                sdpMid: candidate.sdpMid
            },
            connectionType
        });
    }

    dispatchBatch(callId, candidates, connectionType, socketId) {
        if (!candidates || candidates.length === 0) {
            return 0;
        }

        candidates.forEach(candidate => {
            this.dispatch(callId, candidate, connectionType, socketId);
        });

        return candidates.length;
    }
}
