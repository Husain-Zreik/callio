// services/call/events/handlers/ConnectionEventHandler.js
import CallRepository from '../../../../repositories/CallRepository.js';
import { callLifecycleLogger } from '../../lifecycle/CallLifecycleLogger.js';
import { peerRegistry } from '../../signaling/webrtc/PeerRegistry.js';
import { audioCoordinator } from '../../audio/AudioCoordinator.js';
import { iceCoordinator } from '../../signaling/webrtc/ice/ICECandidateCoordinator.js';
import { agentAssignmentCoordinator } from '../../assignment/AgentAssignmentCoordinator.js';
import { TerminationReason, TerminatedBy } from '../../constants/CallConstants.js';
import EventBus from '../../../core/EventBus.js';

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
            if (!call || String(call.user_id) !== String(userId)) {
                console.log(`[ConnectionEventHandler] Ignoring stale FRONTEND_DISCONNECTED for call ${callId} — user ${userId} is not the current assigned agent`);
                return;
            }
        }

        console.log(`[ConnectionEventHandler] Frontend disconnected for call ${callId}`);

        callLifecycleLogger.logDisconnected(callId, data.businessId, userId ?? null, {
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
                // terminateCallIfNotTerminated (not terminateCall) so we know whether
                // this path won the race. If the customer hung up during the 120s window
                // the webhook already finalized the row — committed=false in that case,
                // and we skip both the agent release and the frontend notification.
                const committed = await CallRepository.terminateCallIfNotTerminated(
                    callId, TerminationReason.AGENT_DISCONNECTED, TerminatedBy.SYSTEM
                );
                await peerRegistry.closePeerConnection(callId);

                if (committed) {
                    // Release the agent to OFFLINE — they're gone (browser closed, network
                    // died). AVAILABLE would mistakenly make them eligible for the queue.
                    if (userId) {
                        try {
                            await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(userId);
                        } catch (releaseErr) {
                            console.error(
                                `[ConnectionEventHandler] ⚠️ AGENT STUCK: Failed to release agent ${userId} after disconnect-timeout for call ${callId}:`,
                                releaseErr.message
                            );
                        }
                    }

                    // Notify the business room (managers/supervisors monitoring the call).
                    // Previously the webhook's unconditional EventBus.emit served this role,
                    // but that path is now gated on finalizedByThisWebhook. The notification
                    // must be explicit here so the frontend closes the call UI promptly.
                    if (data.businessId) {
                        EventBus.emit('call:terminated', {
                            callId,
                            businessId: data.businessId,
                            reason: TerminationReason.AGENT_DISCONNECTED,
                            terminatedBy: TerminatedBy.SYSTEM,
                        });
                    }
                }
            } catch (err) {
                console.error(`[ConnectionEventHandler] ❌ Failed to auto-terminate call ${callId}:`, err.message);
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
