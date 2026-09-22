import EventBus from '../../core/EventBus.js';
import CallRepository from '../../../repositories/CallRepository.js';
import CallChatMessageRepository from '../../../repositories/CallChatMessageRepository.js';
import AgentRepository from '../../../repositories/AgentRepository.js';
import BusinessRepository from '../../../repositories/BusinessRepository.js';
import ClientRepository from '../../../repositories/ClientRepository.js';
import UserGroupRepository from '../../../repositories/UserGroupRepository.js';
import IvrRepository from '../../../repositories/IvrRepository.js';
import CallConnectionRepository from '../../../repositories/CallConnectionRepository.js';
import { callEventHandler } from '../events/CallEventHandler.js';
import { sdpCoordinator } from '../signaling/webrtc/SDPCoordinator.js';
import OneSignalService from '../../notifications/OneSignalService.js';
import { NotificationPresets, NotificationIcons, absoluteUrl } from '../../notifications/notificationPresets.js';
import { callOwnershipService } from '../../redis/CallOwnershipService.js';
import { redisPubSubService } from '../../redis/RedisPubSubService.js';
import { redisUtilityService } from '../../redis/RedisUtilityService.js';
import { redisBaseService } from '../../redis/RedisBaseService.js';
import { callAgentAssignmentService } from '../../redis/CallAgentAssignmentService.js';
import { agentMissedCallTracker } from '../../redis/AgentMissedCallTracker.js';
import { agentAssignmentCoordinator } from '../assignment/AgentAssignmentCoordinator.js';
import { callLifecycleLogger } from '../lifecycle/CallLifecycleLogger.js';
import { EventTypes } from '../events/EventTypes.js';
import { emitCallError } from '../events/CallErrorEmitter.js';
import { presenceService } from '../../redis/PresenceService.js';
import {
    CallStatus,
    CallDirection,
    ConnectionType,
    AssignmentType,
    RoutingStrategy,
    AgentAvailability,
    TerminationReason,
    TerminatedBy,
} from '../constants/CallConstants.js';
import { IncomingCallPayload } from '../assignment/IncomingCallPayload.js';
import { acceptWhatsAppCall } from '../signaling/webrtc/WhatsAppCallApi.js';

// Tombstone written when a `terminate` webhook arrives before its matching
// `connect`. The late `connect` looks this up to persist the call directly
// as a missed call instead of ringing an agent for a call Meta has already
// finished. TTL bounds how long we'll wait for the connect to land.
const TERMINATE_TOMBSTONE_PREFIX = 'call:terminate:tombstone:';
const TERMINATE_TOMBSTONE_TTL_SECONDS = 120;
const tombstoneKey = (wacid) => `${TERMINATE_TOMBSTONE_PREFIX}${wacid}`;

// Max number of call/status events processed in parallel within one webhook payload.
// Prevents a single large payload from spawning unbounded concurrent DB + Redis chains.
const WEBHOOK_CONCURRENCY = 5;

class CallWebhookProcessor {

    // ── Entry point ───────────────────────────────────────────────────────────

    async process({ metadata, calls, contacts, statuses }) {
        const thunks = [];

        if (Array.isArray(calls) && calls.length > 0) {
            for (const call of calls) {
                thunks.push(() =>
                    this._processCallEvent(call, metadata, contacts?.[0]).catch((err) => {
                        console.error(`[Webhook:event] Error processing call ${call?.id}:`, err);
                    })
                );
            }
        }

        if (Array.isArray(statuses) && statuses.length > 0) {
            for (const status of statuses) {
                thunks.push(() =>
                    this._processCallStatus(status, metadata).catch((err) => {
                        console.error(`[Webhook:status] Error processing status:`, err);
                    })
                );
            }
        }

        if (thunks.length) await this._runConcurrent(thunks, WEBHOOK_CONCURRENCY);
    }

