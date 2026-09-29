// src/core/events/handlers/AgentEventHandler.js
import CallRepository from '../../../persistence/CallRepository.js';
import AgentRepository from '../../../persistence/AgentRepository.js';
import CallConnectionRepository from '../../../persistence/CallConnectionRepository.js';
import { customerChannels } from '../../channels/CustomerChannels.js';
import EventBus from '../../EventBus.js';
import { callLifecycleLogger } from '../../calls/CallLifecycleLogger.js';
import { peerRegistry } from '../../../media/webrtc/PeerRegistry.js';
import { peerEventManager } from '../../../media/webrtc/PeerEventManager.js';
import { sdpCoordinator } from '../../../media/webrtc/SDPCoordinator.js';
import { iceCoordinator } from '../../../media/webrtc/ice/ICECandidateCoordinator.js';
import { emitCallError } from '../CallErrorEmitter.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { ConnectionType, CallStatus, CallDirection, TerminationReason, TerminatedBy } from '../../constants/CallConstants.js';
import { agentAssignmentCoordinator } from '../../routing/AgentAssignmentCoordinator.js';
import { agentMissedCallTracker } from '../../routing/AgentMissedCallTracker.js';
import { roomManager } from '../../../realtime/managers/RoomManager.js';
import { callPushNotifier } from '../../../push/CallPushNotifier.js';
import { queueRouter } from '../../routing/QueueRouter.js';
import { IncomingCallPayload } from '../../calls/IncomingCallPayload.js';
import { toCallView } from '../../calls/CallView.js';
import { callTerminator } from '../../calls/CallTerminator.js';
import { AssignmentType, AgentAvailability } from '../../constants/CallConstants.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.AgentEventHandler');

// Max wait for the agent's inbound audio track to arrive on the AGENT peer
// before we tell Meta "accepted". Empirically the ontrack dispatch lands within
// ~100-800 ms after processSDPAnswer on a healthy connection; 5 s is generous
// headroom for slow networks, but bounded so we fail-fast on "mic denied" /
// "bad SDP" scenarios instead of accepting with a broken uplink.
const AGENT_AUDIO_TRACK_TIMEOUT_MS = 5000;

export class AgentEventHandler {

