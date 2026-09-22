// services/call/events/handlers/InitiationEventHandler.js
// Self-contained handler for outbound call initiation.
import CallRepository from '../../../../repositories/CallRepository.js';
import CallConnectionRepository from '../../../../repositories/CallConnectionRepository.js';
import AgentRepository from '../../../../repositories/AgentRepository.js';
import BusinessRepository from '../../../../repositories/BusinessRepository.js';
import ClientRepository from '../../../../repositories/ClientRepository.js';
import { initiateWhatsAppCall } from '../../signaling/webrtc/WhatsAppCallApi.js';
import { redisPubSubService } from '../../../redis/RedisPubSubService.js';
import { peerRegistry } from '../../signaling/webrtc/PeerRegistry.js';
import { sdpCoordinator } from '../../signaling/webrtc/SDPCoordinator.js';
import { callLifecycleLogger } from '../../lifecycle/CallLifecycleLogger.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { emitCallError } from '../CallErrorEmitter.js';
import EventBus from '../../../core/EventBus.js';
import { iceCoordinator } from '../../signaling/webrtc/ice/ICECandidateCoordinator.js';
import { agentAssignmentCoordinator } from '../../assignment/AgentAssignmentCoordinator.js';
import { ConnectionType, CallDirection, CallStatus, AgentAvailability } from '../../constants/CallConstants.js';

export class InitiationEventHandler {
    // ── Outbound call creation ────────────────────────────────────────────────

    async handleCallInitiate(data, subscriptionCallback) {
        const { userId, businessId, calleeId, callerId, sdpOffer, socketId, deviceId } = data;

        const isCallCenter = await BusinessRepository.isCallCentered(businessId);
        if (!isCallCenter) {
            const activeExists = await CallRepository.hasActiveCall(businessId);
            if (activeExists) throw new Error('A call is already active for this business.');
        }

        const caller = await BusinessRepository.getBusinessNumberById(callerId);
        if (!caller) throw new Error('Invalid business number ID');

        const callee = await ClientRepository.findById(calleeId);
        if (!callee) throw new Error('Invalid client ID');

        if (!InitiationEventHandler.hasCallPermission(callee, caller.id)) {
            throw new Error('No call permission for this client.');
        }

        const callId = await CallRepository.create({
            user_id: userId,
            business_id: businessId,
            direction: CallDirection.OUTBOUND,
            business_number_id: caller.id,
            caller_name: caller.display_name,
            caller_number: caller.phone_number,
            client_number_id: callee.id,
            callee_name: callee.name,
            callee_username: callee.username,
            callee_number: callee.phone_number,
            // Seed ringing_at at creation so ringing_duration is always computable
            // even if Meta's RINGING webhook arrives after the call terminates.
            // The RINGING webhook handler overwrites this with Meta's authoritative
            // timestamp when it arrives, so accuracy is not sacrificed.
            ringing_at: new Date(),
        });

        const startedAt = new Date().toISOString();

        // Subscribe before creating peer connection so events arrive immediately
        await redisPubSubService.subscribeToCallEvents(callId, subscriptionCallback);

        // Tell the ICE dispatcher which socket to deliver outbound candidates to,
        // then mark the client ready to flush any buffered candidates.
        iceCoordinator.setConnectionInfo(callId, ConnectionType.FRONTEND, socketId);
        const sdpAnswer = await sdpCoordinator.createSDPAnswer(callId, sdpOffer, ConnectionType.FRONTEND);
        iceCoordinator.markClientReady(callId);

        // Same durable-device bookkeeping as the inbound accept path
        // (AgentEventHandler.handleAgentJoined) — without this, an outbound
        // call's FRONTEND row never gets a device_id at all, and a reload
        // resync would incorrectly treat the initiating device's own
        // still-ringing/in-progress outbound call as "bound to no device"
        // and fail to auto-resume it.
        CallConnectionRepository.updateDeviceId(callId, ConnectionType.FRONTEND, deviceId ?? null)
            .catch((err) => console.error(`[InitiationEventHandler] Failed to persist deviceId for call ${callId}:`, err.message));

        await AgentRepository.updateAgentAvailability(userId, AgentAvailability.ON_CALL);
        const agentName = await AgentRepository.getUserNameById(userId, businessId);

        if (!callee.phone_number && callee.bsuid) {
            console.log(`[InitiationEventHandler] Outbound call to phone-less callee=${callee.id} via bsuid=${callee.bsuid}`);
        }

        // Seed the shared CallContext so triggerWhatsAppConnection can use it
        const connResult = peerRegistry.getConnectionData(callId, ConnectionType.FRONTEND);
        if (connResult.valid) {
            connResult.data.context.update({
                userId, businessId, direction: CallDirection.OUTBOUND,
                caller: { id: caller.id, name: caller.display_name, number: caller.phone_number },
                callee: { id: callee.id, name: callee.name, number: callee.phone_number, bsuid: callee.bsuid, username: callee.username },
            });
        }

        callLifecycleLogger.logOutboundInitiated(callId, businessId, userId, {
            caller_id: caller.id, caller_number: caller.phone_number,
            callee_id: callee.id, callee_number: callee.phone_number,
        }).catch(() => { });

        return {
            wacid: null, callId, userId, agentName, businessId,
            direction: CallDirection.OUTBOUND, status: CallStatus.INITIATED,
            caller: { id: caller.id, name: caller.display_name, number: caller.phone_number },
            callee: { id: callee.id, name: callee.name, username: callee.username, number: callee.phone_number },
            sdpOffer, sdpAnswer, startedAt,
        };
    }

