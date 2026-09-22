// services/call/events/handlers/AgentEventHandler.js
import CallRepository from '../../../../repositories/CallRepository.js';
import AgentRepository from '../../../../repositories/AgentRepository.js';
import BusinessRepository from '../../../../repositories/BusinessRepository.js';
import CallConnectionRepository from '../../../../repositories/CallConnectionRepository.js';
import { acceptWhatsAppCall, terminateWhatsAppCall } from '../../signaling/webrtc/WhatsAppCallApi.js';
import EventBus from '../../../core/EventBus.js';
import { callLifecycleLogger } from '../../lifecycle/CallLifecycleLogger.js';
import { peerRegistry } from '../../signaling/webrtc/PeerRegistry.js';
import { peerEventManager } from '../../signaling/webrtc/PeerEventManager.js';
import { sdpCoordinator } from '../../signaling/webrtc/SDPCoordinator.js';
import { iceCoordinator } from '../../signaling/webrtc/ice/ICECandidateCoordinator.js';
import { emitCallError } from '../CallErrorEmitter.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { ConnectionType, CallStatus, CallDirection, TerminationReason, TerminatedBy } from '../../constants/CallConstants.js';
import { agentAssignmentCoordinator } from '../../assignment/AgentAssignmentCoordinator.js';
import { agentMissedCallTracker } from '../../../redis/AgentMissedCallTracker.js';
import { roomManager } from '../../../../websocket/managers/RoomManager.js';
import { notifyCallResolved } from '../../../../websocket/namespaces/call/handlers/delivery.js';

// Max wait for the agent's inbound audio track to arrive on the FRONTEND peer
// before we tell Meta "accepted". Empirically the ontrack dispatch lands within
// ~100-800 ms after processSDPAnswer on a healthy connection; 5 s is generous
// headroom for slow networks, but bounded so we fail-fast on "mic denied" /
// "bad SDP" scenarios instead of accepting with a broken uplink.
const AGENT_AUDIO_TRACK_TIMEOUT_MS = 5000;

export class AgentEventHandler {

