// src/core/events/handlers/InitiationEventHandler.js
// Outbound calls, in two steps (PLATFORM_ARCHITECTURE.md §5.2):
//   1. createOutboundIntent — the consumer's backend asks for a call (it owns
//      consent) → a calls row in INITIATED, bound to one agent.
//   2. handleCallStart — that agent's client connects its media leg with
//      call:start; Callio then dials the customer through the channel.
import CallRepository from '../../../persistence/CallRepository.js';
import CallConnectionRepository from '../../../persistence/CallConnectionRepository.js';
import AgentRepository from '../../../persistence/AgentRepository.js';
import { customerChannels } from '../../channels/CustomerChannels.js';
import { redisPubSubService } from '../../../infra/redis/RedisPubSubService.js';
import { peerRegistry } from '../../../media/webrtc/PeerRegistry.js';
import { sdpCoordinator } from '../../../media/webrtc/SDPCoordinator.js';
import { callLifecycleLogger } from '../../calls/CallLifecycleLogger.js';
import { consumerEventPublisher } from '../ConsumerEventPublisher.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { emitCallError } from '../CallErrorEmitter.js';
import EventBus from '../../EventBus.js';
import { iceCoordinator } from '../../../media/webrtc/ice/ICECandidateCoordinator.js';
import { agentAssignmentCoordinator } from '../../routing/AgentAssignmentCoordinator.js';
import { toCallView } from '../../calls/CallView.js';
import { callTerminator } from '../../calls/CallTerminator.js';
import {
    ConnectionType, CallDirection, CallStatus, AgentAvailability, TerminationReason, TerminatedBy,
} from '../../constants/CallConstants.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.InitiationEventHandler');

export class OutboundCallError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export class InitiationEventHandler {
    // ── Step 1: intent (Management API) ───────────────────────────────────────

    async createOutboundIntent({ tenantId, channel, agent, customerAddress, customerAddressType, customerName = null,
        externalRef = null, consumerMetadata = null }) {
        if (String(channel.tenant_id) !== String(tenantId)) throw new OutboundCallError('invalid_channel', 'Channel does not belong to this tenant');
        if (channel.status !== 'ACTIVE') throw new OutboundCallError('channel_disabled', 'Channel is not active');
        const adapter = customerChannels.has(channel.type) ? customerChannels.get(channel.type) : null;
        if (!adapter?.supportsOutbound) {
            throw new OutboundCallError('unsupported_channel', `Outbound calls are not supported on ${channel.type} channels yet`);
        }
        if (String(agent.tenant_id) !== String(tenantId)) throw new OutboundCallError('invalid_agent', 'Agent does not belong to this tenant');
        if (await CallRepository.hasAgentActiveCall(agent.id, 0)) {
            throw new OutboundCallError('agent_busy', 'Agent already has an active call');
        }

        let address, addressType;
        try {
            ({ address, addressType } = adapter.normalizeCustomerAddress({
                address: customerAddress, addressType: customerAddressType ?? null,
            }));
        } catch (err) {
            throw new OutboundCallError('invalid_customer', err.message);
        }

        const callId = await CallRepository.create({
            tenant_id: tenantId,
            channel_id: channel.id,
            channel: channel.type,
            channel_address: channel.address,
            agent_id: agent.id,
            customer_address: address,
            customer_address_type: addressType,
            customer_name: customerName,
            external_ref: externalRef,
            consumer_metadata: consumerMetadata,
            direction: CallDirection.OUTBOUND,
            status: CallStatus.INITIATED,
        });
        consumerEventPublisher.publishForCall(callId, 'call.created');
        return CallRepository.findById(callId);
    }

    // ── Step 2: the agent connects (socket call:start) ────────────────────────