    // Worker-pool: runs `thunks` with at most `limit` executing at once.
    async _runConcurrent(thunks, limit) {
        let next = 0;
        const worker = async () => {
            while (next < thunks.length) {
                await thunks[next++]();
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
    }

    // ── Call event processing ─────────────────────────────────────────────────

    async _processCallEvent(call, metadata, contact) {
        const { id: wacid, event } = call;

        // 'terminate' is NOT ownership-gated (unlike 'connect' below) — any
        // worker that receives this webhook processes it directly.
        // Confirmed by reading _handleCallTerminate in full: it never touches
        // worker-local in-memory state (no peerRegistry access at all) — it's
        // pure CallRepository writes, already race-safe via
        // finalizeFromWebhook/finalizeCallAsFailed's atomic "only if not
        // already terminated" guard, plus a redisPubSubService.
        // publishCallEvent(EventTypes.CALL_TERMINATED, ...) that already
        // forwards to whichever worker DOES hold the live peer connection,
        // regardless of which worker ran this function. The gate that used
        // to sit here (skip unless getCallOwner(wacid) === this worker) had
        // no such forwarding for the *notification* side, though — a
        // terminate landing on a different worker than the one that handled
        // 'connect' (entirely possible: they're just two independent HTTP
        // deliveries, load-balanced across WORKER_COUNT workers with no
        // wacid-sticky routing) was silently dropped in its entirety: no DB
        // finalize, no EventBus emit, no dismiss push. Reproduced live — the
        // native ringing UI stayed stuck until the ~90s cleanup sweep timeout
        // instead of dismissing immediately when the call was terminated.
        if (event !== 'terminate') {
            const claimed = await callOwnershipService.claimCall(wacid, 180);
            if (!claimed) {
                const owner = await callOwnershipService.getCallOwner(wacid);
                console.log(`[Webhook:event] Skipping call ${wacid} - already owned by worker ${owner}`);
                return;
            }
            console.log(`[Webhook:event] Worker claimed call ${wacid}`);
        }

        try {
            switch (event) {
                case 'connect':
                    await this._handleCallConnect(call, metadata, contact);
                    break;
                case 'terminate':
                    await this._handleCallTerminate(call);
                    break;
                default:
                    console.warn(`[Webhook:event] Unknown event type: ${event}`);
            }
        } catch (error) {
            console.error(`[Webhook:event] Error on "${event}" for call ${wacid}:`, error);
        } finally {
            if (event === 'terminate') {
                await redisUtilityService.cleanupCall(wacid);
                console.log(`[Webhook:event] Cleaned up ownership for call ${wacid}`);
            } else if (event === 'connect') {
                const latestCall = await CallRepository.findByWacid(wacid);
                if (!latestCall || [CallStatus.TERMINATED, CallStatus.FAILED].includes(latestCall.status)) {
                    await redisUtilityService.cleanupCall(wacid);
                    return;
                }
                const madePermanent = await callOwnershipService.setCallOwnershipPermanent(wacid);
                if (!madePermanent) {
                    console.warn(`[Webhook:event] Could not make ownership permanent for call ${wacid}`);
                }
            }
        }
    }

    // ── Status processing ─────────────────────────────────────────────────────

    async _processCallStatus(callStatus) {
        const { id: wacid, type, status, timestamp } = callStatus;

        if (type !== 'call') return;

        console.log(`[Webhook:status] Processing - wacid=${wacid}, status=${status}`);

        try {
            const call = await CallRepository.findByWacid(wacid);
            if (!call) {
                console.warn(`[Webhook:status] Call not found for wacid=${wacid}`);
                return;
            }

            const callId = call.id;
            const agentId = call.user_id ?? null;
            const previousStatus = call.status;
            const timestampValue = timestamp ? new Date(parseInt(timestamp) * 1000) : new Date();
            const isTerminal = [CallStatus.TERMINATED, CallStatus.FAILED, CallStatus.CANCELLED].includes(previousStatus);

            switch (status) {
                case 'RINGING':
                    // Always update ringing_at with Meta's authoritative timestamp.
                    // For outbound calls ringing_at is seeded at creation time as an
                    // approximation; Meta's value here is more accurate and should win.
                    // For inbound calls the creation-time value and this timestamp are
                    // from the same webhook so overwriting is harmless.
                    await CallRepository.updateTimestamp(callId, 'ringing_at', timestampValue);
                    // Out-of-order case: terminate webhook already ran before RINGING arrived.
                    // Retroactively patch ringing_duration now that we have an authoritative ringing_at.
                    // Covers both answered calls (ringing ends at answered_at) and missed/rejected
                    // calls (ringing ends at ended_at).
                    if (isTerminal && call.ringing_duration == null) {
                        const ringingEnd = call.answered_at
                            ? new Date(call.answered_at)
                            : (call.ended_at ? new Date(call.ended_at) : new Date());
                        const retroRingingDuration = Math.max(
                            0,
                            Math.floor((ringingEnd - timestampValue) / 1000)
                        );
                        await CallRepository.updateDuration(callId, 'ringing_duration', retroRingingDuration);
                        console.log(
                            `[Webhook:status/RINGING] Retroactive ringing_duration=${retroRingingDuration}s ` +
                            `for already-terminal call ${callId}`
                        );
                    }
                    if (!isTerminal && previousStatus === CallStatus.INITIATED) {
                        await CallRepository.updateStatus(callId, CallStatus.RINGING);
                    }
                    if (call.direction === CallDirection.OUTBOUND) {
                        callLifecycleLogger.logOutboundRinging(callId, call.business_id, agentId, {
                            wacid, previousState: previousStatus,
                        }).catch(() => { });
                    }
                    break;

                case 'ACCEPTED':
                    // If RINGING was dropped/reordered, ensure ringing_at is still populated.
                    if (!call.ringing_at) {
                        await CallRepository.updateTimestamp(callId, 'ringing_at', timestampValue);
                        // Same retroactive patch as in the RINGING case: terminate may have already run.
                        if (isTerminal && call.ringing_duration == null) {
                            // ringing_at was just set to timestampValue; answered_at is timestampValue too,
                            // so ringing_duration = 0 (ACCEPTED without preceding RINGING is instantaneous).
                            await CallRepository.updateDuration(callId, 'ringing_duration', 0);
                        }
                    }
                    // updateTimestamp('answered_at') self-heals a stale NO_ANSWER verdict
                    // if our own termination flow raced ahead of this webhook and already
                    // finalized the call before Meta confirmed it was actually answered.
                    await CallRepository.updateTimestamp(callId, 'answered_at', timestampValue);
                    if (!isTerminal && previousStatus !== CallStatus.IN_PROGRESS) {
                        await CallRepository.updateStatus(callId, CallStatus.IN_PROGRESS);
                        await CallRepository.updateState(callId, 'ACTIVE');
                    }
                    if (call.direction === CallDirection.OUTBOUND) {
                        callLifecycleLogger.logOutboundAccepted(callId, call.business_id, agentId, {
                            wacid, previousState: previousStatus,
                        }).catch(() => { });
                    }
                    break;

                case 'REJECTED':
                    await CallRepository.updateTimestamp(callId, 'ended_at', timestampValue);
                    // Compute ringing_duration here: the REJECTED status webhook is the terminal
                    // event for client-declined calls, so _handleCallTerminate never runs for them.
                    // ringing_at is guaranteed non-null for outbound (set at creation) and for
                    // inbound (set at call creation from the connect webhook).
                    if (call.ringing_at && call.ringing_duration == null) {
                        const rejRingingDuration = Math.max(
                            0,
                            Math.floor((timestampValue - new Date(call.ringing_at)) / 1000)
                        );
                        await CallRepository.updateDuration(callId, 'ringing_duration', rejRingingDuration);
                    }
                    await CallRepository.terminateCall(callId, TerminationReason.REJECTED, TerminatedBy.CLIENT);
                    CallChatMessageRepository.finalize(callId, {
                        status: 'TERMINATED',
                        terminationReason: TerminationReason.REJECTED,
                        callDuration: 0,
                    }).catch((err) =>
                        console.error(`[Webhook:status/REJECTED] finalize chat bubble failed for call ${callId}:`, err.message)
                    );
                    if (call.direction === CallDirection.OUTBOUND) {
                        callLifecycleLogger.logOutboundRejected(callId, call.business_id, agentId, {
                            wacid, previousState: previousStatus,
                        }).catch(() => { });
                    }
                    await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_REJECTED, {
                        callId,
                        wacid,
                        businessId: call.business_id,
                        userId: agentId,
                        direction: call.direction,
                        reason: 'CLIENT_REJECTED',
                        timestamp: timestampValue,
                    });
                    break;

                case 'FAILED': {
                    // Meta can deliver a FAILED status via the `statuses` array
                    // independently of (or instead of) the `calls.terminate` event.
                    // Use the same dedicated path that force-writes PROVIDER_ERROR
                    // and can upgrade an already-TERMINATED row.
                    // Only fill durations that the terminate webhook has not already set.
                    // finalizeCallAsFailed uses COALESCE — passing a non-null value here
                    // would override Meta's authoritative duration from the terminate webhook.
                    // Pass null when the value is already present so COALESCE preserves it.
                    const failedAnsweredAt = call.answered_at ? new Date(call.answered_at) : null;
                    const failedRingingAt = call.ringing_at ? new Date(call.ringing_at) : null;
                    const failedEndedAt = timestampValue;
                    const failedCallDuration = call.call_duration != null
                        ? null
                        : (failedAnsweredAt
                            ? Math.max(0, Math.floor((failedEndedAt - failedAnsweredAt) / 1000))
                            : 0);
                    const failedRingingDuration = call.ringing_duration != null
                        ? null
                        : ((failedRingingAt && failedAnsweredAt)
                            ? Math.max(0, Math.floor((failedAnsweredAt - failedRingingAt) / 1000))
                            : (failedRingingAt
                                ? Math.max(0, Math.floor((failedEndedAt - failedRingingAt) / 1000))
                                : null));
                    const failedFinalized = await CallRepository.finalizeCallAsFailed(callId, {
                        terminatedBy: TerminatedBy.WHATSAPP,
                        endedAt: failedEndedAt,
                        callDuration: failedCallDuration,
                        ringingDuration: failedRingingDuration,
                    });

                    // Gate all side-effects: if _handleCallTerminate already finalized this
                    // call as FAILED (common when Meta sends both a `statuses` FAILED entry
                    // AND a `calls.terminate` event), every effect below would fire twice.
                    // failedFinalized is false iff another path already set status=FAILED.
                    CallChatMessageRepository.finalize(callId, {
                        status: 'FAILED',
                        terminationReason: 'PROVIDER_ERROR',
                        callDuration: failedCallDuration ?? call.call_duration ?? 0,
                    }).catch((err) =>
                        console.error(`[Webhook:status/FAILED] finalize chat bubble failed for call ${callId}:`, err.message)
                    );

                    if (failedFinalized) {
                        emitCallError({ callId, code: null, message: 'Call failed (status webhook)' });

                        await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TERMINATED, {
                            callId,
                            userId: agentId,
                            reason: 'failed',
                        });

                        if (agentId) {
                            agentAssignmentCoordinator.releaseAgentIfIdle(agentId)
                                .catch((e) => console.error(`[Webhook:status/FAILED] Agent release error:`, e.message));
                            agentAssignmentCoordinator.emitQueueUpdate(call.business_id)
                                .catch(() => { });
                        }

                        callLifecycleLogger.logTerminated(callId, call.business_id, agentId, {
                            reason: 'FAILED',
                            terminated_by: TerminatedBy.WHATSAPP,
                            direction: call.direction,
                        }).catch(() => { });

                        EventBus.emit('call:terminated', {
                            callId,
                            businessId: call.business_id,
                            reason: 'whatsapp_termination',
                        });
                    }
                    break;
                }
            }

            EventBus.emit('call:status', {
                callId,
                businessId: call.business_id,
                status,
                // Lets clients distinguish "a different agent's call" from
                // "my own" for this webhook-driven broadcast — call.user_id
                // was already fetched above (see `agentId`), so this is free.
                // Deliberately no deviceId: that lives on call_connections,
                // not the calls row itself, and would need an extra query
                // this hot webhook path doesn't otherwise need — accepted
                // gap, see CallModel._onCallStatus's own doc comment.
                userId: agentId,
                ringingAt: status === 'RINGING' ? timestampValue.toISOString() : undefined,
                answeredAt: status === 'ACCEPTED' ? timestampValue.toISOString() : undefined,
            });

            console.log(`[Webhook:status] Updated call ${callId} to ${status}`);
        } catch (error) {
            console.error(`[Webhook:status] Error processing ${status} for wacid=${wacid}:`, error);
        }
    }

    // ── Connect handler ───────────────────────────────────────────────────────

    async _handleCallConnect(call, metadata, contact) {
        const { id: wacid, direction, session } = call;

        if (!session?.sdp || !session?.sdp_type || !['offer', 'answer'].includes(session.sdp_type.toLowerCase())) {
            console.error(`[Webhook:connect] Invalid session payload for call ${wacid}`);
            return;
        }

        const existingCall = await CallRepository.findByWacid(wacid);

        if (direction === 'USER_INITIATED' && session.sdp_type === 'offer') {
            if (existingCall) {
                console.warn(`[Webhook:connect] Call ${wacid} already exists, skipping`);
                return;
            }
            await this._handleIncomingCall(call, metadata, contact);
            return;
        }

        if (direction === 'BUSINESS_INITIATED' && session.sdp_type === 'answer') {
            if (!existingCall) {
                console.warn(`[Webhook:connect] No outgoing call found for wacid=${wacid}`);
                return;
            }
            if (existingCall.status !== CallStatus.INITIATED) {
                console.warn(`[Webhook:connect] Outgoing call ${existingCall.id} not in INITIATED state (${existingCall.status}), skipping`);
                return;
            }
            await this._handleOutgoingCall(call, existingCall);
        }
    }

    // ── Incoming call handler ─────────────────────────────────────────────────