    async handleAgentJoined(data) {
        const { callId, userId, businessId, sdpAnswer, socketId, deviceId } = data;

        console.log(`[AgentEventHandler] Agent ${userId} joined call ${callId}`, { socketId });

        // Guard: only the worker owning the in-memory peer connection should handle this.
        const ownsConnection = peerRegistry.getConnectionData(callId, ConnectionType.FRONTEND).valid;
        if (!ownsConnection) {
            console.log(`[AgentEventHandler] Worker does not own peer connection for call ${callId} — skipping`);
            return;
        }

        try {
            // For non-call-center businesses enforce the 1-IN_PROGRESS-per-business rule
            // at accept time. This catches the window where a second inbound call arrived
            // while the first was already IN_PROGRESS and a different user tries to accept it.
            const isCallCenter = await BusinessRepository.isCallCentered(businessId);
            if (!isCallCenter) {
                const activeExists = await CallRepository.hasOtherActiveCall(businessId, callId);
                if (activeExists) throw new Error('A call is already active for this business.');
            } else {
                // For call-center businesses, guard at the per-agent level: an agent must not
                // accept a second call while already on an active one. This is the final safety
                // net after the batchUpdateAgentAvailability guard in the cleanup service.
                const agentHasActiveCall = await CallRepository.hasAgentActiveCall(userId, callId);
                if (agentHasActiveCall) throw new Error('Agent already has an active call.');
            }

            // Early-exit before touching the peer connection: if the call is no longer
            // RINGING (terminated between dispatch and now), processSDPAnswer would throw
            // "signalingState is 'closed'" because the peer was already torn down.
            // Exception: IN_PROGRESS is allowed through for transfer accepts — the first
            // agent already answered (status is IN_PROGRESS), but the transferred-to agent
            // still needs their SDP processed and their acceptance logged as inbound_follow_up.
            // The `if (currentStatus === CallStatus.RINGING)` block below is correctly skipped
            // for IN_PROGRESS, so WhatsApp is not re-accepted and the status is not re-set.
            const preGateStatus = await CallRepository.getStatus(callId);
            if (preGateStatus !== CallStatus.RINGING && preGateStatus !== CallStatus.IN_PROGRESS) {
                console.log(
                    `[AgentEventHandler] Call ${callId} no longer RINGING (now=${preGateStatus}) — ` +
                    `skipping accept flow`
                );
                return;
            }

            // Claim ownership before touching the peer connection or calling Meta.
            // Ring-group calls can dispatch to multiple agents; if two send agent_joined
            // near-simultaneously, whichever loses this atomic claim must bail out here —
            // otherwise it goes on to run processSDPAnswer against the FRONTEND peer the
            // winner already holds ("Called in wrong state: stable") and can double-fire
            // acceptWhatsAppCall. Only applies pre-accept (RINGING); the IN_PROGRESS
            // transfer-accept path never owns the call via this check (see comment above).
            if (preGateStatus === CallStatus.RINGING) {
                const claimed = await CallRepository.assignCallToAgentIfEligible(callId, userId);
                if (!claimed) throw new Error('Call assignment conflict. Call ownership changed.');
            }

            iceCoordinator.setConnectionInfo(callId, ConnectionType.FRONTEND, socketId);
            // Durable per-device identity (survives this socket disconnecting/
            // reconnecting) — recorded alongside the ephemeral socketId above so
            // ongoing-calls resync and reconnect-authorization can tell "my other
            // session" apart from "this exact device", which socketId/userId alone
            // can't do. Awaited (unlike this same call's counterpart in
            // handleAgentReconnected, which stays fire-and-forget because it runs
            // after its own row-recreating step) so a resync landing immediately
            // after accept can never read a call still carrying a stale/absent
            // device_id.
            await CallConnectionRepository.updateDeviceId(callId, ConnectionType.FRONTEND, deviceId ?? null)
                .catch((err) => console.error(`[AgentEventHandler] Failed to persist deviceId for call ${callId}:`, err.message));
            await sdpCoordinator.processSDPAnswer(callId, sdpAnswer, ConnectionType.FRONTEND);
            iceCoordinator.markClientReady(callId);

            // ── Gate: wait for the agent's microphone track on the FRONTEND peer ───
            // Previously acceptWhatsAppCall was fired immediately after processSDPAnswer.
            // Meta would then start streaming the customer's audio toward us while our
            // FRONTEND had no inbound audio track yet — client hears nothing back,
            // Meta's "no media received" watchdog kills the call. Waiting here makes
            // sure the uplink is real before we confirm to Meta.
            try {
                await this.#waitForFrontendAudioTrack(callId, AGENT_AUDIO_TRACK_TIMEOUT_MS);
            } catch (waitErr) {
                await this.#abortAcceptOnMediaFailure(callId, userId, waitErr.message);
                throw waitErr;
            }

            // Single read covers both the status check and the IVR-detection that follows,
            // removing the separate getStatus + findById pair.
            const callRecord = await CallRepository.findById(callId);
            const currentStatus = callRecord?.status ?? null;
            const isIvrTransferred = !!callRecord?.ivr_menu_id;

            if (currentStatus === CallStatus.RINGING) {

                if (!isIvrTransferred) {
                    // Skip if the WHATSAPP peer is already fully connected — this happens when an
                    // agent transfer re-routes a call to a new agent after the first agent's accept
                    // already completed. The WhatsApp audio channel is live; we must not re-signal
                    // it with a new SDP answer or we'd issue a redundant Meta API call.
                    // `requireReady=true` uses the registry's isReady flag, which is set only on
                    // connectionState→'connected' — safe to read without touching the wrtc native pc.
                    const whatsappAlreadyReady = peerRegistry.getConnectionData(callId, ConnectionType.WHATSAPP, true).valid;

                    if (!whatsappAlreadyReady) {
                        // Fresh RINGING call — accept WhatsApp now that the agent is ready
                        const whatsappConn = await CallConnectionRepository.findByCallAndType(callId, ConnectionType.WHATSAPP);
                        if (!whatsappConn || !whatsappConn.remote_sdp) throw new Error('WhatsApp offer not found');

                        const whatsappSdpAnswer = await sdpCoordinator.createSDPAnswer(
                            callId, whatsappConn.remote_sdp, ConnectionType.WHATSAPP
                        );
                        await acceptWhatsAppCall(callId, whatsappSdpAnswer);

                        // Guard: verify call wasn't terminated while the API call was in progress
                        const postAcceptStatus = await CallRepository.getStatus(callId);
                        if ([CallStatus.TERMINATED, CallStatus.FAILED].includes(postAcceptStatus)) {
                            throw new Error(`Call already ${postAcceptStatus.toLowerCase()}, cannot accept`);
                        }
                    } else {
                        console.log(`[AgentEventHandler] WhatsApp peer already connected for call ${callId} — skipping re-accept`);
                    }
                } else {
                    console.log(`[AgentEventHandler] IVR-transferred call ${callId} — WhatsApp already accepted, skipping re-accept`);
                }

                const assigned = await CallRepository.assignCallToAgentIfEligible(callId, userId);
                if (!assigned) throw new Error('Call assignment conflict. Call ownership changed.');

                // Guard: only move to IN_PROGRESS if the call hasn't been terminated
                // between the previous guard and now (connect+terminate race window).
                const transitioned = await CallRepository.transitionStatus(callId, CallStatus.RINGING, CallStatus.IN_PROGRESS);
                if (!transitioned) {
                    const nowStatus = await CallRepository.getStatus(callId);
                    throw new Error(`Call status changed to ${nowStatus} before accept could complete`);
                }
                await CallRepository.updateState(callId, 'ACTIVE');
                await CallRepository.updateTimestamp(callId, 'answered_at', new Date());
            }

            const result = peerRegistry.getConnectionData(callId, ConnectionType.FRONTEND);
            if (result.valid) {
                result.data.setWhatsappConnected(true);
                result.data.context.update({ userId, businessId });
            }

            const agentName = await AgentRepository.getUserNameById(userId, businessId);

            const isFollowUp = await callLifecycleLogger.isFollowUp(callId, userId);
            if (isFollowUp) {
                await callLifecycleLogger.logFollowUp(callId, businessId, userId);
            } else {
                await callLifecycleLogger.logAccepted(callId, businessId, userId);
            }

            // The agent is engaged — clear any prior missed-call streak so the
            // auto-offline policy doesn't carry a stale count into their next
            // shift. No-op when the policy is disabled or the key doesn't exist.
            agentMissedCallTracker.reset(userId).catch((err) =>
                console.error(`[AutoOffline] reset streak for agent ${userId} failed:`, err.message)
            );

            EventBus.emit('call:success', { callId, message: 'Call accepted successfully', code: 'CALL_ACCEPTED' });
            EventBus.emit('call:handled', { callId, businessId, userId, agentName, deviceId: deviceId ?? null, action: 'accepted' });

            // Fire-and-forget: dismiss the native ringing UI on this agent's
            // other devices, and (for a broadcast/non-call-center business)
            // every other agent's killed/backgrounded device too — see
            // notifyCallResolved's own doc comment for why call:handled
            // above doesn't already cover this. excludeDeviceId: deviceId is
            // this device — the one that just answered — and must never be a
            // target of its own "dismiss stale ring" fan-out (2026-09-01 fix,
            // see notifyCallResolved's doc comment).
            notifyCallResolved(callId, businessId, userId, { fanOutToBusiness: !isCallCenter, excludeDeviceId: deviceId ?? null }).catch((err) =>
                console.error(`[AgentEventHandler] notifyCallResolved failed for call ${callId}:`, err.message)
            );

            console.log(`[AgentEventHandler] ✅ Agent ${userId} successfully joined call ${callId}`);
        } catch (error) {
            const isKnownRace = error.message.includes('already terminated') || error.message.includes('already failed');
            console[isKnownRace ? 'warn' : 'error'](`[AgentEventHandler] Failed to handle agent join for call ${callId}:`, error.message);

            // Agent is already on another call — notify the socket directly so the UI
            // doesn't stay stuck on the ringing screen waiting for an accept that cannot happen.
            // Return instead of re-throwing: the call is still RINGING (not TERMINATED), so the
            // cleanup block below would be a no-op anyway, and re-throwing would cause the outer
            // catch in CallEventHandler to fire a second EVENT_HANDLER_FAILED error to the agent.
            if (error.message.includes('already has an active call')) {
                emitCallError({
                    callId,
                    code: 'CALL_ALREADY_ENDED',
                    message: 'Unable to accept: you are already on an active call.',
                    socketId,
                });
                return;
            }

            // Lost the ownership claim — someone else already has this call (a
            // genuine race between two agents, or a mobile client that resynced
            // stale/mis-scoped local state — see MIDLR_APP's CallModel guards).
            // Same return-not-throw reasoning as the branch above: this is an
            // expected outcome of the claim losing, not a system failure, and
            // re-throwing would double-emit via CallEventHandler's outer catch
            // with this exact raw message instead of a message an agent can
            // actually act on.
            if (error.message.includes('Call assignment conflict')) {
                emitCallError({
                    callId,
                    code: CallErrorCodes.ACCEPT_FAILED,
                    message: 'This call was already answered by another agent.',
                    socketId,
                });
                return;
            }

            // If the accept failed (e.g. call was terminated mid-accept), ensure
            // the agent is released from ON_CALL so they don't get stuck.
            try {
                const call = await CallRepository.findById(callId);
                if (call && [CallStatus.TERMINATED, CallStatus.FAILED, CallStatus.CANCELLED].includes(call.status)) {
                    if (call.direction === CallDirection.OUTBOUND) {
                        await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(userId);
                    } else {
                        await agentAssignmentCoordinator.releaseAgentIfIdle(userId);
                        await agentAssignmentCoordinator.assignOldestUnassignedCall(call.business_id);
                    }
                    console.log(`[AgentEventHandler] Released agent ${userId} after failed accept for terminated call ${callId}`);

                    // Notify the agent's UI so it doesn't stay stuck on the ringing screen.
                    // Returns instead of falling through to the raw re-throw below —
                    // that re-throw would otherwise double-emit this same error via
                    // CallEventHandler's outer catch, once friendly and once raw.
                    emitCallError({
                        callId,
                        code: 'CALL_ALREADY_ENDED',
                        message: 'This call has already ended.',
                        socketId,
                    });
                    return;
                }
            } catch (releaseErr) {
                console.error(`[AgentEventHandler] Failed to release agent ${userId} after error:`, releaseErr.message);
            }

            throw error;
        }
    }

