// src/websocket/namespaces/call/handlers/delivery.js
import EventBus from '../../../../services/core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';
import { presenceService } from '../../../../services/redis/PresenceService.js';
import { callLifecycleLogger } from '../../../../services/call/lifecycle/CallLifecycleLogger.js';
import AgentRepository from '../../../../repositories/AgentRepository.js';
import CallRepository from '../../../../repositories/CallRepository.js';
import { IncomingCallPayload } from '../../../../services/call/assignment/IncomingCallPayload.js';
import { AssignmentType } from '../../../../services/call/constants/CallConstants.js';
import { fcmService } from '../../../../services/notifications/FcmService.js';
import { apnsVoipService } from '../../../../services/notifications/ApnsVoipService.js';
import notificationRepository from '../../../../repositories/NotificationRepository.js';

// Wakes this agent's mobile device(s) for an incoming call, regardless of
// whether any of their sockets (web tab, already-open app) are connected —
// a live socket elsewhere says nothing about whether their phone's app is
// even running. Reads tokens from MySQL's user_devices (NotificationRepository),
// not the Redis presence cache (FcmService.sendToUser/sendToUsers) — that
// cache is only ever populated by a `device:register` socket event MIDLR_APP
// never emits, so it's always empty for mobile devices; the app registers
// exclusively via the Laravel HTTP endpoint, which writes to MySQL.
// One user can have both an Android FCM token and an iOS VoIP token
// registered (different devices) — send to whichever exist, unconditionally;
// each device only acts on the payload shape it understands.
async function notifyMobileDevices(userId, callData) {
    const { callId, businessId, callerId, callerName, callerUsername, callerNumber } = callData;

    // getFcmTokensForCallsFromUserDevices (not the general-purpose
    // getFcmTokensFromUserDevices) — iOS calls now rely exclusively on the
    // real VoIP push below; see that method's own doc comment.
    const [fcmTokens, voipTokens, iosFcmTokens] = await Promise.all([
        notificationRepository.getFcmTokensForCallsFromUserDevices([userId]),
        notificationRepository.getVoipTokensFromUserDevices([userId]),
        notificationRepository.getIosFcmTokensFromUserDevices([userId]),
    ]);

    const payloadData = {
        type: 'call',
        callId,
        businessId,
        callerId: callerId ?? '',
        callerName: callerName ?? '',
        callerUsername: callerUsername ?? '',
        callerNumber: callerNumber ?? '',
    };

    const sends = [];
    if (fcmTokens.length) {
        // Data-only (FcmService never sets the `notification` field) so it
        // always reaches the app's background handler on Android instead of
        // the OS silently auto-displaying (or dropping, if the process
        // doesn't exist) a generic notification. silent: true does the same
        // for iOS (2026-08-20) — MIDLR_APP's own CallKit-driven ring screen
        // is the only thing that should be visible for this, not also a
        // plain OS "Incoming call" notification alongside it. See
        // FcmService.sendToTokens's own doc comment for the trade-off.
        sends.push(fcmService.sendToTokens(fcmTokens, {
            title: callerName || (callerUsername ? `@${callerUsername}` : 'Incoming call'),
            body: 'Incoming call',
            data: payloadData,
            // Without this FCM keeps retrying for its own default of 4 weeks —
            // a device offline when the call rang could come back online
            // hours later and get shown a stale ring for a call long since
            // over. Matches ApnsVoipService.js's note.expiry on the iOS side.
            ttlSeconds: 30,
            silent: true,
        }));
    }
    if (voipTokens.length) {
        sends.push(apnsVoipService.sendVoipPush(voipTokens, payloadData));
    }
    if (iosFcmTokens.length) {
        // Separate, visible alert alongside the VoIP push above — distinct
        // `type` from the silent Android payload so MIDLR_APP never routes
        // this into the Android-only CallKit-trigger path (see
        // push_notification_service.dart's own guard against reintroducing
        // FCM-driven CallKit registration on iOS). This one isn't meant to
        // ring anything itself; it's a plain OS banner the app's own
        // notification-tap handler routes straight to the Calls tab, giving
        // the user a way back in if they miss/dismiss the native CallKit
        // screen.
        sends.push(fcmService.sendToTokens(iosFcmTokens, {
            title: callerName || callerNumber || (callerUsername ? `@${callerUsername}` : 'Incoming call'),
            body: 'Incoming call',
            data: { ...payloadData, type: 'incoming_call_alert' },
            ttlSeconds: 30,
            silent: false,
        }));
    }
    await Promise.all(sends);
}