    async _handleIncomingCall(call, metadata, contact) {
        const { id: wacid, from: callerNumber, to: calleeNumber, session, timestamp } = call;
        const phoneNumberId = metadata?.phone_number_id;
        const callerBsuid = contact?.user_id ?? null;

        try {
            const callee = await BusinessRepository.findBusinessNumberByPhoneId(phoneNumberId);
            if (!callee) return;

            const { business_id: businessId, display_name: calleeName, id: calleeId } = callee;

            const caller = await ClientRepository.findByPhoneOrBsuid(businessId, callerNumber, callerBsuid);
            if (!caller) {
                console.warn(`[Webhook:incoming] No client match for wacid=${wacid} (phone=${callerNumber ?? 'none'}, bsuid=${callerBsuid ?? 'none'}) — call dropped`);
                return;
            }
            if (!callerNumber && callerBsuid) {
                console.log(`[Webhook:incoming] Phone-less inbound call wacid=${wacid} resolved via bsuid to client=${caller.id}`);
            }

            const callerId = caller.id;
            const callerName = caller.name || contact?.profile?.name || 'Unknown';
            const callerUsername = caller.username ?? null;
            const ringingAt = timestamp ? new Date(Number(timestamp) * 1000) : new Date();

            // Out-of-order webhook: if `terminate` already arrived for this wacid
            // (and gave up after its retry), persist this call directly as a
            // missed call instead of ringing an agent.
            const tombRaw = await redisBaseService.get(tombstoneKey(wacid));
            if (tombRaw) {
                await this._handleMissedBeforeConnect({
                    wacid, businessId, calleeId, calleeName, calleeNumber,
                    callerId, callerName, callerUsername, callerNumber, ringingAt, tombRaw,
                });
                return;
            }

            // Dedup: Meta occasionally fires two `connect` webhooks with different WACIDs
            // for the same caller within milliseconds (relay retry on internal failure).
            // The per-WACID Redis ownership lock cannot catch this because the WACIDs differ.
            // Record the duplicate as CANCELLED for full audit trail, then return early —
            // no agent assignment, no frontend events, no SDP/WebRTC setup for the duplicate.
            // The `finally` block sees the TERMINATED call and cleans up Redis ownership.
            const activeCall = await CallRepository.findActiveInboundByClient(callerId, businessId);
            if (activeCall) {
                console.warn(
                    `[Webhook:incoming] Dedup: caller ${callerNumber ?? callerBsuid ?? callerId} already has active call ${activeCall.id} ` +
                    `(wacid=${activeCall.wacid}) for business ${businessId} — recording wacid ${wacid} as CANCELLED`
                );

                const dupCallId = await CallRepository.create({
                    wacid,
                    business_id: businessId,
                    business_number_id: calleeId,
                    client_number_id: callerId,
                    caller_name: callerName,
                    caller_username: callerUsername,
                    caller_number: callerNumber,
                    callee_name: calleeName,
                    callee_number: calleeNumber,
                    direction: CallDirection.INBOUND,
                    status: CallStatus.RINGING,
                    ringing_at: ringingAt,
                    is_billable: false,
                }).catch((err) => {
                    console.error(`[Webhook:incoming] Failed to record duplicate call for wacid ${wacid}:`, err.message);
                    return null;
                });

                if (dupCallId) {
                    await CallRepository.finalizeFromWebhook(dupCallId, {
                        status: CallStatus.TERMINATED,
                        terminationReason: TerminationReason.CANCELLED,
                        terminatedBy: TerminatedBy.SYSTEM,
                        endedAt: ringingAt,
                        answeredAt: null,
                        callDuration: 0,
                        ringingDuration: 0,
                    }).catch((err) =>
                        console.error(`[Webhook:incoming] Failed to finalize duplicate call ${dupCallId}:`, err.message)
                    );

                    callLifecycleLogger.logTerminated(dupCallId, businessId, null, {
                        reason: TerminationReason.CANCELLED,
                        terminated_by: TerminatedBy.SYSTEM,
                        direction: CallDirection.INBOUND,
                    }).catch(() => { });
                }

                return;
            }

            const isCallCenter = await BusinessRepository.isCallCentered(businessId);
            const routingSettings = isCallCenter
                ? await BusinessRepository.getCallRoutingSettings(businessId)
                : {
                    assignmentStrategy: RoutingStrategy.QUEUE,
                    receptionistTargetType: null,
                    receptionistTargetId: null,
                    receptionistAgentId: null,
                    receptionistGroupId: null,
                    priorityMode: 'AGENT_ORDER',
                    priorityGroupId: null,
                    priorityAgentIds: [],
                };
            const effectiveRouting = isCallCenter
                ? await this._resolveEffectiveRoutingForInboundCall(businessId, routingSettings)
                : {
                    assignmentStrategy: RoutingStrategy.QUEUE,
                    receptionistTargetType: null,
                    receptionistTargetId: null,
                    receptionistAgentId: null,
                    receptionistGroupId: null,
                    priorityMode: 'AGENT_ORDER',
                    priorityGroupId: null,
                    priorityAgentIds: [],
                };

            // Always check for an active IVR menu on the called number — IVR is a
            // per-number overlay that works alongside any routing strategy (QUEUE,
            // PRIORITY, RECEPTIONIST).  It is NOT itself a routing strategy.
            const activeIvrMenuId = isCallCenter
                ? await BusinessRepository.getActiveIvrMenuForNumber(calleeId, businessId, effectiveRouting)
                : null;

            const assignedAgent = (isCallCenter && !activeIvrMenuId)
                ? await this._findIncomingAssignee(businessId, effectiveRouting)
                : null;
            const userId = assignedAgent?.id ?? null;
            const agentName = assignedAgent?.name ?? null;

            const callId = await CallRepository.create({
                wacid,
                user_id: userId,
                business_id: businessId,
                business_number_id: calleeId,
                client_number_id: callerId,
                ivr_menu_id: activeIvrMenuId,
                // Set state='IVR' atomically at creation time when an IVR menu is active.
                // This closes the race window between INSERT and the later updateState('IVR')
                // call, preventing the queue manager from ever seeing this call as assignable.
                state: activeIvrMenuId ? 'IVR' : null,
                caller_name: callerName,
                caller_username: callerUsername,
                caller_number: callerNumber,
                callee_name: calleeName,
                callee_number: calleeNumber,
                direction: CallDirection.INBOUND,
                status: CallStatus.RINGING,
                ringing_at: ringingAt,
                is_billable: false,
                metadata: {
                    routing: {
                        strategy: effectiveRouting.assignmentStrategy,
                        assignmentStrategy: effectiveRouting.assignmentStrategy,
                        receptionistTargetType: effectiveRouting.receptionistTargetType,
                        receptionistTargetId: effectiveRouting.receptionistTargetId,
                        receptionistAgentId: effectiveRouting.receptionistAgentId,
                        receptionistGroupId: effectiveRouting.receptionistGroupId,
                        priorityMode: effectiveRouting.priorityMode,
                        priorityGroupId: effectiveRouting.priorityGroupId,
                        priorityAgentIds: effectiveRouting.priorityAgentIds,
                    },
                },
            });

            // Chat-timeline bubble: create the "ringing" call card now, in
            // parallel with ring fan-out — a chat_messages row that gets
            // patched in place once the call is finalized (see the various
            // finalize*/terminateCall call sites below). Best-effort: a
            // failure here must never block the call itself from ringing.
            CallChatMessageRepository.createRinging({
                id: callId,
                wacid,
                business_id: businessId,
                business_number_id: calleeId,
                client_number_id: callerId,
                direction: CallDirection.INBOUND,
                type: 'AUDIO',
            }).catch((err) =>
                console.error(`[Webhook:incoming] createRinging chat bubble failed for call ${callId}:`, err.message)
            );

            // Race safety net: a `terminate` webhook for this wacid can land
            // (and write its tombstone) AFTER our pre-check at line ~273 but
            // BEFORE this create finishes — both events run concurrently via
            // Promise.allSettled in `process()`. Without this re-check the
            // call would sit in RINGING forever because terminate has already
            // returned. Finalize as CANCELLED (inbound — direction shows client
            // gave up) and bail out before any ring fan-out happens.
            const lateTombstone = await redisBaseService.get(tombstoneKey(wacid));
            if (lateTombstone) {
                await CallRepository.finalizeFromWebhook(callId, {
                    status: CallStatus.TERMINATED,
                    terminationReason: TerminationReason.CANCELLED,
                    terminatedBy: TerminatedBy.CLIENT,
                    endedAt: ringingAt,
                    answeredAt: null,
                    callDuration: 0,
                    ringingDuration: 0,
                });
                if (userId) {
                    await agentAssignmentCoordinator.releaseAgentIfIdle(userId).catch((err) =>
                        console.error(`[Webhook:incoming] race-release agent ${userId} failed:`, err.message)
                    );
                }
                callLifecycleLogger.logTerminated(callId, businessId, userId ?? null, {
                    reason: 'TERMINATED',
                    terminated_by: TerminatedBy.CLIENT,
                    direction: CallDirection.INBOUND,
                    out_of_order_terminate: true,
                    race: 'connect_create_after_terminate_tombstone',
                }).catch((err) => console.error(`[Webhook:incoming] race-log error:`, err.message));
                await redisBaseService.del(tombstoneKey(wacid));
                EventBus.emit('call:terminated', {
                    callId,
                    businessId,
                    reason: 'whatsapp_termination_race',
                    terminationReason: TerminationReason.CANCELLED,
                });
                console.log(
                    `[Webhook:incoming] Race detected for ${wacid}: terminate tombstone written ` +
                    `during connect create. Finalized call ${callId} as CANCELLED.`
                );
                return;
            }

            if (userId) {
                const agentSocketCount = await presenceService.getUserSocketCount(userId);
                await callLifecycleLogger.logAssigned(callId, businessId, userId, {
                    assignment_type: AssignmentType.DIRECT,
                    routing_strategy: effectiveRouting.assignmentStrategy,
                    receptionist_agent_id: effectiveRouting.receptionistAgentId,
                    receptionist_group_id: effectiveRouting.receptionistGroupId,
                    receptionist_target_type: effectiveRouting.receptionistTargetType,
                    receptionist_target_id: effectiveRouting.receptionistTargetId,
                    agent_connected: agentSocketCount > 0,
                    agent_socket_count: agentSocketCount,
                });
            } else {
                await callLifecycleLogger.logQueued(callId, businessId, {
                    wacid,
                    routing_strategy: effectiveRouting.assignmentStrategy,
                    receptionist_agent_id: effectiveRouting.receptionistAgentId,
                    receptionist_group_id: effectiveRouting.receptionistGroupId,
                    receptionist_target_type: effectiveRouting.receptionistTargetType,
                    receptionist_target_id: effectiveRouting.receptionistTargetId,
                });
            }

            await CallConnectionRepository.create({
                call_id: callId,
                business_id: businessId,
                connection_type: ConnectionType.WHATSAPP,
                remote_sdp: session.sdp,
            });

            // ── IVR: auto-accept the WhatsApp call without waiting for an agent ──
            if (activeIvrMenuId) {
                console.log(`[Webhook:incoming] IVR call ${callId} — auto-accepting for menu ${activeIvrMenuId}`);
                const ivrAnsweredAt = new Date();
                const menuHeader = await IvrRepository.findMenuHeader(activeIvrMenuId, businessId).catch(() => null);
                try {
                    const whatsappSdpAnswer = await sdpCoordinator.createSDPAnswer(
                        callId, session.sdp, ConnectionType.WHATSAPP
                    );
                    await acceptWhatsAppCall(callId, whatsappSdpAnswer);
                    // Guarded (state='IVR' required) — acceptWhatsAppCall is a real
                    // ~400-600ms HTTP call to Meta, and for a trivial menu (no audio,
                    // straight to transfer) the whole IVR session can finish before it
                    // returns. An unguarded write here would revert a call that's
                    // already been transferred to the queue back to IN_PROGRESS/IVR,
                    // permanently — see markIvrAutoAccepted's own comment for why no
                    // cleanup scan can catch that state combination.
                    await CallRepository.markIvrAutoAccepted(callId);
                    await CallRepository.updateTimestamp(callId, 'answered_at', ivrAnsweredAt);
                    await callLifecycleLogger.logIvrAutoAccepted(callId, businessId, {
                        wacid,
                        ivr_menu_id: activeIvrMenuId,
                        ivr_menu_name: menuHeader?.name ?? null,
                        accepted_by: 'system',
                    });
                    console.log(`[Webhook:incoming] IVR call ${callId} accepted by system — IVR session will start on WhatsApp connection`);
                } catch (ivrErr) {
                    console.error(`[Webhook:incoming] IVR auto-accept failed for call ${callId}:`, ivrErr.message);
                }

                // Notify dashboard so managers can see the call — do NOT use QUEUED
                // since that would make the call appear as an acceptable queue item for agents.
                // IVR assignment type signals the frontend that this call is IVR-handled only.
                EventBus.emit('call:incoming', new IncomingCallPayload({
                    callId,
                    wacid,
                    businessId,
                    userId: null,
                    agentName: null,
                    callerId,
                    callerName,
                    callerUsername,
                    callerNumber,
                    calleeId,
                    calleeName,
                    calleeNumber,
                    status: CallStatus.IN_PROGRESS,
                    callState: 'IVR',
                    direction: CallDirection.INBOUND,
                    ringingAt,
                    startedAt: ivrAnsweredAt,
                    answeredAt: ivrAnsweredAt,
                    sdpOffer: null,
                    assignmentType: AssignmentType.IVR,
                    routingContext: {
                        strategy: effectiveRouting.assignmentStrategy,
                        ivrMenuId: activeIvrMenuId,
                    },
                    isCallCenter,
                }));
                return;
            }

            const sdpOffer = await sdpCoordinator.createSDPOffer(callId, ConnectionType.FRONTEND, callEventHandler.handleCallEvent);

            EventBus.emit('call:incoming', new IncomingCallPayload({
                callId,
                wacid,
                businessId,
                userId,
                agentName,
                callerId,
                callerName,
                callerUsername,
                callerNumber,
                calleeId,
                calleeName,
                calleeNumber,
                status: CallStatus.RINGING,
                direction: CallDirection.INBOUND,
                ringingAt,
                sdpOffer,
                assignmentType: userId ? AssignmentType.DIRECT : AssignmentType.QUEUED,
                routingContext: {
                    strategy: effectiveRouting.assignmentStrategy,
                    receptionistTargetType: effectiveRouting.receptionistTargetType,
                    receptionistTargetId: effectiveRouting.receptionistTargetId,
                    receptionistAgentId: effectiveRouting.receptionistAgentId,
                    receptionistGroupId: effectiveRouting.receptionistGroupId,
                    priorityMode: effectiveRouting.priorityMode,
                    priorityGroupId: effectiveRouting.priorityGroupId,
                    priorityAgentIds: effectiveRouting.priorityAgentIds,
                },
                isCallCenter,
            }));

            await this._sendIncomingCallNotification({ isCallCenter, userId, businessId, wacid, callerName, callerUsername, callerNumber, calleeName, calleeNumber });

            if (isCallCenter) {
                if (userId) {
                    // Claiming the agent (above, via _findAvailableAgent/_findPriorityAgent)
                    // already flips their DB availability to ON_CALL, but never told their
                    // own socket — only a manual toggle (setAvailability) or another
                    // device's sync previously broadcast this. Left unfixed, the agent's own
                    // standby screen kept showing stale AVAILABLE after minimizing the call.
                    EventBus.emit('call:agent_availability', {
                        businessId,
                        userId,
                        availability: AgentAvailability.ON_CALL,
                        updatedAt: new Date().toISOString(),
                    });
                }

                await agentAssignmentCoordinator.emitQueueUpdate(businessId);

                // If no agent was claimed at webhook time (all agents busy, or FIFO guard
                // deferred assignment), trigger the coordinator immediately so the call is
                // picked up as soon as an agent is free — for all routing strategies.
                if (!userId) {
                    agentAssignmentCoordinator.assignOldestUnassignedCall(businessId).catch((err) =>
                        console.error(`[Webhook:incoming] deferred assignment trigger failed for call ${callId}:`, err.message)
                    );
                }
            }
        } catch (error) {
            console.error(`[Webhook:incoming] Failed to handle call ${wacid}:`, error);
        }
    }