    /**
     * Handle a RINGING-call reconnect triggered by the socket connect handler in server.js.
     * Runs on the SUBSCRIBED WORKER (the one that owns the WHATSAPP peer) because it is
     * delivered via Redis pub/sub — not on the socket worker. This keeps both peer
     * connections on the same process so checkAndStartBridging can bridge them.
     *
     * No callEventHandler is passed to createSDPOffer because the existing subscription
     * (established in IvrTransferHandler or _handleIncomingCall) is still active on this
     * worker and continues to route all AGENT_JOINED events here.
     */
    async handleRingingAgentReconnect({ callId, socketId, userId, businessId }) {
        if (!peerRegistry.getConnectionData(callId, ConnectionType.WHATSAPP).valid) {
            console.log(`[AgentEventHandler] RINGING_AGENT_RECONNECT: no WHATSAPP peer for call ${callId} on this worker — skipping`);
            return;
        }

        try {
            await peerRegistry.closePeerConnection(callId, ConnectionType.FRONTEND).catch(() => { });
            await CallConnectionRepository.cleanupConnection(callId, ConnectionType.FRONTEND).catch(() => { });

            const sdpOffer = await sdpCoordinator.createSDPOffer(callId, ConnectionType.FRONTEND);

            const call = await CallRepository.findById(callId);
            if (!call) return;

            const agent = await AgentRepository.findUserById(userId);

            EventBus.emit('call:ringing_reconnect_deliver', {
                callId,
                socketId,
                sdpOffer,
                wacid: call.wacid,
                businessId: call.business_id,
                userId: call.user_id,
                agentName: agent?.name ?? null,
                callerId: call.client_number_id,
                callerName: call.caller_name,
                callerUsername: call.caller_username,
                callerNumber: call.caller_number,
                calleeId: call.business_number_id,
                calleeName: call.callee_name,
                calleeUsername: call.callee_username,
                calleeNumber: call.callee_number,
                ringingAt: call.ringing_at,
            });

            const secondsSinceAssignment = call.ringing_at
                ? Math.round((Date.now() - new Date(call.ringing_at).getTime()) / 1000)
                : null;
            await callLifecycleLogger.logAgentConnected(callId, call.business_id, userId, {
                seconds_since_assignment: secondsSinceAssignment,
                is_first_socket: true,
                re_delivered: true,
                transport: 'websocket',
            });

            console.log(`[AgentEventHandler] RINGING_AGENT_RECONNECT: refreshed FRONTEND for call ${callId}, delivering to socket ${socketId}`);
        } catch (err) {
            console.error(`[AgentEventHandler] RINGING_AGENT_RECONNECT failed for call ${callId}:`, err.message);
        }
    }