// Dismisses the native CallKit-style ringing UI shown by notifyMobileDevices
// above — without this, a killed/backgrounded app that already rendered
// that UI has no live socket to hear call:terminated on, so it just sits
// there ringing forever after the caller hangs up/cancels (the in-app
// screen is unaffected — that's driven by the live socket path and already
// reacts to call:terminated normally). Harmless no-op on the receiving end
// if that device never actually showed the ringing UI for this call.
async function notifyMobileDevicesCallEnded(userId, callId, excludeDeviceId = null) {
    // Same iOS exclusion as notifyMobileDevices above — there's no FCM ring
    // on iOS left to dismiss once it's never sent one in the first place.
    // excludeDeviceId: see notifyCallResolved's own doc comment below —
    // must never include the device that itself just resolved this call.
    const [fcmTokens, voipTokens] = await Promise.all([
        notificationRepository.getFcmTokensForCallsFromUserDevices([userId], excludeDeviceId),
        notificationRepository.getVoipTokensFromUserDevices([userId], excludeDeviceId),
    ]);

    const payloadData = { type: 'call_ended', callId };

    const sends = [];
    if (fcmTokens.length) {
        sends.push(fcmService.sendToTokens(fcmTokens, {
            title: '',
            body: '',
            data: payloadData,
            ttlSeconds: 30,
            // title/body are already empty here, so this mostly matters for
            // dropping the alert-required apns-priority:10 down to the
            // background-push-only 5 — see FcmService.sendToTokens's doc
            // comment.
            silent: true,
        }));
    }
    if (voipTokens.length) {
        sends.push(apnsVoipService.sendVoipPush(voipTokens, payloadData));
    }
    await Promise.all(sends);
}

// Dismisses the native ringing UI on every device that could plausibly
// still be showing it once the call has been resolved by one agent —
// called directly from AgentEventHandler/RejectionEventHandler on a
// successful accept/reject, rather than relying solely on the much slower
// stuck-call cleanup sweep (CallCleanupService.js, worst case ~90s) to get
// there eventually via call:terminated. Deliberately separate from that
// call:terminated path: an agent's own accept/reject intentionally emits
// call:handled instead, specifically so the manager dashboard isn't told
// "terminated" for a call someone actually answered — this fills in
// exactly the audience (killed/backgrounded devices with no live socket to
// hear call:handled on) that decision leaves stranded.
// fanOutToBusiness should be true only for the broadcast case (non-call-
// center businesses, where every agent's device rang for the same call) —
// a call-center DIRECT/QUEUE call only ever rang resolvedUserId's own
// devices, so there is no wider audience to dismiss. notifyMobileDevicesCallEnded
// is a no-op on any device that never showed a ring for this call — EXCEPT
// resolvedUserId's own device that just resolved it, which very much did
// show a ring (that's how it resolved it). That case isn't a no-op: real
// iOS device logs (2026-09-01) confirmed the resolving device's own VoIP
// token was included in this fan-out, and the resulting `call_ended` push
// tore the just-connected call down natively ~1.6s after every single
// accept. excludeDeviceId must be the resolving device's own device_id
// (AgentEventHandler/RejectionEventHandler already have it from the
// call:accept/call:reject payload) so it's excluded from resolvedUserId's
// own token lookup — never from the fanOutToBusiness lookup below, since
// those are other agents' accounts entirely, not eligible for the same
// device_id collision.
export async function notifyCallResolved(callId, businessId, resolvedUserId, { fanOutToBusiness = false, excludeDeviceId = null } = {}) {
    const notified = new Set();
    const sends = [];

    if (resolvedUserId != null) {
        notified.add(String(resolvedUserId));
        sends.push(notifyMobileDevicesCallEnded(resolvedUserId, callId, excludeDeviceId));
    }

    if (fanOutToBusiness && businessId != null) {
        try {
            const callShowUsers = await AgentRepository.getUsersWithCallShowPermission(businessId);
            for (const u of callShowUsers) {
                if (notified.has(String(u.id))) continue;
                notified.add(String(u.id));
                sends.push(notifyMobileDevicesCallEnded(u.id, callId));
            }
        } catch (err) {
            console.error(`[delivery] Failed to resolve call_show users for business ${businessId} (call ${callId}):`, err.message);
        }
    }

    await Promise.all(sends.map((p) => p.catch((err) =>
        console.error(`[delivery] Failed to send resolved-call dismiss push for ${callId}:`, err.message)
    )));
}