    // ── Missed-before-connect handler ─────────────────────────────────────────
    // Persists an inbound call directly as a missed call when its `terminate`
    // webhook arrived before the `connect` webhook. No agent is assigned and
    // no `call:incoming` is emitted, so no agent UI is involved. Manager
    // dashboards observe it through `call:incoming:business` (the standard
    // missed-call appearance) and through call history.
    async _handleMissedBeforeConnect({
        wacid, businessId, calleeId, calleeName, calleeNumber,
        callerId, callerName, callerUsername, callerNumber, ringingAt, tombRaw,
    }) {
        let payload = {};
        try { payload = JSON.parse(tombRaw) ?? {}; } catch { /* malformed tombstone — treat as empty */ }

        // Meta's terminate payload has no start_time/end_time/duration in this
        // case (no media ever flowed). Treat the call as instantaneous: the
        // ringing_at and ended_at coincide so call history renders 0s with
        // CANCELLED reason rather than a fabricated ring duration that would
        // suggest the agent ignored a real ring (INBOUND direction makes it
        // clear the client gave up before connect).
        const isFailed = payload.status === 'FAILED';
        const finalStatus = isFailed ? CallStatus.FAILED : CallStatus.TERMINATED;
        const terminationReason = isFailed ? TerminationReason.SYSTEM_ERROR : TerminationReason.CANCELLED;
        const endedAt = payload.end_time
            ? new Date(parseInt(payload.end_time) * 1000)
            : (payload.timestamp ? new Date(parseInt(payload.timestamp) * 1000) : ringingAt);

        // Create as RINGING (not terminal) so the finalize* call below can set
        // termination_reason and terminated_by. Creating directly as TERMINATED/FAILED
        // causes finalizeFromWebhook's Phase-2 guard (WHERE status NOT IN
        // ('TERMINATED','FAILED')) to be a no-op, leaving both fields null.
        const callId = await CallRepository.create({
            wacid,
            user_id: null,
            business_id: businessId,
            business_number_id: calleeId,
            client_number_id: callerId,
            caller_name: callerName,
            caller_username: callerUsername,
            caller_number: callerNumber,
            callee_name: calleeName,
            callee_number: calleeNumber,
            direction: CallDirection.INBOUND,
            status: CallStatus.RINGING,
            ringing_at: ringingAt,
            is_billable: false,
            metadata: {
                client_cancelled_immediately: !isFailed,
                out_of_order_terminate: true,
            },
        });

        if (isFailed) {
            await CallRepository.finalizeCallAsFailed(callId, {
                terminatedBy: TerminatedBy.WHATSAPP,
                endedAt,
                callDuration: 0,
                ringingDuration: 0,
            });
        } else {
            await CallRepository.finalizeFromWebhook(callId, {
                status: CallStatus.TERMINATED,
                terminationReason,
                terminatedBy: TerminatedBy.CLIENT,
                endedAt,
                answeredAt: null,
                callDuration: 0,
                ringingDuration: 0,
            });
        }

        // This path never went through the normal createRinging call site
        // (it branches off before that point) — the call was already over
        // by the time we learned about it, so create-then-immediately-finalize
        // the chat bubble here as a real missed call.
        CallChatMessageRepository.createRinging({
            id: callId,
            wacid,
            business_id: businessId,
            business_number_id: calleeId,
            client_number_id: callerId,
            direction: CallDirection.INBOUND,
            type: 'AUDIO',
        }).then(() => CallChatMessageRepository.finalize(callId, {
            status: finalStatus,
            terminationReason,
            callDuration: 0,
        })).catch((err) =>
            console.error(`[Webhook:missed-before-connect] chat bubble failed for call ${callId}:`, err.message)
        );

        if (isFailed && (payload.errors || payload.biz_opaque_callback_data)) {
            const callbackData = {};
            if (payload.errors) callbackData.errors = payload.errors;
            if (payload.biz_opaque_callback_data) callbackData.biz_opaque_callback_data = payload.biz_opaque_callback_data;
            if (Object.keys(callbackData).length) {
                await CallRepository.updateCallbackData(callId, callbackData);
            }
        }

        await redisBaseService.del(tombstoneKey(wacid));

        callLifecycleLogger.logQueued(callId, businessId, {
            wacid,
            out_of_order_terminate: true,
        }).catch((err) => console.error(`[Webhook:incoming] missed-call logQueued error:`, err.message));

        callLifecycleLogger.logTerminated(callId, businessId, null, {
            reason: finalStatus,
            terminated_by: TerminatedBy.CLIENT,
            direction: CallDirection.INBOUND,
            out_of_order_terminate: true,
        }).catch((err) => console.error(`[Webhook:incoming] missed-call logTerminated error:`, err.message));

        EventBus.emit('call:terminated', {
            callId,
            businessId,
            reason: 'whatsapp_termination_before_connect',
            terminationReason,
        });

        console.log(
            `[Webhook:incoming] Out-of-order terminate consumed for ${wacid}; ` +
            `created missed call ${callId} (no agent assigned, no ring).`
        );
    }

