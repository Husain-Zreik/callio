// src/core/events/handlers/ConnectionEventHandler.js
import CallRepository from '../../../persistence/CallRepository.js';
import { callLifecycleLogger } from '../../calls/CallLifecycleLogger.js';
import { peerRegistry } from '../../../media/webrtc/PeerRegistry.js';
import { callTerminator } from '../../calls/CallTerminator.js';
import { audioCoordinator } from '../../../media/bridge/AudioCoordinator.js';
import { iceCoordinator } from '../../../media/webrtc/ice/ICECandidateCoordinator.js';
import { TerminationReason, TerminatedBy } from '../../constants/CallConstants.js';

// How long (ms) to wait for agent reconnect before terminating the call.
const RECONNECT_TIMEOUT_MS = 120_000;

export class ConnectionEventHandler {
    constructor() {
        this._reconnectTimers = new Map(); // callId -> timeoutId
    }

    clearReconnectTimer(callId) {
        const timerId = this._reconnectTimers.get(callId);
        if (timerId !== undefined) {
            clearTimeout(timerId);
            this._reconnectTimers.delete(callId);
            console.log(`[ConnectionEventHandler] ⏱️ Reconnect timer cleared for call ${callId}`);
        }
    }

    async handleFrontendDisconnected(data) {
        const { callId, userId } = data;

        // Defense in depth alongside RoomManager.removeUserFromCallRoom now
        // actively clearing socket.callId on transfer: that clear depends on
        // fetchSockets()/serverSideEmit succeeding (a Redis round-trip), so
        // there's still a residual window (adapter hiccup, or any other path
        // that leaves a stale binding) where this event can arrive for a
        // user who is no longer this call's assigned agent. Trust a fresh DB
        // read over the event's own claimed state — mirrors
        // RejectionEventHandler.handleCallRejected's own stale-event guard.
        // Without this, a stale FRONTEND_DISCONNECTED injects a "reconnecting"
        // beep into the live customer audio and starts a 120s countdown to
        // wrongfully terminating a healthy call and releasing the wrong agent.
        if (userId) {
            const call = await CallRepository.findById(callId);
            if (!call || String(call.agent_id) !== String(userId)) {
                console.log(`[ConnectionEventHandler] Ignoring stale FRONTEND_DISCONNECTED for call ${callId} — user ${userId} is not the current assigned agent`);
                return;
            }
        }

        console.log(`[ConnectionEventHandler] Frontend disconnected for call ${callId}`);

        callLifecycleLogger.logDisconnected(callId, data.tenantId, userId ?? null, {
            reason: data.reason ?? 'disconnect',
        }).catch(() => {});

        try {
            await audioCoordinator.handleFrontendDisconnected(callId);
        } catch (error) {
            console.error(`[ConnectionEventHandler] Failed to attach beep for call ${callId}:`, error.message);
        }

        this.clearReconnectTimer(callId);
        const timerId = setTimeout(async () => {
            this._reconnectTimers.delete(callId);
            console.warn(`[ConnectionEventHandler] ⚠️ Agent did not reconnect within ${RECONNECT_TIMEOUT_MS / 1000}s for call ${callId} — terminating`);
            try {
                // The agent is gone (browser closed, network died): end the call,
                // tell the provider so the customer isn't left on a dead line, and
                // release the agent OFFLINE — AVAILABLE would put an absent agent
                // back into routing. A no-op if the call already ended meanwhile.
                const call = await CallRepository.findById(callId);
                if (!call) return;
                await callTerminator.end(call, {
                    reason: TerminationReason.AGENT_DISCONNECTED,
                    terminatedBy: TerminatedBy.SYSTEM,
                    provider: 'terminate',
                    source: 'agent_disconnect_timeout',
                    agentAfter: 'offline',
                });
            } catch (err) {
                console.error(`[ConnectionEventHandler] Failed to end call ${callId} after the agent disconnected:`, err);
            }
        }, RECONNECT_TIMEOUT_MS);
        this._reconnectTimers.set(callId, timerId);
    }

    async handleICECandidate(data) {
        const { callId, candidate, connectionType } = data;

        console.log(`[ConnectionEventHandler] ICE candidate for ${connectionType} on call ${callId}`);

        try {
            const result = peerRegistry.getConnectionData(callId, connectionType);
            await iceCoordinator.handleInboundCandidate(
                result.valid ? result.data.pc : null,
                candidate, callId, connectionType
            );
        } catch (error) {
            console.error(`[ConnectionEventHandler] Failed to handle ICE candidate for call ${callId}:`, error.message);
        }
    }
}