    // ── Post-creation continuation (called via Redis → CallEventHandler) ─────

    async handleCallInitiated({ callId }) {
        await this.triggerWhatsAppConnection(callId);
    }

    // ── WhatsApp side connection ───────────────────────────────────────────────

    async triggerWhatsAppConnection(callId) {
        const frontendResult = peerRegistry.getConnectionData(callId, ConnectionType.FRONTEND);
        if (!frontendResult.valid) {
            console.error(`[InitiationEventHandler] Cannot trigger WhatsApp for call ${callId}: no FRONTEND connection`);
            return;
        }
        const frontendConn = frontendResult.data;
        frontendConn.setWhatsappTriggering(true);
        frontendConn.setWhatsappTriggered(true);
        const agentId = frontendConn.context?.userId ?? null;

        try {
            const whatsappSdpOffer = await sdpCoordinator.createSDPOffer(callId, ConnectionType.WHATSAPP);
            const wacid = await initiateWhatsAppCall(frontendConn.context, whatsappSdpOffer);

            frontendConn.context.setWacid(wacid);
            await CallRepository.updateWacid(callId, wacid);

            console.log(`[InitiationEventHandler] WhatsApp connection triggered successfully for call ${callId}`);
        } catch (error) {
            console.error(`[InitiationEventHandler] WhatsApp trigger failed for call ${callId}:`, error.message);
            const businessId = frontendConn.context.businessId;

            callLifecycleLogger.logOutboundFailed(callId, businessId, agentId, {
                error: error.message,
            }).catch(() => { });

            await peerRegistry.closePeerConnection(callId);

            emitCallError({ callId, code: CallErrorCodes.WHATSAPP_TRIGGER_FAILED, message: error.message });
            EventBus.emit('call:terminated', { callId, businessId, reason: 'WHATSAPP_TRIGGER_FAILED' });
            await CallRepository.markCallFailed(callId, [{ code: CallErrorCodes.WHATSAPP_TRIGGER_FAILED, title: error.message }]);

            // Release the agent — otherwise they stay stuck ON_CALL despite the call
            // being FAILED. Outbound so we drop them to OFFLINE (safer than AVAILABLE:
            // avoids auto-queueing them into inbound routing after a failed outbound).
            // Release primitives are idempotent + guarded by NOT EXISTS active calls.
            if (agentId) {
                try {
                    await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(agentId);
                } catch (releaseErr) {
                    console.error(
                        `[InitiationEventHandler] ⚠️ AGENT STUCK: Failed to release agent ${agentId} after trigger failure on call ${callId}:`,
                        releaseErr.message
                    );
                }
            }
        } finally {
            frontendConn.setWhatsappTriggering(false);
            frontendConn.setWhatsappConnected(true);
        }
    }

    // ── Call permission gate ──────────────────────────────────────────────────
    // Mirrors the shape client_numbers.call_permission is written in (Laravel's
    // WebhookController::handleCallPermissionReply): a JSON map keyed by
    // business_number_id, each entry {status, permanent, expires_at}. Previously
    // this was only enforced by disabling the "Direct Call" button in the
    // frontend (CallActionsDropdown.jsx's canDirectCall) — nothing stopped a
    // call initiated by any other route (e.g. calling window.CallManager
    // directly) from bypassing it, since this handler is the one place all
    // outbound calls actually go through server-side.
    static hasCallPermission(callee, businessNumberId) {
        const raw = callee.call_permission;
        if (!raw) return false;

        let permissionMap;
        try {
            permissionMap = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            return false;
        }

        const permission = permissionMap?.[String(businessNumberId)];
        if (!permission || permission.status !== 'accepted') return false;
        if (permission.permanent) return true;
        return Boolean(permission.expires_at) && new Date(permission.expires_at) > new Date();
    }
}