    // ── Outgoing call handler ─────────────────────────────────────────────────

    async _handleOutgoingCall(call, existingCall) {
        const { id: wacid, session } = call;
        const { id: callId, business_id: businessId, business_number_id: businessNumberId,
            client_number_id: clientNumberId, type: callType = 'AUDIO' } = existingCall;

        try {
            // Chat-timeline bubble: create the "ringing" call card now that Meta
            // has confirmed the outbound call is actually placed — same
            // createRinging() this system uses for inbound calls in
            // _handleIncomingCall, just triggered by the answer/connect webhook
            // instead of call creation (an outbound call's wacid, and therefore
            // its ability to be looked up by finalize() later, only exists from
            // this point on). Best-effort: a failure here must never block the
            // call itself from connecting.
            CallChatMessageRepository.createRinging({
                id: callId,
                wacid,
                business_id: businessId,
                business_number_id: businessNumberId,
                client_number_id: clientNumberId,
                direction: CallDirection.OUTBOUND,
                type: callType,
            }).catch((err) =>
                console.error(`[Webhook:outgoing] createRinging chat bubble failed for call ${callId}:`, err.message)
            );

            await redisPubSubService.publishCallEvent(callId, EventTypes.WHATSAPP_ANSWER_RECEIVED, {
                callId,
                wacid,
                sdpAnswer: session.sdp,
            });
        } catch (error) {
            console.error(`[Webhook:outgoing] Error handling call ${wacid}:`, error.message);
            throw error;
        }
    }

    // ── Terminate handler ─────────────────────────────────────────────────────