    async handleCallStart(data, subscriptionCallback) {
        const { callId, userId, tenantId, sdpOffer, socketId, deviceId } = data;

        const call = await CallRepository.findById(callId);
        if (!call || String(call.tenant_id) !== String(tenantId)) throw new Error('Call not found');
        if (call.direction !== CallDirection.OUTBOUND) throw new Error('Not an outbound call');
        if (String(call.agent_id) !== String(userId)) throw new Error('This call belongs to another agent');
        if (call.status !== CallStatus.INITIATED) throw new Error(`Call is already ${call.status.toLowerCase()}`);
        if (await CallConnectionRepository.findByCallAndType(callId, ConnectionType.AGENT)) {
            throw new Error('Call was already started');
        }
        if (await CallRepository.hasAgentActiveCall(userId, callId)) {
            throw new Error('Agent already has an active call');
        }

        // Seed ringing_at now so ringing_duration is always computable even if
        // the provider's RINGING status arrives after the call ends; the
        // RINGING webhook overwrites it with the provider's timestamp.
        await CallRepository.updateTimestamp(callId, 'ringing_at', new Date());

        // Subscribe before creating the peer so events arrive immediately.
        await redisPubSubService.subscribeToCallEvents(callId, subscriptionCallback);

        iceCoordinator.setConnectionInfo(callId, ConnectionType.AGENT, socketId);
        const sdpAnswer = await sdpCoordinator.createSDPAnswer(callId, sdpOffer, ConnectionType.AGENT);
        iceCoordinator.markClientReady(callId);

        // Durable device bookkeeping, same as the inbound accept path: a reload
        // resync must see which device this call is bound to.
        CallConnectionRepository.updateDeviceId(callId, ConnectionType.AGENT, deviceId ?? null)
            .catch((err) => log.error({ callId, err }, 'Failed to persist deviceId'));
        CallConnectionRepository.updateAgentId(callId, ConnectionType.AGENT, userId)
            .catch((err) => log.error({ callId, err }, 'Failed to persist agent'));

        await AgentRepository.updateAgentAvailability(userId, AgentAvailability.ON_CALL);
        EventBus.emit('call:agent_availability', {
            tenantId, userId, availability: AgentAvailability.ON_CALL, updatedAt: new Date().toISOString(),
        });
        const agentName = await AgentRepository.getNameById(userId);

        // Shared CallContext, read by triggerCustomerConnection on this worker.
        const connResult = peerRegistry.getConnectionData(callId, ConnectionType.AGENT);
        if (connResult.valid) {
            connResult.data.context.update({
                userId,
                tenantId,
                direction: CallDirection.OUTBOUND,
                channelId: call.channel_id,
                customer: { address: call.customer_address, addressType: call.customer_address_type, name: call.customer_name },
            });
        }

        callLifecycleLogger.logOutboundInitiated(callId, tenantId, userId, {
            channel_id: call.channel_id,
            customer_address: call.customer_address,
        }).catch(() => { });

        return { ...toCallView(call, { agentName }), sdpOffer, sdpAnswer };
    }

    // ── Post-start continuation (via Redis → CallEventHandler) ───────────────

    async handleCallInitiated({ callId }) {
        await this.triggerCustomerConnection(callId);
    }

    // ── Customer side connection ──────────────────────────────────────────────

    async triggerCustomerConnection(callId) {
        const agentResult = peerRegistry.getConnectionData(callId, ConnectionType.AGENT);
        if (!agentResult.valid) {
            log.error({ callId }, 'Cannot dial customer: no AGENT connection');
            return;
        }
        const agentConn = agentResult.data;
        const agentId = agentConn.context?.userId ?? null;

        try {
            const { call, channel } = await customerChannels.forCall(callId);
            const customerSdpOffer = await sdpCoordinator.createSDPOffer(
                callId, ConnectionType.CUSTOMER, null, { sdpProfile: channel.sdp }
            );
            const providerCallId = await channel.initiate(call, customerSdpOffer);

            agentConn.context.setProviderCallId(providerCallId);
            await CallRepository.updateProviderCallId(callId, providerCallId);

            log.info({ callId, providerCallId }, 'Customer dialed');
        } catch (error) {
            log.error({ callId, err: error }, 'Dialing the customer failed');
            const tenantId = agentConn.context.tenantId;

            callLifecycleLogger.logOutboundFailed(callId, tenantId, agentId, {
                error: error.message,
            }).catch(() => { });

            emitCallError({ callId, code: CallErrorCodes.PROVIDER_TRIGGER_FAILED, message: error.message });
            // Ends FAILED and releases the agent (outbound → OFFLINE, safer than
            // auto-queueing them into inbound).
            await callTerminator.end(callId, {
                reason: TerminationReason.PROVIDER_TRIGGER_FAILED,
                terminatedBy: TerminatedBy.PROVIDER,
                failure: { errors: [{ code: CallErrorCodes.PROVIDER_TRIGGER_FAILED, title: error.message }] },
                provider: 'none',
                media: 'local',
                source: 'dial_failed',
            });
        }
    }
}