    async handleAgentReconnected(data) {
        const { callId, userId, businessId, sdpOffer, socketId, deviceId, reconnectTrigger } = data;

        const isIceTrigger = reconnectTrigger === 'ice_failure';
        console.log(`[AgentEventHandler] Agent ${userId} reconnecting to call ${callId}${isIceTrigger ? ' [triggered by ICE failure]' : ''}`);

        try {
            const call = await CallRepository.getUserActiveCall(businessId, callId, userId);
            if (!call) throw new Error('No active call found for reconnecting.');

            const isCallCenter = await BusinessRepository.isCallCentered(businessId);
            if (!isCallCenter) {
                const activeExists = await CallRepository.hasOtherActiveCall(businessId, callId);
                if (activeExists) throw new Error('A call is already active for this business.');
            }

            // Log the disconnect event before tearing down the old peer so the
            // lifecycle timeline shows the break before the recovery.
            if (isIceTrigger) {
                callLifecycleLogger.logDisconnected(callId, businessId, userId, {
                    reason: 'ice_failure',
                    auto_reconnect: true,
                }).catch(err => console.error(`[AgentEventHandler] logDisconnected(ice_failure) failed for call ${callId}:`, err.message));
            }

            // Captured BEFORE teardown — setConnectionInfo further down overwrites
            // the in-memory socketId, so this is the last point it's readable.
            // Used afterward to tell a DIFFERENT, still-live connection (not this
            // same one reconnecting after a network blip) that its connection was
            // just taken over, instead of leaving it silently dead with no
            // explanation — that silence is what "stuck" looked like from the
            // other device's side.
            const previousConnectionInfo = iceCoordinator.getConnectionInfo(callId);

            // Decide purely on cluster-wide socket liveness, not on comparing
            // deviceId: deviceId can't reliably distinguish two sessions —
            // sessionStorage (what the web client's deviceId is derived from)
            // is copied when a browser tab is duplicated, so two genuinely
            // separate, simultaneously-live tabs can share one id. If we gated
            // this on "deviceId changed", a duplicate-tab takeover would look
            // like a same-device reconnect and the tab actually holding the
            // call would go silently dead — exactly the bug this notification
            // exists to prevent. A *different* socketId whose connection is
            // still live right now is a genuine takeover regardless of what
            // deviceId it reports; the same socketId reconnecting, or a
            // different socketId that's already disconnected (the ordinary
            // refresh/ICE-recovery case), is not.
            const isDifferentSocket = previousConnectionInfo?.socketId && previousConnectionInfo.socketId !== socketId;
            const previousSocketStillLive = isDifferentSocket
                ? await roomManager.isSocketConnected(previousConnectionInfo.socketId)
                : false;

            // Close old FRONTEND and guard WHATSAPP still exists
            await peerRegistry.closePeerConnection(callId, ConnectionType.FRONTEND);
            await CallConnectionRepository.cleanupConnection(callId, ConnectionType.FRONTEND);

            if (!peerRegistry.getConnectionData(callId, ConnectionType.WHATSAPP).valid) {
                throw new Error('No active call found for reconnecting.');
            }

            iceCoordinator.setConnectionInfo(callId, ConnectionType.FRONTEND, socketId);

            // Cross-device handoff, not a lockout: moving an active call to another
            // of your own devices/tabs is a deliberate, supported action. The bug
            // being fixed is that it happened silently — tell the connection we
            // just took the call away from what happened, point-to-point (never a
            // business-wide broadcast — the call is still very much alive for the
            // customer and for anyone else watching, e.g. a manager dashboard;
            // only this one connection's binding changed).
            if (previousSocketStillLive) {
                console.log(`[AgentEventHandler] Call ${callId} taken over from still-live socket ${previousConnectionInfo.socketId} — notifying it`);
                roomManager.emitToSocket(previousConnectionInfo.socketId, 'call:connection_superseded', {
                    callId,
                    reason: 'switched_device',
                });
            } else {
                console.log(`[AgentEventHandler] Call ${callId} reconnect — no supersede notification needed (previousSocketId=${previousConnectionInfo?.socketId ?? 'none'}, sameSocket=${!isDifferentSocket})`);
            }

            const sdpAnswer = await sdpCoordinator.createSDPAnswer(callId, sdpOffer, ConnectionType.FRONTEND);
            // Must run AFTER createSDPAnswer, not before: cleanupConnection above
            // *deletes* the FRONTEND call_connections row, and createSDPAnswer is
            // what recreates it (via Peer.insertConnectionRecord). Writing the
            // deviceId any earlier silently updates zero rows — the row doesn't
            // exist yet — which would have meant every reconnect kept whatever
            // device_id was persisted at the *original* accept, never updating it,
            // making all subsequent resyncs/handoffs reason about a stale device.
            CallConnectionRepository.updateDeviceId(callId, ConnectionType.FRONTEND, deviceId ?? null)
                .catch((err) => console.error(`[AgentEventHandler] Failed to persist deviceId for call ${callId}:`, err.message));
            iceCoordinator.markClientReady(callId);
            await peerRegistry.checkAndStartBridging(callId);

            const {
                wacid, client_number_id, business_number_id,
                caller_name, caller_username, caller_number,
                callee_name, callee_username, callee_number,
                direction, status, ringing_at: ringingAt, answered_at: startedAt,
            } = call;

            const callerId = direction === CallDirection.INBOUND ? client_number_id : business_number_id;
            const calleeId = direction === CallDirection.OUTBOUND ? client_number_id : business_number_id;
            const agentName = await AgentRepository.getUserNameById(userId, businessId);

            await callLifecycleLogger.logReconnected(callId, businessId, userId, {
                source: isIceTrigger ? 'ice_failure_recovery' : 'network_reconnect',
            });

            EventBus.emit('call:reconnected', { callId, userId, businessId, sdpAnswer });

            console.log(`[AgentEventHandler] ✅ Agent ${userId} reconnected to call ${callId}${isIceTrigger ? ' (ICE failure recovered)' : ''}`);

            return {
                callId, wacid, userId, agentName, businessId,
                callerId, callerName: caller_name, callerUsername: caller_username, callerNumber: caller_number,
                calleeId, calleeName: callee_name, calleeUsername: callee_username, calleeNumber: callee_number,
                status, direction, startedAt, ringingAt, sdpAnswer,
            };
        } catch (error) {
            console.error(`[AgentEventHandler] Failed to handle agent reconnect for call ${callId}:`, error.message);
            throw error;
        }
    }