    async handleAgentJoined(data) {
        const { callId, userId, tenantId, sdpAnswer, socketId, deviceId } = data;

        log.debug({ agentId: userId, callId, socketId }, 'Agent joined call');

        // Guard: only the worker owning the in-memory peer connection should handle this.
        const ownsConnection = peerRegistry.getConnectionData(callId, ConnectionType.AGENT).valid;
        if (!ownsConnection) {
            log.debug({ callId }, 'Worker does not own peer connection — skipping');
            return;
        }

        try {
            // Queue capacity (queues.max_active_calls) — catches a second call being
            // accepted while the queue's limit is already reached.
            const callQueueRow = await CallRepository.findById(callId);
            const callQueue = callQueueRow?.queue_id ? await queueRouter.getQueue(callQueueRow.queue_id) : null;
            if (await queueRouter.isAtCapacity(callQueue, callId)) {
                throw new Error('The queue is at its active-call limit.');
            }
            // An agent must not accept a second call while already on one — the final
            // safety net after the batchUpdateAgentAvailability guard in cleanup.
            const agentHasActiveCall = await CallRepository.hasAgentActiveCall(userId, callId);
            if (agentHasActiveCall) throw new Error('Agent already has an active call.');

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
                log.debug({ callId }, `Call no longer RINGING (now=${preGateStatus}) — skipping accept flow`);
                return;
            }

            // Claim ownership before touching the peer connection or calling Meta.
            // Ring-group calls can dispatch to multiple agents; if two send agent_joined
            // near-simultaneously, whichever loses this atomic claim must bail out here —
            // otherwise it goes on to run processSDPAnswer against the AGENT peer the
            // winner already holds ("Called in wrong state: stable") and can double-fire
            // the provider accept. Only applies pre-accept (RINGING); the IN_PROGRESS
            // transfer-accept path never owns the call via this check (see comment above).
            if (preGateStatus === CallStatus.RINGING) {
                const claimed = await CallRepository.assignCallToAgentIfEligible(callId, userId);
                if (!claimed) throw new Error('Call assignment conflict. Call ownership changed.');

                // A RING_ALL call was offered without claiming anyone: the agent who
                // just won it goes ON_CALL now, not at the end of the accept flow —
                // otherwise the queue drain could offer them a second call during
                // the media/provider round trips. (A no-op when routing already
                // claimed them; failure paths below release them again.)
                if (await AgentRepository.markOnCall(userId, callId)) {
                    EventBus.emit('call:agent_availability', {
                        tenantId, userId, availability: AgentAvailability.ON_CALL, updatedAt: new Date().toISOString(),
                    });
                }
            }

            iceCoordinator.setConnectionInfo(callId, ConnectionType.AGENT, socketId);
            // Durable per-device identity (survives this socket disconnecting/
            // reconnecting) — recorded alongside the ephemeral socketId above so
            // ongoing-calls resync and reconnect-authorization can tell "my other
            // session" apart from "this exact device", which socketId/userId alone
            // can't do. Awaited (unlike this same call's counterpart in
            // handleAgentReconnected, which stays fire-and-forget because it runs
            // after its own row-recreating step) so a resync landing immediately
            // after accept can never read a call still carrying a stale/absent
            // device_id.
            await CallConnectionRepository.updateDeviceId(callId, ConnectionType.AGENT, deviceId ?? null)
                .catch((err) => log.error({ callId, err }, 'Failed to persist deviceId'));
            await sdpCoordinator.processSDPAnswer(callId, sdpAnswer, ConnectionType.AGENT);
            iceCoordinator.markClientReady(callId);

            // ── Gate: wait for the agent's microphone track on the AGENT peer ───
            // Previously the provider accept was fired immediately after processSDPAnswer.
            // Meta would then start streaming the customer's audio toward us while our
            // AGENT had no inbound audio track yet — client hears nothing back,
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
            const isIvrTransferred = !!callRecord?.ivr_flow_id;

            if (currentStatus === CallStatus.RINGING) {

                if (!isIvrTransferred) {
                    // Skip if the CUSTOMER peer is already fully connected — this happens when an
                    // agent transfer re-routes a call to a new agent after the first agent's accept
                    // already completed. The customer's audio is live; we must not re-signal
                    // it with a new SDP answer or we'd issue a redundant provider accept.
                    // `requireReady=true` uses the registry's isReady flag, which is set only on
                    // connectionState→'connected' — safe to read without touching the wrtc native pc.
                    const customerAlreadyReady = peerRegistry.getConnectionData(callId, ConnectionType.CUSTOMER, true).valid;

                    if (!customerAlreadyReady) {
                        // Fresh RINGING call — answer the customer now that the agent is ready
                        const customerConn = await CallConnectionRepository.findByCallAndType(callId, ConnectionType.CUSTOMER);
                        if (!customerConn || !customerConn.remote_sdp) throw new Error('Customer offer not found');

                        const { call: customerCall, channel } = await customerChannels.forCall(callRecord ?? callId);
                        const customerSdpAnswer = await sdpCoordinator.createSDPAnswer(
                            callId, customerConn.remote_sdp, ConnectionType.CUSTOMER, { sdpProfile: channel.sdp }
                        );
                        await channel.accept(customerCall, customerSdpAnswer);

                        // Guard: verify call wasn't terminated while the API call was in progress
                        const postAcceptStatus = await CallRepository.getStatus(callId);
                        if ([CallStatus.TERMINATED, CallStatus.FAILED].includes(postAcceptStatus)) {
                            throw new Error(`Call already ${postAcceptStatus.toLowerCase()}, cannot accept`);
                        }
                    } else {
                        log.debug({ callId }, 'Customer peer already connected — skipping re-accept');
                    }
                } else {
                    log.debug({ callId }, 'IVR-transferred call — customer already answered, skipping re-accept');
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

            const result = peerRegistry.getConnectionData(callId, ConnectionType.AGENT);
            if (result.valid) result.data.context.update({ userId, tenantId });

            // Who is on the AGENT leg now.
            CallConnectionRepository.updateAgentId(callId, ConnectionType.AGENT, userId)
                .catch((err) => log.error({ callId, err }, 'Failed to persist agent'));

            const agentName = await AgentRepository.getNameById(userId);

            const isFollowUp = await callLifecycleLogger.isFollowUp(callId, userId);
            if (isFollowUp) {
                await callLifecycleLogger.logFollowUp(callId, tenantId, userId);
            } else {
                await callLifecycleLogger.logAccepted(callId, tenantId, userId);
            }

            // The agent is engaged — clear any prior missed-call streak so the
            // auto-offline policy doesn't carry a stale count into their next
            // shift. No-op when the policy is disabled or the key doesn't exist.
            agentMissedCallTracker.reset(userId).catch((err) =>
                log.error({ agentId: userId, err }, 'reset streak failed')
            );

            EventBus.emit('call:success', { callId, message: 'Call accepted successfully', code: 'CALL_ACCEPTED' });
            EventBus.emit('call:handled', { callId, tenantId, userId, agentName, deviceId: deviceId ?? null, action: 'accepted' });

            // Fire-and-forget: dismiss the native ringing UI on this agent's other
            // devices, and — for a RING_ALL call — every other member's device.
            // excludeDeviceId: the device that just answered must never receive its
            // own "dismiss stale ring" push (it tears the live call down natively).
            // The other members a RING_ALL call was offered to stop ringing.
            if (queueRouter.isRingAll(callQueue) && callQueue) {
                EventBus.emit('call:offer_taken', { callId, tenantId, takenBy: userId, queueId: callQueue.id });
            }

            callPushNotifier.notifyCallResolved(callId, {
                resolvedAgentId: userId,
                ringAllQueue: queueRouter.isRingAll(callQueue) ? callQueue : null,
                tenantId,
                excludeDeviceId: deviceId ?? null,
            }).catch((err) =>
                log.error({ callId, err }, 'notifyCallResolved failed')
            );

            log.info({ agentId: userId, callId }, 'Agent successfully joined call');
        } catch (error) {
            const isKnownRace = error.message.includes('already terminated') || error.message.includes('already failed');
            log[isKnownRace ? 'warn' : 'error']({ callId, err: error }, 'Failed to handle agent join');

            // Agent is already on another call — notify the socket directly so the UI
            // doesn't stay stuck on the ringing screen waiting for an accept that cannot happen.
            // Return instead of re-throwing: the call is still RINGING (not TERMINATED), so the
            // cleanup block below would be a no-op anyway, and re-throwing would cause the outer
            // catch in CallEventHandler to fire a second EVENT_HANDLER_FAILED error to the agent.
            if (error.message.includes('already has an active call')) {
                emitCallError({
                    callId,
                    code: CallErrorCodes.CALL_ALREADY_ENDED,
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
                        await agentAssignmentCoordinator.assignOldestUnassignedCall(call.tenant_id);
                    }
                    log.info({ agentId: userId, callId }, 'Released agent after failed accept for terminated call');

                    // Notify the agent's UI so it doesn't stay stuck on the ringing screen.
                    // Returns instead of falling through to the raw re-throw below —
                    // that re-throw would otherwise double-emit this same error via
                    // CallEventHandler's outer catch, once friendly and once raw.
                    emitCallError({
                        callId,
                        code: CallErrorCodes.CALL_ALREADY_ENDED,
                        message: 'This call has already ended.',
                        socketId,
                    });
                    return;
                }
            } catch (releaseErr) {
                log.error({ agentId: userId, err: releaseErr }, 'Failed to release agent after error');
            }

            throw error;
        }
    }

    /**
     * Handle a RINGING-call reconnect triggered by the socket connect handler in server.js.
     * Runs on the SUBSCRIBED WORKER (the one that owns the CUSTOMER peer) because it is
     * delivered via Redis pub/sub — not on the socket worker. This keeps both peer
     * connections on the same process so checkAndStartBridging can bridge them.
     *
     * No callEventHandler is passed to createSDPOffer because the existing subscription
     * (established in IvrTransferHandler or _handleIncomingCall) is still active on this
     * worker and continues to route all AGENT_JOINED events here.
     */
    async handleRingingAgentReconnect({ callId, socketId, userId, tenantId }) {
        if (!peerRegistry.getConnectionData(callId, ConnectionType.CUSTOMER).valid) {
            log.debug({ callId }, 'RINGING_AGENT_RECONNECT: no CUSTOMER peer on this worker — skipping');
            return;
        }

        try {
            await peerRegistry.closePeerConnection(callId, ConnectionType.AGENT).catch(() => { });
            await CallConnectionRepository.cleanupConnection(callId, ConnectionType.AGENT).catch(() => { });

            const sdpOffer = await sdpCoordinator.createSDPOffer(callId, ConnectionType.AGENT);

            const call = await CallRepository.findById(callId);
            if (!call) return;

            const agent = await AgentRepository.findById(userId);

            EventBus.emit('call:ringing_reconnect_deliver', {
                socketId,
                payload: IncomingCallPayload.fromCall(call, {
                    agentId: call.agent_id,
                    agentName: agent?.name ?? null,
                    sdpOffer,
                    assignmentType: AssignmentType.DIRECT,
                }),
            });

            const secondsSinceAssignment = call.ringing_at
                ? Math.round((Date.now() - new Date(call.ringing_at).getTime()) / 1000)
                : null;
            await callLifecycleLogger.logAgentConnected(callId, call.tenant_id, userId, {
                seconds_since_assignment: secondsSinceAssignment,
                is_first_socket: true,
                re_delivered: true,
                transport: 'websocket',
            });

            log.info({ callId, socketId }, 'Ringing agent reconnected — offer re-delivered');
        } catch (err) {
            log.error({ callId, err }, 'RINGING_AGENT_RECONNECT failed');
        }
    }

    async handleAgentReconnected(data) {
        const { callId, userId, tenantId, sdpOffer, socketId, deviceId, reconnectTrigger } = data;

        const isIceTrigger = reconnectTrigger === 'ice_failure';
        log.info({ agentId: userId, callId }, `Agent reconnecting${isIceTrigger ? ' [triggered by ICE failure]' : ''}`);

        try {
            const call = await CallRepository.getUserActiveCall(tenantId, callId, userId);
            if (!call) throw new Error('No active call found for reconnecting.');


            // Log the disconnect event before tearing down the old peer so the
            // lifecycle timeline shows the break before the recovery.
            if (isIceTrigger) {
                callLifecycleLogger.logDisconnected(callId, tenantId, userId, {
                    reason: 'ice_failure',
                    auto_reconnect: true,
                }).catch(err => log.error({ callId, err }, 'logDisconnected(ice_failure) failed'));
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

            // Close old AGENT and guard CUSTOMER still exists
            await peerRegistry.closePeerConnection(callId, ConnectionType.AGENT);
            await CallConnectionRepository.cleanupConnection(callId, ConnectionType.AGENT);

            if (!peerRegistry.getConnectionData(callId, ConnectionType.CUSTOMER).valid) {
                throw new Error('No active call found for reconnecting.');
            }

            iceCoordinator.setConnectionInfo(callId, ConnectionType.AGENT, socketId);

            // Cross-device handoff, not a lockout: moving an active call to another
            // of your own devices/tabs is a deliberate, supported action. The bug
            // being fixed is that it happened silently — tell the connection we
            // just took the call away from what happened, point-to-point (never a
            // business-wide broadcast — the call is still very much alive for the
            // customer and for anyone else watching, e.g. a manager dashboard;
            // only this one connection's binding changed).
            if (previousSocketStillLive) {
                log.info({ callId, previousSocketId: previousConnectionInfo.socketId }, 'Call taken over from a still-live socket — notifying it');
                roomManager.emitToSocket(previousConnectionInfo.socketId, 'call:connection_superseded', {
                    callId,
                    reason: 'switched_device',
                });
            } else {
                log.debug({ callId, previousSocketId: previousConnectionInfo?.socketId ?? null, sameSocket: !isDifferentSocket }, 'Reconnect — no supersede notification needed');
            }

            const sdpAnswer = await sdpCoordinator.createSDPAnswer(callId, sdpOffer, ConnectionType.AGENT);
            // Must run AFTER createSDPAnswer, not before: cleanupConnection above
            // *deletes* the AGENT call_connections row, and createSDPAnswer is
            // what recreates it (via Peer.insertConnectionRecord). Writing the
            // deviceId any earlier silently updates zero rows — the row doesn't
            // exist yet — which would have meant every reconnect kept whatever
            // device_id was persisted at the *original* accept, never updating it,
            // making all subsequent resyncs/handoffs reason about a stale device.
            CallConnectionRepository.updateDeviceId(callId, ConnectionType.AGENT, deviceId ?? null)
                .catch((err) => log.error({ callId, err }, 'Failed to persist deviceId'));
            iceCoordinator.markClientReady(callId);
            await peerRegistry.checkAndStartBridging(callId);

            CallConnectionRepository.updateAgentId(callId, ConnectionType.AGENT, userId)
                .catch((err) => log.error({ callId, err }, 'Failed to persist agent'));
            const agentName = await AgentRepository.getNameById(userId);

            await callLifecycleLogger.logReconnected(callId, tenantId, userId, {
                source: isIceTrigger ? 'ice_failure_recovery' : 'network_reconnect',
            });

            // The answer is for the one socket that sent call:reconnect.
            EventBus.emit('call:reconnected', { callId, userId, tenantId, sdpAnswer, socketId, deviceId: deviceId ?? null });

            log.info({ agentId: userId, callId }, `Agent reconnected${isIceTrigger ? ' (ICE failure recovered)' : ''}`);

            return { ...toCallView(call, { agentName, deviceId: deviceId ?? null }), sdpAnswer };
        } catch (error) {
            log.error({ callId, err: error }, 'Failed to handle agent reconnect');
            throw error;
        }
    }

    /**
     * Resolve once the agent's browser has actually delivered an inbound audio
     * track on its AGENT peer connection. If the track already arrived before
     * we got here (fast renegotiation), return immediately. Otherwise listen for
     * `trackReceived` from PeerEventManager. Reject on timeout so the caller can
     * fail the accept cleanly.
     */
    async #waitForFrontendAudioTrack(callId, timeoutMs) {
        // Already arrived?
        const existing = peerRegistry.getConnectionData(callId, ConnectionType.AGENT);
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
                log.warn({ callId, err }, 'getReceivers failed — checking trackBuffer');
                const buffered = existing.data.audio?.trackBuffer;
                if (buffered?.length > 0) {
                    track = buffered.find(t => t.track?.kind === 'audio' && t.track.readyState === 'live')?.track ?? null;
                }
                if (!track) {
                    log.warn({ callId }, 'No buffered track — waiting for trackReceived event');
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
                    && evt.connectionType === ConnectionType.AGENT
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
     * Media-not-ready cleanup. Called when we can't proceed to accepting the
     * customer because the agent's uplink never materialized. We must:
     *   1) tell the provider to drop the call (so the customer isn't left ringing)
     *   2) mark the call FAILED with a clear reason (not silently stuck)
     *   3) release the agent's ON_CALL flag so they can take the next call
     *   4) tell the frontend exactly what happened so the agent gets a toast,
     *      not a dead UI
     */
    async #abortAcceptOnMediaFailure(callId, userId, reason) {
        // `reason` is a technical string kept for server logs / debugging.
        // Agents never see it — user-facing copy lives in the DB title and the
        // emitCallError message below.
        log.error({ callId }, `Aborting accept — ${reason}`);

        try {
            const call = await CallRepository.findById(callId);
            if (call) {
                await callTerminator.end({ ...call, agent_id: call.agent_id ?? userId }, {
                    reason: TerminationReason.AGENT_MEDIA_NOT_READY,
                    terminatedBy: TerminatedBy.SYSTEM,
                    failure: { errors: [{ code: 'AGENT_MEDIA_NOT_READY', title: 'Microphone not detected — audio did not reach the server' }] },
                    provider: 'terminate',
                    media: 'local',
                    source: 'agent_media_not_ready',
                });
            }
        } catch (err) {
            log.error({ callId, err }, 'Ending call after media-not-ready abort failed');
        }

        emitCallError({
            callId,
            code: CallErrorCodes.AGENT_MEDIA_NOT_READY,
            message: 'Your microphone was not detected. Please check that your microphone is connected and permissions are allowed, then try again.',
        });
    }
}
