// src/push/CallPushNotifier.js
// Wakes agents' devices for calls. The single place that decides which
// push goes to which device (docs/agent-protocol.md#push):
//   ANDROID  FCM data message, silent        type=call.incoming / call.cancelled
//   IOS      APNs VoIP (CallKit rings)        type=call.incoming / call.cancelled
//            + FCM visible alert              type=call.incoming.alert
//   WEB      OneSignal notification           type=call.incoming
// Pushes go out whether or not the agent also has a live socket: a web tab
// being open says nothing about whether their phone's app is running.
// SDP is never included — clients fetch call state (calls:sync) on open.
import pushTokenRepository from '../persistence/PushTokenRepository.js';
import QueueRepository from '../persistence/QueueRepository.js';
import CallRepository from '../persistence/CallRepository.js';
import { fcmService } from './FcmService.js';
import { apnsVoipService } from './ApnsVoipService.js';
import OneSignalService from './OneSignalService.js';
import { NotificationPresets, NotificationIcons } from './notificationPresets.js';
import { callUuid } from '../core/calls/CallView.js';
import { logger } from '../infra/logging/logger.js';

const log = logger('push.CallPushNotifier');

const RING_TTL_SECONDS = 30;

function pushData(call, type) {
    return {
        type,
        callId: call.callId ?? call.id,
        callUuid: callUuid(call.callId ?? call.id),
        tenantId: call.tenantId ?? call.tenant_id ?? null,
        channel: call.channel ?? null,
        customerName: call.customer?.name ?? call.customer_name ?? null,
        customerAddress: call.customer?.address ?? call.customer_address ?? null,
    };
}

function fcmData(data) {
    return {
        type: data.type,
        call_id: data.callId,
        call_uuid: data.callUuid,
        tenant_id: data.tenantId ?? '',
        channel: data.channel ?? '',
        customer_name: data.customerName ?? '',
        customer_address: data.customerAddress ?? '',
    };
}

class CallPushNotifier {
    /**
     * @param {object} call      IncomingCallPayload / CallView
     * @param {Array}  agentIds  who to wake
     */
    async notifyIncoming(call, agentIds) {
        const ids = [...new Set((agentIds || []).filter((id) => id != null))];
        if (!ids.length) return;

        const data = pushData(call, 'call.incoming');
        const title = data.customerName || data.customerAddress || 'Incoming call';

        const [androidFcm, iosVoip, iosFcm, web] = await Promise.all([
            pushTokenRepository.getTokens(ids, 'FCM', { platform: 'ANDROID' }),
            pushTokenRepository.getTokens(ids, 'APNS_VOIP'),
            pushTokenRepository.getTokens(ids, 'FCM', { platform: 'IOS' }),
            pushTokenRepository.getTokens(ids, 'ONESIGNAL'),
        ]);

        const sends = [];
        if (androidFcm.length) {
            // Data-only so it always reaches the app's background handler instead
            // of the OS auto-displaying (or dropping) a generic notification.
            sends.push(fcmService.sendToTokens(androidFcm.map((t) => t.token), {
                title, body: 'Incoming call', data: fcmData(data), ttlSeconds: RING_TTL_SECONDS, silent: true,
            }));
        }
        if (iosVoip.length) {
            sends.push(apnsVoipService.sendVoipPush(iosVoip.map((t) => t.token), data));
        }
        if (iosFcm.length) {
            // A plain banner alongside the VoIP ring, so a missed/dismissed CallKit
            // screen still leaves a way back into the app.
            sends.push(fcmService.sendToTokens(iosFcm.map((t) => t.token), {
                title, body: 'Incoming call', data: fcmData({ ...data, type: 'call.incoming.alert' }),
                ttlSeconds: RING_TTL_SECONDS, silent: false,
            }));
        }
        if (web.length) {
            sends.push(OneSignalService.sendToSubscriptions(web.map((t) => t.token), 'Incoming call', title, data, {
                icon: NotificationIcons.call,
                payload: {
                    ...NotificationPresets.incomingCall,
                    buttons: [{ id: 'answer', text: 'Answer' }, { id: 'decline', text: 'Decline' }],
                },
            }));
        }
        await Promise.all(sends.map((p) => p.catch((err) =>
            log.error({ callId: data.callId, err }, 'Incoming push failed')
        )));
    }

    // Dismisses the native ringing UI a push above may have shown. A no-op on
    // devices that never rang for this call.
    async notifyCancelled(callId, agentIds, { excludeDeviceId = null } = {}) {
        const ids = [...new Set((agentIds || []).filter((id) => id != null))];
        if (!ids.length) return;

        const data = { type: 'call.cancelled', callId, callUuid: callUuid(callId) };
        const [androidFcm, iosVoip] = await Promise.all([
            pushTokenRepository.getTokens(ids, 'FCM', { platform: 'ANDROID', excludeDeviceId }),
            pushTokenRepository.getTokens(ids, 'APNS_VOIP', { excludeDeviceId }),
        ]);

        const sends = [];
        if (androidFcm.length) {
            sends.push(fcmService.sendToTokens(androidFcm.map((t) => t.token), {
                title: '', body: '', data: fcmData(data), ttlSeconds: RING_TTL_SECONDS, silent: true,
            }));
        }
        if (iosVoip.length) {
            sends.push(apnsVoipService.sendVoipPush(iosVoip.map((t) => t.token), data));
        }
        await Promise.all(sends.map((p) => p.catch((err) =>
            log.error({ callId, err }, 'Cancel push failed')
        )));
    }

    /**
     * A call was answered or declined by one agent: dismiss the ring on that
     * agent's other devices and — for a RING_ALL call — on every member's.
     * excludeDeviceId must be the resolving device itself: a call.cancelled
     * push to the device that just answered tears its live call down natively.
     */
    async notifyCallResolved(callId, { resolvedAgentId = null, ringAllQueue = null, excludeDeviceId = null } = {}) {
        const sends = [];
        if (resolvedAgentId != null) {
            sends.push(this.notifyCancelled(callId, [resolvedAgentId], { excludeDeviceId }));
        }
        if (ringAllQueue) {
            const others = (await QueueRepository.getMemberIds(ringAllQueue.id))
                .filter((id) => String(id) !== String(resolvedAgentId));
            sends.push(this.notifyCancelled(callId, others));
        }
        await Promise.all(sends);
    }

    // The call ended: dismiss any ring for it — the assigned agent's, or,
    // for a call nobody took, everyone its queue could have rung.
    async notifyCallEnded(callId) {
        const call = await CallRepository.findById(callId);
        if (!call) return;
        if (call.agent_id) return this.notifyCancelled(callId, [call.agent_id]);
        if (call.queue_id) return this.notifyCancelled(callId, await QueueRepository.getMemberIds(call.queue_id));
    }
}

export const callPushNotifier = new CallPushNotifier();