    /**
     * Resolve once the agent's browser has actually delivered an inbound audio
     * track on its FRONTEND peer connection. If the track already arrived before
     * we got here (fast renegotiation), return immediately. Otherwise listen for
     * `trackReceived` from PeerEventManager. Reject on timeout so the caller can
     * fail the accept cleanly.
     */
    async #waitForFrontendAudioTrack(callId, timeoutMs) {
        // Already arrived?
        const existing = peerRegistry.getConnectionData(callId, ConnectionType.FRONTEND);
        if (existing.valid) {
            // Wrapped in try/catch: wrtc throws "Invalid argument" during native peer
            // connection state transitions (Pattern A race). On failure fall back to
            // the trackBuffer maintained by PeerEventManager, which captures every
            // ontrack event regardless of getReceivers() availability.
            let track = null;
            try {
                track = existing.data.pc.getReceivers()
                    .find(r => r.track?.kind === 'audio' && r.track.readyState === 'live')?.track;
            } catch (err) {
                console.warn(`[AgentEventHandler] getReceivers failed for call ${callId}: ${err.message} — checking trackBuffer`);
                const buffered = existing.data.audio?.trackBuffer;
                if (buffered?.length > 0) {
                    track = buffered.find(t => t.track?.kind === 'audio' && t.track.readyState === 'live')?.track ?? null;
                }
                if (!track) {
                    console.warn(`[AgentEventHandler] No buffered track for call ${callId} — waiting for trackReceived event`);
                }
            }
            if (track) {
                return track;
            }
        }

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                peerEventManager.off('trackReceived', listener);
            };

            const listener = (evt) => {
                if (
                    evt?.callId === callId
                    && evt.connectionType === ConnectionType.FRONTEND
                    && evt.track?.kind === 'audio'
                ) {
                    cleanup();
                    resolve(evt.track);
                }
            };

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Microphone audio did not reach the server within ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);

            peerEventManager.on('trackReceived', listener);
        });
    }

    /**
     * Media-not-ready cleanup. Called when we can't proceed to acceptWhatsAppCall
     * because the agent's uplink never materialized. We must:
     *   1) tell Meta to drop the call (so they don't keep ringing the client)
     *   2) mark the call FAILED with a clear reason (not silently stuck)
     *   3) release the agent's ON_CALL flag so they can take the next call
     *   4) tell the frontend exactly what happened so the agent gets a toast,
     *      not a dead UI
     */
    async #abortAcceptOnMediaFailure(callId, userId, reason) {
        // `reason` is a technical string kept for server logs / debugging.
        // Agents never see it — user-facing copy lives in the DB title and the
        // emitCallError message below.
        console.error(`[AgentEventHandler] Aborting accept for call ${callId} — ${reason}`);

        try {
            await terminateWhatsAppCall(callId);
        } catch (err) {
            console.warn(`[AgentEventHandler] terminateWhatsAppCall failed during media-not-ready abort for ${callId}: ${err.message}`);
        }

        try {
            await CallRepository.markCallFailedIfNotFinal(
                callId,
                [{ code: 'AGENT_MEDIA_NOT_READY', title: 'Microphone not detected — audio did not reach the server' }],
                null,
                TerminationReason.AGENT_MEDIA_NOT_READY,
                TerminatedBy.SYSTEM
            );
        } catch (err) {
            console.warn(`[AgentEventHandler] markCallFailedIfNotFinal failed for ${callId}: ${err.message}`);
        }

        try { await peerRegistry.closePeerConnection(callId); } catch (_) { /* best effort */ }

        if (userId) {
            try {
                const call = await CallRepository.findById(callId);
                if (call?.direction === CallDirection.OUTBOUND) {
                    await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(userId);
                } else {
                    await agentAssignmentCoordinator.releaseAgentIfIdle(userId);
                    if (call?.business_id) {
                        await agentAssignmentCoordinator.assignOldestUnassignedCall(call.business_id);
                    }
                }
            } catch (err) {
                console.error(`[AgentEventHandler] Failed to release agent ${userId} after media-not-ready abort:`, err.message);
            }
        }

        emitCallError({
            callId,
            code: CallErrorCodes.AGENT_MEDIA_NOT_READY ?? 'AGENT_MEDIA_NOT_READY',
            message: 'Your microphone was not detected. Please check that your microphone is connected and permissions are allowed, then try again.',
        });
    }
}