export function registerCallDeliveryListeners() {
    EventBus.on('call:incoming', async (data) => {
        const { callId, userId, businessId, assignmentType, isCallCenter } = data;
        console.log(`[EventBus] Incoming call ${callId} assigned to user ${userId} in business ${businessId}`);

        // IVR calls have no assigned agent yet — only managers need the dashboard update.
        if (assignmentType === AssignmentType.IVR) {
            roomManager.broadcastToManagers(businessId, 'call:incoming:business', data);
            return;
        }

        // For directly-assigned calls, guard against race-condition double-assignment before
        // notifying anyone (manager broadcast included). TRANSFERRED calls are exempt — they
        // are deliberately re-routed and a stuck RINGING call on the target agent should not
        // block the transfer delivery. Fail open on DB error: a missed guard is recoverable
        // (CleanupService handles the duplicate); a dropped event is not.
        if (userId && assignmentType !== AssignmentType.TRANSFERRED) {
            let priorCallId = null;
            try {
                priorCallId = await CallRepository.getConflictingRingingCallId(userId, callId);
            } catch (guardErr) {
                console.error(
                    `[delivery] Double-assignment guard query failed for call ${callId} — failing open:`,
                    guardErr.message
                );
            }
            if (priorCallId !== null) {
                console.warn(
                    `[delivery] Double-assignment race: suppressing call ${callId} for agent ${userId}` +
                    ` — call ${priorCallId} is already ringing. CleanupService will release call ${callId}.`
                );
                try {
                    const socketIds = await presenceService.getUserSockets(userId);
                    await callLifecycleLogger.logDeliveryAttempt(callId, businessId, userId, {
                        agent_connected: socketIds.length > 0,
                        presence_socket_count: socketIds.length,
                        presence_socket_ids: socketIds,
                        joined_sockets: 0,
                        emitted_sockets: 0,
                        delivered: false,
                        suppression_reason: 'prior_ringing_call',
                        prior_call_id: priorCallId,
                    });
                } catch (logErr) {
                    console.error(`[delivery] Failed to log suppressed delivery for call ${callId}:`, logErr.message);
                }
                return;
            }
        }

        // Non-IVR: send the business-level observer event to managers only.
        // Enrich agentName/agentEmail for the manager view — assignment code paths
        // can produce agentName=null when the agent DB record has no display name.
        let managerPayload = data;
        if (userId && (!data.agentName || !data.agentEmail)) {
            try {
                const agent = await AgentRepository.findUserById(userId);
                if (agent) {
                    managerPayload = {
                        ...data,
                        agentName: data.agentName || agent.name || null,
                        agentEmail: data.agentEmail || agent.email || null,
                    };
                }
            } catch (err) {
                console.error(`[EventBus] Failed to enrich agent info for call ${callId}:`, err.message);
            }
        }
        roomManager.broadcastToManagers(businessId, 'call:incoming:business', managerPayload);

        // Deliver ringing event to the assigned agent sockets (DIRECT/transferred calls)
        // or to all business users (QUEUED calls — non-call-center businesses).
        if (userId) {
            const socketIds = await presenceService.getUserSockets(userId);
            const isConnected = socketIds.length > 0;

            const joinedSockets = await roomManager.addUserToCallRoom(userId, callId);
            roomManager.emitToUser(userId, 'call:incoming', data);
            const emittedSockets = socketIds.length;

            try {
                const devices = await presenceService.getDevices(userId);
                await callLifecycleLogger.logDeliveryAttempt(callId, businessId, userId, {
                    agent_connected: isConnected,
                    presence_socket_count: socketIds.length,
                    presence_socket_ids: socketIds,
                    joined_sockets: joinedSockets || 0,
                    emitted_sockets: emittedSockets || 0,
                    delivered: emittedSockets > 0,
                    registered_devices: devices.map(d => ({
                        device_id: d.device_id,
                        platform: d.device_info?.platform || null,
                        last_seen_at: d.last_seen_at || null,
                    })),
                });
            } catch (err) {
                console.error(`[EventBus] Failed to log delivery attempt for call ${callId}:`, err.message);
            }

            if (!emittedSockets) {
                // Redis presence shows no sockets — agent may be offline or presence is briefly stale.
                // The room broadcast above still went out; RINGING_AGENT_RECONNECT handles re-delivery
                // when the agent comes back online.
                console.warn(
                    `[EventBus] Redis presence shows no sockets for user ${userId} at call:incoming time ` +
                    `— broadcast sent to user room anyway (call=${callId}, business=${businessId}, joined=${joinedSockets || 0})`
                );
            }

            // Sent unconditionally (not just when emittedSockets is 0) — a live
            // socket connection on one device (e.g. a web tab) says nothing
            // about whether this agent's MOBILE app is even running; the push
            // is how a killed/backgrounded app finds out at all. sdpOffer is
            // deliberately NOT included — it can exceed the payload size
            // limit on either channel; the app fetches the real call state
            // (including the SDP offer) via its own calls:list resync once
            // it opens (see CallModel._onOngoingCallsFetch/
            // _onSocketServiceChanged), so the push only needs enough to
            // alert the user and let them tell who's calling.
            notifyMobileDevices(userId, { callId, businessId, ...data })
                .catch((err) => console.error(`[delivery] Failed to send call push for ${callId}:`, err.message));
        } else {
            const routingStrategy = data.routingContext?.strategy;
            if (isCallCenter) {
                // Any call-center routing strategy (QUEUE, PRIORITY, RECEPTIONIST) that
                // reaches here with userId=null already gets deferred to
                // assignOldestUnassignedCall's atomic claim (see CallWebhookProcessor's
                // "for all routing strategies" FIFO-guard trigger) — broadcasting on top
                // of that would race every agent for the same call regardless of which
                // strategy is configured (multi-assignment bug). Previously this only
                // checked routingStrategy === RoutingStrategy.QUEUE, which meant a
                // PRIORITY/RECEPTIONIST call-center call with no available agent fell
                // through to the business-wide broadcast below meant for non-call-center
                // businesses — reaching every business_show socket, managers included
                // (managers are never supposed to receive/accept a call-center call).
                // Gated on isCallCenter alone (not also matched to non-call-center
                // businesses) because those are also stamped with a QUEUE placeholder
                // strategy but have no coordinator to deliver for them.
                console.log(`[EventBus] Call ${callId} (call-center, ${routingStrategy}) — delivery deferred to coordinator assignment`);
            } else {
                // Non-call-center broadcast routing: no agent pre-assigned.
                // Broadcast to all business users; first to accept wins the
                // ownership race in handleAgentJoined.
                console.log(`[EventBus] QUEUED call ${callId} — broadcasting call:incoming to business:${businessId}`);
                roomManager.broadcastToBusiness(businessId, 'call:incoming', data);

                // Same reasoning as the userId branch above — a room broadcast
                // only reaches sockets already connected; a killed/locked
                // mobile app has none. Every business user with call_show
                // gets a push here (mirrors CallWebhookProcessor's identical
                // getUsersWithCallShowPermission fan-out for the OneSignal/web
                // channel) since there's no pre-assigned agent to single out —
                // without this, a non-call-center business's mobile users never
                // got a push at all, and a killed app never rang.
                try {
                    const callShowUsers = await AgentRepository.getUsersWithCallShowPermission(businessId);
                    await Promise.all(callShowUsers.map((u) =>
                        notifyMobileDevices(u.id, { callId, businessId, ...data })
                            .catch((err) => console.error(`[delivery] Failed to send call push to user ${u.id} for ${callId}:`, err.message))
                    ));
                } catch (err) {
                    console.error(`[delivery] Failed to resolve call_show users for business ${businessId} (call ${callId}):`, err.message);
                }
            }
        }
    });

    // call:terminated's own payload varies by call site (webhook/IVR/cleanup
    // paths) and mostly doesn't carry userId — it's a business-wide broadcast,
    // not user-scoped, unlike call:incoming. Looking the assigned agent up by
    // callId here keeps that lookup in one place instead of touching every
    // emit site. Unconditional — sending this to a device that never showed
    // a ringing UI for this call is a harmless no-op on the receiving end.
    EventBus.on('call:terminated', async ({ callId }) => {
        try {
            const call = await CallRepository.findById(callId);
            if (!call) return;
            if (call.user_id) {
                await notifyMobileDevicesCallEnded(call.user_id, callId);
                return;
            }
            // Terminated (e.g. caller hung up/cancelled) before anyone
            // claimed it — the same broadcast-to-everyone shape as the
            // call:incoming fan-out above, so the "stop ringing" push must
            // go to that same call_show audience. Without this, every
            // business user's mobile app that started ringing for the
            // never-claimed call has nothing telling it to dismiss the
            // native CallKit UI.
            const callShowUsers = await AgentRepository.getUsersWithCallShowPermission(call.business_id);
            await Promise.all(callShowUsers.map((u) =>
                notifyMobileDevicesCallEnded(u.id, callId)
                    .catch((err) => console.error(`[delivery] Failed to send call-ended push to user ${u.id} for ${callId}:`, err.message))
            ));
        } catch (err) {
            console.error(`[delivery] Failed to send call-ended push for ${callId}:`, err.message);
        }
    });

    // Room membership helpers — emitted by TransferEventHandler to keep the service
    // layer free of direct WebSocket transport (roomManager) dependencies.
    EventBus.on('call:room:broadcast', ({ callId, event, data }) => {
        roomManager.broadcastToCall(callId, event, data);
    });

    EventBus.on('call:room:leave', ({ userId, callId }) => {
        if (userId) roomManager.removeUserFromCallRoom(userId, callId);
    });

    EventBus.on('call:room:join', ({ userId, callId }) => {
        if (userId) roomManager.addUserToCallRoom(userId, callId);
    });

    EventBus.on('call:transferred', (data) => {
        // Strip sdpOffer (security) and businessId/oldAgentId (server-only routing fields).
        // callId is intentionally kept — the frontend needs it to update the correct entry
        // in ongoingCalls (without it, updateTransferredCall creates a ghost callId=undefined entry).
        const { businessId, oldAgentId, sdpOffer, ...safeData } = data;
        console.log(`[EventBus] Call ${safeData.callId} transferred`);

        roomManager.broadcastToManagers(businessId, 'call:transferred', safeData);
        if (oldAgentId) roomManager.emitToUser(oldAgentId, 'call:transferred', safeData);
    });

    // Deliver a refreshed call:incoming to a specific socket after the subscribed worker
    // recreated the FRONTEND peer (RINGING_AGENT_RECONNECT path). Uses emitToSocket so
    // the new SDP reaches the exact socket that just reconnected, not all agent sockets.
    EventBus.on('call:ringing_reconnect_deliver', (data) => {
        const { socketId, sdpOffer, callId, wacid, businessId, userId, agentName,
            callerId, callerName, callerUsername, callerNumber,
            calleeId, calleeName, calleeUsername, calleeNumber, ringingAt } = data;

        roomManager.emitToSocket(socketId, 'call:incoming', new IncomingCallPayload({
            callId, wacid, businessId, userId, agentName,
            callerId, callerName, callerUsername, callerNumber,
            calleeId, calleeName, calleeUsername, calleeNumber,
            ringingAt, sdpOffer,
            assignmentType: AssignmentType.DIRECT,
        }));
    });
}