    async _handleCallTerminate(call) {
        const { id: wacid, status, duration, start_time, end_time, timestamp, errors, biz_opaque_callback_data } = call;

        try {
            let existingCall = await CallRepository.findByWacid(wacid);

            if (!existingCall) {
                await new Promise(resolve => setTimeout(resolve, 300));
                existingCall = await CallRepository.findByWacid(wacid);
                if (!existingCall) {
                    // Out-of-order delivery: terminate beat connect to us. Leave
                    // a tombstone so the late `connect` can persist the row as
                    // a missed call instead of ringing an agent for a call that
                    // Meta has already finished.
                    const tombstonePayload = JSON.stringify({
                        wacid,
                        status: status ?? null,
                        duration: duration ?? null,
                        start_time: start_time ?? null,
                        end_time: end_time ?? null,
                        timestamp: timestamp ?? null,
                        errors: errors ?? null,
                        biz_opaque_callback_data: biz_opaque_callback_data ?? null,
                        recordedAt: Date.now(),
                    });
                    await redisBaseService.setnx(
                        tombstoneKey(wacid),
                        tombstonePayload,
                        TERMINATE_TOMBSTONE_TTL_SECONDS
                    );
                    console.warn(
                        `[Webhook:terminate] Out-of-order: no row for ${wacid} after retry; ` +
                        `recorded tombstone (TTL ${TERMINATE_TOMBSTONE_TTL_SECONDS}s) for late connect`
                    );
                    return;
                }
            }

            const {
                id: callId,
                user_id: userId,
                business_id: businessId,
                status: existingStatus,
                ringing_at: ringingAt,
                answered_at: existingAnsweredAt,
                ended_at: existingEndedAt,
                callback_data: existingCallbackDataRaw,
                direction,
            } = existingCall;

            // mysql2 returns JSON columns as already-parsed objects; guard against
            // string form in case the driver or a test fixture serialises it.
            let existingCallbackData = null;
            if (existingCallbackDataRaw) {
                if (typeof existingCallbackDataRaw === 'string') {
                    try {
                        existingCallbackData = JSON.parse(existingCallbackDataRaw);
                    } catch {
                        console.warn(
                            `[Webhook:terminate] Malformed callback_data for call ${callId} — treating as null. Raw: ${existingCallbackDataRaw}`
                        );
                    }
                } else {
                    existingCallbackData = existingCallbackDataRaw;
                }
            }

            // ── Parse Meta's authoritative timing payload ────────────────────────
            // Meta sends start_time/end_time/duration in the termination webhook
            // (unix seconds, integer). For no-answer / pre-connect terminations
            // start_time is absent. For FAILED or client network-loss terminations
            // end_time/duration may also be absent — but `timestamp` (the event
            // generation time) is always present and is the best available proxy
            // for ended_at when end_time is missing.
            const answeredAt = start_time ? new Date(parseInt(start_time) * 1000) : null;
            const endedAt = end_time
                ? new Date(parseInt(end_time) * 1000)
                : (timestamp ? new Date(parseInt(timestamp) * 1000) : null);
            const metaDurationSec = duration ? parseInt(duration) : null;

            // ── Derive call_duration even if Meta omits it ───────────────────────
            // Fallback: compute from answeredAt..endedAt. Skip if we can't.
            const effectiveAnsweredAt = answeredAt ?? (existingAnsweredAt ? new Date(existingAnsweredAt) : null);
            const effectiveEndedAt = endedAt ?? (existingEndedAt ? new Date(existingEndedAt) : new Date());
            let callDurationSec = metaDurationSec;
            if (callDurationSec == null) {
                if (effectiveAnsweredAt && effectiveEndedAt) {
                    callDurationSec = Math.max(0, Math.floor((effectiveEndedAt - effectiveAnsweredAt) / 1000));
                } else {
                    callDurationSec = 0;
                }
            }

            // ── Derive ringing_duration from our own ringing_at + Meta's answer ──
            // Use effectiveAnsweredAt (Meta's start_time ?? DB answered_at) so that
            // calls already marked FAILED by a local detection path (e.g.
            // CUSTOMER_NETWORK_LOSS) still produce the correct ringing_duration when
            // Meta's terminate webhook omits start_time — without this fallback the
            // code lands in the !answeredAt branch and measures from ringing_at to
            // end_time/now, producing ringing_duration ≈ call_duration + ring_time.
            let ringingDurationSec = null;
            if (ringingAt && effectiveAnsweredAt) {
                ringingDurationSec = Math.max(0, Math.floor((effectiveAnsweredAt - new Date(ringingAt)) / 1000));
            } else if (ringingAt && !effectiveAnsweredAt) {
                // Call ended in ringing (no answer): use Meta's end_time, else now.
                const ringingEnd = endedAt ?? new Date();
                ringingDurationSec = Math.max(0, Math.floor((ringingEnd - new Date(ringingAt)) / 1000));
            }

            // ── Determine whether Meta is signalling a provider failure ─────────────
            // Meta should set status='FAILED' for provider errors, but some error codes
            // (e.g. 138019 — "WhatsApp client failed to setup the call", 138021 — "no
            // media") arrive with a non-FAILED status while still populating the errors
            // array. Treat any webhook with a non-empty errors array as a provider
            // failure so these calls are finalized as FAILED + PROVIDER_ERROR instead
            // of being silently recorded as COMPLETED.
            const isFailed = status === 'FAILED' || (Array.isArray(errors) && errors.length > 0);

            // ── Choose termination_reason ─────────────────────────────────────────
            // Priority order (highest to lowest):
            //
            //  1. PROVIDER_ERROR — Meta failed the call (status=FAILED or errors present).
            //
            //  2. CANCELLED / NO_ANSWER — Meta has no start_time (answeredAt)
            //     and the call was still in a pre-connect state on our side:
            //       INBOUND  <5s ringing → CANCELLED (caller gave up instantly;
            //                              direction = INBOUND makes it obvious)
            //       INBOUND ≥5s ringing → NO_ANSWER (agent had time, didn't pick up)
            //       OUTBOUND              → NO_ANSWER (callee didn't answer)
            //
            //  3. CANCELLED — Meta has no start_time AND our record shows the
            //     agent had already accepted (IN_PROGRESS). This is the race case:
            //     client cancelled at the exact moment the agent clicked Accept, so
            //     our side set answered_at but Meta's WebRTC handshake never finished.
            //     Marking as COMPLETED would be inaccurate — the call had zero real
            //     connected duration from Meta's perspective.
            //
            //  4. COMPLETED — catch-all for all other cases (Meta sent start_time,
            //     meaning the media session was genuinely established).
            let terminationReason = TerminationReason.COMPLETED;
            if (isFailed) {
                terminationReason = TerminationReason.PROVIDER_ERROR;
            } else if (!answeredAt) {
                if (ringingDurationSec == null) ringingDurationSec = 0;
                if (existingStatus === CallStatus.INITIATED || existingStatus === CallStatus.RINGING) {
                    // Normal unanswered path.
                    const isInbound = direction === CallDirection.INBOUND;
                    terminationReason = (isInbound && ringingDurationSec < 5)
                        ? TerminationReason.CANCELLED
                        : TerminationReason.NO_ANSWER;
                } else if (existingStatus === CallStatus.IN_PROGRESS) {
                    // Agent accepted locally but Meta never confirmed the WebRTC
                    // handshake (no start_time in the terminate webhook). The client
                    // cancelled at the same instant the agent accepted, so the session
                    // never actually carried audio. Not COMPLETED — nothing was exchanged.
                    terminationReason = TerminationReason.CANCELLED;
                }
                // For already-terminal states (TERMINATED, FAILED) this webhook is
                // late and finalizeFromWebhook's Phase-2 guard will be a no-op anyway.
            }

            // `terminated_by` priority: preserve whatever the business socket path
            // already stamped (that's the truth — this user clicked Hang-up). If no
            // one else set it, fall back to CLIENT for normal terminations / SYSTEM
            // for provider failures.
            const webhookTerminatedBy = isFailed ? TerminatedBy.WHATSAPP : TerminatedBy.CLIENT;

            // ── Persist the finalized state ──────────────────────────────────────
            // For failed webhooks we use a dedicated path that:
            //   (a) force-writes PROVIDER_ERROR (never COALESCE'd — the provider
            //       failure reason must not be masked by a previously-set COMPLETED),
            //   (b) allows upgrading an already-TERMINATED row to FAILED, because a
            //       TERMINATED/COMPLETED record that Meta later marks as FAILED is
            //       simply wrong and must be corrected.
            // For all other terminations the normal finalizeFromWebhook handles it
            // (COALESCE-preserves terminated_by, guards against re-finalization).
            let finalizedByThisWebhook;
            if (isFailed) {
                finalizedByThisWebhook = await CallRepository.finalizeCallAsFailed(callId, {
                    terminatedBy: webhookTerminatedBy,
                    endedAt,
                    answeredAt,
                    callDuration: callDurationSec,
                    ringingDuration: ringingDurationSec,
                });
            } else {
                finalizedByThisWebhook = await CallRepository.finalizeFromWebhook(callId, {
                    status: 'TERMINATED',
                    terminationReason,
                    terminatedBy: webhookTerminatedBy,
                    endedAt,
                    answeredAt,
                    callDuration: callDurationSec,
                    ringingDuration: ringingDurationSec,
                });
            }

            // Chat-timeline bubble: patch the call card to its final state.
            // Unconditional (not gated on finalizedByThisWebhook) — idempotent,
            // and a race where another path already flipped `calls.status`
            // may still be the first to carry the real duration/reason here.
            CallChatMessageRepository.finalize(callId, {
                status: isFailed ? 'FAILED' : 'TERMINATED',
                terminationReason: isFailed ? 'PROVIDER_ERROR' : terminationReason,
                callDuration: callDurationSec,
            }).catch((err) =>
                console.error(`[Webhook:terminate] finalize chat bubble failed for call ${callId}:`, err.message)
            );

            // Persist callback_data / emit error for failed/error webhooks.
            // Merge Meta's errors with any internal errors already written by
            // our local detection paths (e.g. NETWORK_ERROR, CUSTOMER_NETWORK_LOSS).
            // Internal errors occupy codes 90xxx; Meta uses 1380xx — no collision.
            if (isFailed) {
                const metaErrors = errors ?? [];
                const metaExtra = {};
                if (metaErrors.length > 0) metaExtra.errors = metaErrors;
                if (biz_opaque_callback_data) metaExtra.biz_opaque_callback_data = biz_opaque_callback_data;

                if (Object.keys(metaExtra).length) {
                    const existing = existingCallbackData ?? {};
                    const merged = {
                        ...existing,
                        ...metaExtra,
                        // Internal errors first, then Meta errors — preserves chronological order.
                        errors: [...(existing.errors ?? []), ...(metaExtra.errors ?? [])],
                    };
                    await CallRepository.updateCallbackData(callId, merged);
                }

                emitCallError({ callId, code: errors?.[0]?.code, message: errors?.[0]?.title });

                // When the call was already FAILED by a local detection path
                // (e.g. CUSTOMER_NETWORK_LOSS), Phase 2 of finalizeCallAsFailed is
                // blocked, leaving terminated_by=SYSTEM even though Meta's error code
                // tells us who was at fault. Patch it now based on the first error code:
                //   relay-side errors (138019, 138020, 138021) → WHATSAPP
                //   client-side errors (138022 and others)     → CLIENT
                if (!finalizedByThisWebhook && errors?.length > 0) {
                    const relayErrors = new Set([138019, 138020, 138021]);
                    const metaTerminatedBy = relayErrors.has(errors[0].code)
                        ? TerminatedBy.WHATSAPP
                        : TerminatedBy.CLIENT;
                    await CallRepository.updateTerminatedByIfFailed(callId, metaTerminatedBy);
                }
            }

            // Safety net: if Meta omitted end_time and nothing else wrote ended_at
            // (e.g. the call was already FAILED from a local detection path that
            // predates Fix 1, or ran on a different worker), stamp it now so the
            // field is never left null after the webhook is fully processed.
            if (!endedAt && !existingEndedAt) {
                await CallRepository.updateTimestamp(callId, 'ended_at');
            }

            // ── Post-termination side effects ─────────────────────────────────────
            // `finalizedByThisWebhook` is true only when the Phase-2 status flip
            // actually happened — i.e. the business socket path hadn't already
            // committed TERMINATED. That's the correct once-only gate: the business
            // handler already released the agent / logged when it won the race.
            if (finalizedByThisWebhook && userId) {
                try {
                    if (direction === CallDirection.OUTBOUND) {
                        await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(userId);
                    } else {
                        await agentAssignmentCoordinator.releaseAgentIfIdle(userId);
                        await agentAssignmentCoordinator.assignOldestUnassignedCall(businessId);
                    }
                    await agentAssignmentCoordinator.emitQueueUpdate(businessId);
                } catch (err) {
                    console.error(`[Webhook:terminate] Agent release error for call ${wacid}:`, err.message);
                }

                // ── Auto-offline policy: consecutive NO_ANSWER on QUEUE mode ──
                // Only count "real" missed calls — not CANCELLED (caller
                // hung up before any reasonable ring) and not REJECTED (active
                // decline by the agent goes through RejectionEventHandler and
                // never reaches here because that path already finalized the
                // row, so finalizedByThisWebhook is false). Outbound is also
                // excluded — semantics don't fit ("missed" by who?).
                if (direction === CallDirection.INBOUND
                    && terminationReason === TerminationReason.NO_ANSWER) {
                    try {
                        const routing = await BusinessRepository.getCallRoutingSettings(businessId);
                        if (String(routing.assignmentStrategy).toUpperCase() === RoutingStrategy.QUEUE) {
                            const policy = await BusinessRepository.getAutoOfflineSettings(businessId);
                            if (policy.enabled) {
                                // Guard: if the agent is currently on an active call, this NO_ANSWER
                                // was caused by a race-condition double-dispatch (two calls assigned
                                // simultaneously). Don't penalize the agent — they were not negligent.
                                const agentIsOnActiveCall = await CallRepository.hasAgentActiveCall(userId, callId);
                                if (agentIsOnActiveCall) {
                                    console.log(
                                        `[AutoOffline] Skipping missed-streak for agent ${userId} — agent is on ` +
                                        `an active call (business=${businessId}, missed=${callId})`
                                    );
                                } else {
                                    const streak = await agentMissedCallTracker.increment(userId);
                                    console.log(
                                        `[AutoOffline] Agent ${userId} missed-streak=${streak}/${policy.threshold} ` +
                                        `(business=${businessId}, call=${callId})`
                                    );
                                    if (streak >= policy.threshold) {
                                        const flipped = await AgentRepository.updateAgentAvailability(userId, AgentAvailability.OFFLINE);
                                        await agentMissedCallTracker.reset(userId);
                                        if (flipped) {
                                            EventBus.emit('call:agent_availability', {
                                                businessId,
                                                userId,
                                                availability: AgentAvailability.OFFLINE,
                                                reason: 'auto_offline_missed_calls',
                                                consecutiveMissed: streak,
                                                updatedAt: new Date().toISOString(),
                                            });
                                            await agentAssignmentCoordinator.emitQueueUpdate(businessId).catch(() => { });
                                            console.log(
                                                `[AutoOffline] Flipped agent ${userId} OFFLINE after ${streak} consecutive ` +
                                                `missed calls (threshold=${policy.threshold}, business=${businessId})`
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error(`[AutoOffline] policy check failed for agent ${userId}:`, err.message);
                    }
                }
            }

            if (finalizedByThisWebhook) {
                callLifecycleLogger.logTerminated(callId, businessId, userId ?? null, {
                    reason: isFailed ? 'FAILED' : status,
                    terminated_by: TerminatedBy.WHATSAPP,
                    direction,
                }).catch((err) => {
                    console.error(`[Webhook:terminate] Lifecycle log error for call ${wacid}:`, err.message);
                });
            }

            // Only publish and broadcast when this webhook actually caused the status
            // transition. If the business socket path already terminated the call,
            // finalizedByThisWebhook=false and the owning worker already closed the peer
            // and notified the frontend — publishing again sends a duplicate call:terminated
            // event to every connected client for that business.
            if (finalizedByThisWebhook) {
                await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TERMINATED, {
                    callId,
                    userId: userId ?? null,
                    reason: isFailed ? 'failed' : 'completed',
                });

                EventBus.emit('call:terminated', { callId, businessId, reason: 'whatsapp_termination' });
            }
        } catch (error) {
            console.error(`[Webhook:terminate] Error for call ${wacid}:`, error.message);
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    async _findAvailableAgent(businessId) {
        try {
            const agents = await AgentRepository.getCallCenterAgents(businessId);
            const availableAgents = agents.filter(a => a.call_availability === AgentAvailability.AVAILABLE);
            if (!availableAgents.length) return null;

            return await callAgentAssignmentService.pickAgentForBusiness(
                businessId,
                agents,
                async (agentId) => AgentRepository.claimAgentIfAvailable(agentId)
            );
        } catch (err) {
            console.error(`[Webhook:incoming] Agent selection error for business ${businessId}:`, err.message);
            return null;
        }
    }

    async _findPriorityAgent(businessId, effectiveRouting = {}) {
        try {
            const agents = await AgentRepository.getCallCenterAgents(businessId);
            const mode = String(effectiveRouting?.priorityMode || 'AGENT_ORDER').toUpperCase();

            if (mode === 'GROUP_LEAD_FIRST' && effectiveRouting?.priorityGroupId) {
                const groupAgents = await UserGroupRepository.getCallCenterAgentsForGroup(
                    businessId,
                    effectiveRouting.priorityGroupId
                );
                const availableGroupAgents = groupAgents.filter(
                    (agent) => agent.call_availability === AgentAvailability.AVAILABLE
                );
                if (!availableGroupAgents.length) {
                    return null;
                }

                const leadIds = availableGroupAgents
                    .filter((agent) => String(agent.group_role || '').toUpperCase() === 'LEAD')
                    .sort((a, b) => Number(a.id) - Number(b.id))
                    .map((agent) => agent.id);

                const memberIds = availableGroupAgents
                    .filter((agent) => String(agent.group_role || '').toUpperCase() !== 'LEAD')
                    .sort((a, b) => Number(a.id) - Number(b.id))
                    .map((agent) => agent.id);

                return await callAgentAssignmentService.pickPriorityAgentForBusinessByOrder(
                    businessId,
                    [...leadIds, ...memberIds],
                    availableGroupAgents,
                    async (agentId) => AgentRepository.claimAgentIfAvailable(agentId)
                );
            }

            const availableAgents = agents.filter(a => a.call_availability === AgentAvailability.AVAILABLE);
            if (!availableAgents.length) return null;

            return await callAgentAssignmentService.pickPriorityAgentForBusinessByOrder(
                businessId,
                Array.isArray(effectiveRouting?.priorityAgentIds) ? effectiveRouting.priorityAgentIds : [],
                availableAgents,
                async (agentId) => AgentRepository.claimAgentIfAvailable(agentId)
            );
        } catch (err) {
            console.error(`[Webhook:incoming] Priority selection error for business ${businessId}:`, err.message);
            return null;
        }
    }

    async _findIncomingAssignee(businessId, effectiveRouting) {
        // FIFO guard: if there are calls already waiting for an agent, this new call
        // must also queue so it never jumps ahead of earlier arrivals. This applies to
        // all routing strategies — a PRIORITY or RECEPTIONIST call arriving while older
        // calls are unassigned would otherwise steal an agent from them.
        // Only attempt synchronous claim when the queue is empty.
        try {
            const hasQueued = await CallRepository.hasUnassignedCalls(businessId);
            if (hasQueued) {
                return null;
            }
        } catch (err) {
            console.error(`[Webhook:incoming] FIFO guard query failed for business ${businessId} — skipping sync claim:`, err.message);
            return null;
        }

        if (effectiveRouting?.assignmentStrategy === RoutingStrategy.PRIORITY) {
            return this._findPriorityAgent(businessId, effectiveRouting);
        }

        if (
            effectiveRouting?.assignmentStrategy === RoutingStrategy.RECEPTIONIST
            && effectiveRouting?.receptionistTargetType === 'agent'
            && effectiveRouting?.receptionistAgentId
        ) {
            try {
                const receptionistClaimed = await AgentRepository.claimAgentIfAvailable(effectiveRouting.receptionistAgentId);
                if (receptionistClaimed) {
                    const receptionist = await AgentRepository.findUserById(effectiveRouting.receptionistAgentId);
                    if (receptionist) {
                        console.log(
                            `[Webhook:incoming] Assigned receptionist agent ${effectiveRouting.receptionistAgentId} ` +
                            `for business=${businessId}`
                        );
                        return receptionist;
                    }
                }

                console.warn(
                    `[Webhook:incoming] Receptionist ${effectiveRouting.receptionistAgentId} unavailable for ` +
                    `business=${businessId}; call will remain queued`
                );
                return null;
            } catch (err) {
                console.error(
                    `[Webhook:incoming] Receptionist assignment error for business ${businessId}:`,
                    err
                );
                return null;
            }
        }

        if (
            effectiveRouting?.assignmentStrategy === RoutingStrategy.RECEPTIONIST
            && effectiveRouting?.receptionistTargetType === 'group'
            && effectiveRouting?.receptionistGroupId
        ) {
            try {
                const availableGroupAgents = await UserGroupRepository.getAvailableCallCenterAgentsForGroup(
                    businessId,
                    effectiveRouting.receptionistGroupId
                );

                if (!availableGroupAgents.length) {
                    console.warn(
                        `[Webhook:incoming] Receptionist group ${effectiveRouting.receptionistGroupId} has no available agents ` +
                        `for business=${businessId}; call will remain queued`
                    );
                    return null;
                }

                const selectedAgent = await callAgentAssignmentService.pickAgentForGroup(
                    businessId,
                    effectiveRouting.receptionistGroupId,
                    availableGroupAgents,
                    async (agentId) => AgentRepository.claimAgentIfAvailable(agentId)
                );

                if (selectedAgent) {
                    console.log(
                        `[Webhook:incoming] Assigned receptionist group agent ${selectedAgent.id} ` +
                        `from group=${effectiveRouting.receptionistGroupId} for business=${businessId}`
                    );
                    return selectedAgent;
                }

                console.warn(
                    `[Webhook:incoming] Could not claim any available agent from receptionist group ` +
                    `${effectiveRouting.receptionistGroupId} for business=${businessId}; call will remain queued`
                );
                return null;
            } catch (err) {
                console.error(
                    `[Webhook:incoming] Receptionist group assignment error for business ${businessId}:`,
                    err
                );
                return null;
            }
        }

        // QUEUE (and any unrecognized strategy): claim any available agent.
        // The FIFO guard above already ensures no older calls are waiting,
        // so synchronous claiming here does not violate arrival order.
        return this._findAvailableAgent(businessId);
    }

    async _resolveEffectiveRoutingForInboundCall(businessId, routingSettings) {
        const configuredStrategy = routingSettings?.assignmentStrategy || RoutingStrategy.QUEUE;
        const configuredTargetType = String(routingSettings?.receptionistTargetType || '').toLowerCase();
        const configuredTargetId = Number.isFinite(Number(routingSettings?.receptionistTargetId))
            ? Number(routingSettings.receptionistTargetId)
            : null;
        const configuredPriorityMode = String(routingSettings?.priorityMode || 'AGENT_ORDER').toUpperCase();
        const configuredPriorityGroupId = Number.isFinite(Number(routingSettings?.priorityGroupId))
            ? Number(routingSettings.priorityGroupId)
            : null;
        const configuredPriorityAgentIds = Array.isArray(routingSettings?.priorityAgentIds)
            ? routingSettings.priorityAgentIds
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id))
            : [];
        const configuredReceptionistId = Number.isFinite(Number(routingSettings?.receptionistAgentId))
            ? Number(routingSettings.receptionistAgentId)
            : null;
        const configuredReceptionistGroupId = Number.isFinite(Number(routingSettings?.receptionistGroupId))
            ? Number(routingSettings.receptionistGroupId)
            : null;

        if (configuredStrategy === RoutingStrategy.PRIORITY) {
            if (configuredPriorityMode === 'GROUP_LEAD_FIRST') {
                if (!configuredPriorityGroupId) {
                    console.warn(
                        `[Webhook:incoming] priority fallback to QUEUE for business=${businessId}: missing priority_group_id`
                    );
                    return {
                        assignmentStrategy: RoutingStrategy.QUEUE,
                        receptionistTargetType: null,
                        receptionistTargetId: null,
                        receptionistAgentId: null,
                        receptionistGroupId: null,
                        priorityMode: 'AGENT_ORDER',
                        priorityGroupId: null,
                        priorityAgentIds: [],
                    };
                }

                const group = await UserGroupRepository.findByIdForBusiness(configuredPriorityGroupId, businessId);
                if (!group) {
                    console.warn(
                        `[Webhook:incoming] priority fallback to QUEUE for business=${businessId}: invalid priority_group_id=${configuredPriorityGroupId}`
                    );
                    return {
                        assignmentStrategy: RoutingStrategy.QUEUE,
                        receptionistTargetType: null,
                        receptionistTargetId: null,
                        receptionistAgentId: null,
                        receptionistGroupId: null,
                        priorityMode: 'AGENT_ORDER',
                        priorityGroupId: null,
                        priorityAgentIds: [],
                    };
                }

                const groupAgents = await UserGroupRepository.getCallCenterAgentsForGroup(businessId, configuredPriorityGroupId);
                if (!groupAgents.length) {
                    console.warn(
                        `[Webhook:incoming] priority fallback to QUEUE for business=${businessId}: selected priority group has no call-center agents`
                    );
                    return {
                        assignmentStrategy: RoutingStrategy.QUEUE,
                        receptionistTargetType: null,
                        receptionistTargetId: null,
                        receptionistAgentId: null,
                        receptionistGroupId: null,
                        priorityMode: 'AGENT_ORDER',
                        priorityGroupId: null,
                        priorityAgentIds: [],
                    };
                }

                return {
                    assignmentStrategy: RoutingStrategy.PRIORITY,
                    receptionistTargetType: configuredTargetType || null,
                    receptionistTargetId: configuredTargetId,
                    receptionistAgentId: configuredReceptionistId,
                    receptionistGroupId: configuredReceptionistGroupId,
                    priorityMode: 'GROUP_LEAD_FIRST',
                    priorityGroupId: configuredPriorityGroupId,
                    priorityAgentIds: [],
                };
            }

            const agents = await AgentRepository.getCallCenterAgents(businessId);
            const eligibleAgentIds = new Set(agents.map((agent) => Number(agent.id)));
            const normalizedPriorityAgentIds = configuredPriorityAgentIds
                .filter((id) => eligibleAgentIds.has(Number(id)));

            if (!normalizedPriorityAgentIds.length) {
                console.warn(
                    `[Webhook:incoming] priority fallback to QUEUE for business=${businessId}: missing/invalid priority_agent_ids`
                );
                return {
                    assignmentStrategy: RoutingStrategy.QUEUE,
                    receptionistTargetType: null,
                    receptionistTargetId: null,
                    receptionistAgentId: null,
                    receptionistGroupId: null,
                    priorityMode: 'AGENT_ORDER',
                    priorityGroupId: null,
                    priorityAgentIds: [],
                };
            }

            return {
                assignmentStrategy: RoutingStrategy.PRIORITY,
                receptionistTargetType: configuredTargetType || null,
                receptionistTargetId: configuredTargetId,
                receptionistAgentId: configuredReceptionistId,
                receptionistGroupId: configuredReceptionistGroupId,
                priorityMode: 'AGENT_ORDER',
                priorityGroupId: null,
                priorityAgentIds: normalizedPriorityAgentIds,
            };
        }

        if (configuredStrategy !== RoutingStrategy.RECEPTIONIST) {
            return {
                assignmentStrategy: configuredStrategy,
                receptionistTargetType: configuredTargetType || null,
                receptionistTargetId: configuredTargetId,
                receptionistAgentId: configuredReceptionistId,
                receptionistGroupId: configuredReceptionistGroupId,
                priorityMode: configuredPriorityMode,
                priorityGroupId: configuredPriorityGroupId,
                priorityAgentIds: configuredPriorityAgentIds,
            };
        }

        const hasTypedTarget = ['agent', 'group'].includes(configuredTargetType) && configuredTargetId;
        const fallbackTargetType = configuredReceptionistId ? 'agent' : null;
        const fallbackTargetId = configuredReceptionistId || null;
        const resolvedTargetType = hasTypedTarget ? configuredTargetType : fallbackTargetType;
        const resolvedTargetId = hasTypedTarget ? configuredTargetId : fallbackTargetId;

        if (!resolvedTargetType || !resolvedTargetId) {
            console.warn(
                `[Webhook:incoming] receptionist fallback to QUEUE for business=${businessId}: missing receptionist target`
            );
            return {
                assignmentStrategy: RoutingStrategy.QUEUE,
                receptionistTargetType: null,
                receptionistTargetId: null,
                receptionistAgentId: null,
                receptionistGroupId: null,
                priorityMode: 'AGENT_ORDER',
                priorityGroupId: null,
                priorityAgentIds: [],
            };
        }

        if (resolvedTargetType === 'agent') {
            const agents = await AgentRepository.getCallCenterAgents(businessId);
            const receptionistExists = agents.some((agent) => Number(agent.id) === resolvedTargetId);

            if (!receptionistExists) {
                console.warn(
                    `[Webhook:incoming] receptionist fallback to QUEUE for business=${businessId}: ` +
                    `configured receptionist_agent_id=${resolvedTargetId} is not a call-center agent`
                );
                return {
                    assignmentStrategy: RoutingStrategy.QUEUE,
                    receptionistTargetType: null,
                    receptionistTargetId: null,
                    receptionistAgentId: null,
                    receptionistGroupId: null,
                    priorityMode: 'AGENT_ORDER',
                    priorityGroupId: null,
                    priorityAgentIds: [],
                };
            }

            return {
                assignmentStrategy: RoutingStrategy.RECEPTIONIST,
                receptionistTargetType: 'agent',
                receptionistTargetId: resolvedTargetId,
                receptionistAgentId: resolvedTargetId,
                receptionistGroupId: null,
                priorityMode: 'AGENT_ORDER',
                priorityGroupId: null,
                priorityAgentIds: [],
            };
        }

        const group = await UserGroupRepository.findByIdForBusiness(resolvedTargetId, businessId);
        if (!group) {
            console.warn(
                `[Webhook:incoming] receptionist fallback to QUEUE for business=${businessId}: ` +
                `configured receptionist_group_id=${resolvedTargetId} not found`
            );
            return {
                assignmentStrategy: RoutingStrategy.QUEUE,
                receptionistTargetType: null,
                receptionistTargetId: null,
                receptionistAgentId: null,
                receptionistGroupId: null,
                priorityMode: 'AGENT_ORDER',
                priorityGroupId: null,
                priorityAgentIds: [],
            };
        }

        const groupAgents = await UserGroupRepository.getCallCenterAgentsForGroup(businessId, resolvedTargetId);
        if (!groupAgents.length) {
            console.warn(
                `[Webhook:incoming] receptionist fallback to QUEUE for business=${businessId}: ` +
                `configured receptionist_group_id=${resolvedTargetId} has no call-center agents`
            );
            return {
                assignmentStrategy: RoutingStrategy.QUEUE,
                receptionistTargetType: null,
                receptionistTargetId: null,
                receptionistAgentId: null,
                receptionistGroupId: null,
                priorityMode: 'AGENT_ORDER',
                priorityGroupId: null,
                priorityAgentIds: [],
            };
        }

        return {
            assignmentStrategy: RoutingStrategy.RECEPTIONIST,
            receptionistTargetType: 'group',
            receptionistTargetId: resolvedTargetId,
            receptionistAgentId: null,
            receptionistGroupId: resolvedTargetId,
            priorityMode: 'AGENT_ORDER',
            priorityGroupId: null,
            priorityAgentIds: [],
        };
    }

    async _sendIncomingCallNotification({ isCallCenter, userId, businessId, wacid, callerName, callerUsername, callerNumber, calleeName, calleeNumber }) {
        // A phone-less (bsuid-only) caller has no callerNumber — prefer their
        // WhatsApp username (almost always on file) over the literal "(null)"
        // a bare number interpolation would otherwise render.
        const callerLabel = callerNumber
            ? `${callerName} (${callerNumber})`
            : callerUsername
                ? `${callerName} (@${callerUsername})`
                : callerName;
        const baseData = {
            type: 'incoming_call',
            callId: wacid,
            callerName,
            callerNumber,
            calleeName,
            calleeNumber,
            businessId,
            timestamp: new Date().toISOString(),
        };
        const baseOptions = {
            url: absoluteUrl(isCallCenter ? '/call-center' : '/business-number/show'),
            icon: NotificationIcons.call,
            payload: {
                ...NotificationPresets.incomingCall,
                buttons: [
                    { id: 'answer', text: 'Answer' },
                    { id: 'decline', text: 'Decline' },
                ],
            },
        };

        try {
            if (userId) {
                const assignedAgent = await AgentRepository.findUserById(userId);
                const assignedName = assignedAgent?.name || 'Agent';
                await OneSignalService.sendToUsers(
                    userId,
                    `Incoming Call - Assigned to ${assignedName}`,
                    `New call from ${callerLabel}`,
                    {
                        ...baseData,
                        assignedUserId: userId,
                        assignedUserName: assignedName,
                        isCallCenter: !!isCallCenter,
                    },
                    baseOptions
                );
                return;
            }

            if (isCallCenter) {
                const managers = await AgentRepository.getCallCenterManagers(businessId);
                if (!managers.length) return;

                await OneSignalService.sendToUsers(
                    managers.map(m => m.id),
                    'Incoming Call - Unassigned',
                    `Unassigned call from ${callerLabel}`,
                    { ...baseData, assignedUserId: null, isCallCenter: true, needsAssignment: true },
                    baseOptions
                );
                return;
            }

            const users = await AgentRepository.getUsersWithCallShowPermission(businessId);
            if (!users.length) return;

            await OneSignalService.sendToUsers(
                users.map(u => u.id),
                'Incoming Call',
                `New call from ${callerLabel}`,
                { ...baseData, assignedUserId: null, isCallCenter: false },
                baseOptions
            );
        } catch (err) {
            console.error(`[Webhook:incoming] Notification error:`, err.message);
        }
    }
}

export const callWebhookProcessor = new CallWebhookProcessor();
