// src/channels/whatsapp/CallWebhookProcessor.js
// All inbound WhatsApp Calling webhook logic: `calls` events (connect,
// terminate) and `statuses` updates, in Meta's payload shape. Everything
// consumer-specific is resolved through Callio's own tables — the line via
// channels, routing via the channel's queue and IVR flows.
import EventBus from '../../core/EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import IvrRepository from '../../persistence/IvrRepository.js';
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import { callEventHandler } from '../../core/events/CallEventHandler.js';
import { sdpCoordinator } from '../../media/webrtc/SDPCoordinator.js';
import { callOwnershipService } from '../../infra/cluster/CallOwnershipService.js';
import { redisPubSubService } from '../../infra/redis/RedisPubSubService.js';
import { redisCleanupService } from '../../infra/cluster/RedisCleanupService.js';
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { agentMissedCallTracker } from '../../core/routing/AgentMissedCallTracker.js';
import { agentAssignmentCoordinator } from '../../core/routing/AgentAssignmentCoordinator.js';
import { queueRouter } from '../../core/routing/QueueRouter.js';
import { callLifecycleLogger } from '../../core/calls/CallLifecycleLogger.js';
import { customerLookup } from '../../core/calls/CustomerLookup.js';
import { consumerEventPublisher } from '../../core/events/ConsumerEventPublisher.js';
import { EventTypes } from '../../core/events/EventTypes.js';
import { emitCallError } from '../../core/events/CallErrorEmitter.js';
import { presenceService } from '../../core/agents/PresenceService.js';
import {
    CallStatus,
    CallDirection,
    Channel,
    ConnectionType,
    CustomerAddressType,
    AssignmentType,
    AgentAvailability,
    TerminationReason,
    TerminatedBy,
} from '../../core/constants/CallConstants.js';
import { IncomingCallPayload } from '../../core/calls/IncomingCallPayload.js';
import { acceptWhatsAppCall, rejectWhatsAppCall } from './WhatsAppCallApi.js';

// Tombstone written when a `terminate` webhook arrives before its matching
// `connect`. The late `connect` looks this up to persist the call directly
// as a missed call instead of ringing an agent for a call Meta has already
// finished. TTL bounds how long we'll wait for the connect to land.
const TERMINATE_TOMBSTONE_PREFIX = 'call:terminate:tombstone:';
const TERMINATE_TOMBSTONE_TTL_SECONDS = 120;
const tombstoneKey = (providerCallId) => `${TERMINATE_TOMBSTONE_PREFIX}${providerCallId}`;

// Max number of call/status events processed in parallel within one webhook payload.
// Prevents a single large payload from spawning unbounded concurrent DB + Redis chains.
const WEBHOOK_CONCURRENCY = 5;

// Meta sends phone numbers as digits without '+'; Callio stores E.164.
function toE164(number) {
    if (!number) return null;
    const digits = String(number).replace(/[^\d]/g, '');
    return digits ? `+${digits}` : null;
}

class CallWebhookProcessor {

    // ── Entry point ───────────────────────────────────────────────────────────

    /**
     * @param {object} value    one Meta change value { metadata, calls, contacts, statuses }
     * @param {object} options
     *   consumerId  when set (forwarded webhooks), the line must belong to this consumer
     * @returns {Promise<{ accepted: boolean, reason?: string }>}
     */
    async process({ metadata, calls, contacts, statuses }, { consumerId = null } = {}) {
        // Every event in a payload is about one line (metadata.phone_number_id).
        // Resolving it once scopes all of them: a status or terminate for a call
        // on another channel is dropped, so a payload can't touch other lines' calls.
        const channel = await ChannelRepository.findActiveWhatsAppByPhoneNumberId(metadata?.phone_number_id);
        if (!channel) {
            console.warn(`[Webhook] No active WhatsApp channel for phone_number_id=${metadata?.phone_number_id} — payload ignored`);
            return { accepted: false, reason: 'unknown_channel' };
        }
        if (consumerId != null && String(await TenantRepository.getConsumerId(channel.tenant_id)) !== String(consumerId)) {
            console.warn(`[Webhook] Channel ${channel.id} does not belong to consumer ${consumerId} — payload rejected`);
            return { accepted: false, reason: 'channel_not_owned' };
        }

        const thunks = [];

        if (Array.isArray(calls) && calls.length > 0) {
            for (const call of calls) {
                thunks.push(() =>
                    this._processCallEvent(call, channel, contacts?.[0]).catch((err) => {
                        console.error(`[Webhook:event] Error processing call ${call?.id}:`, err);
                    })
                );
            }
        }

        if (Array.isArray(statuses) && statuses.length > 0) {
            for (const status of statuses) {
                thunks.push(() =>
                    this._processCallStatus(status, channel).catch((err) => {
                        console.error(`[Webhook:status] Error processing status:`, err);
                    })
                );
            }
        }

        if (thunks.length) await this._runConcurrent(thunks, WEBHOOK_CONCURRENCY);
        return { accepted: true };
    }

    // A call row may only be touched by payloads for its own line.
    _belongsTo(call, channel) {
        if (String(call.channel_id) === String(channel.id)) return true;
        console.warn(`[Webhook] Call ${call.id} is on channel ${call.channel_id}, not ${channel.id} — event ignored`);
        return false;
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

    async _processCallEvent(call, channel, contact) {
        const { id: providerCallId, event } = call;

        // 'terminate' is NOT ownership-gated (unlike 'connect'): any worker that
        // receives it processes it directly. _handleCallTerminate never touches
        // worker-local media state — its DB writes are race-safe via the
        // finalize* guards, and CALL_TERMINATED is published over Redis to
        // whichever worker holds the live peers. Gating it on ownership used to
        // drop terminates that landed on a different worker than their connect.
        if (event !== 'terminate') {
            const claimed = await callOwnershipService.claimCall(providerCallId, 180);
            if (!claimed) {
                const owner = await callOwnershipService.getCallOwner(providerCallId);
                console.log(`[Webhook:event] Skipping call ${providerCallId} - already owned by worker ${owner}`);
                return;
            }
            console.log(`[Webhook:event] Worker claimed call ${providerCallId}`);
        }

        try {
            switch (event) {
                case 'connect':
                    await this._handleCallConnect(call, channel, contact);
                    break;
                case 'terminate':
                    await this._handleCallTerminate(call, channel);
                    break;
                default:
                    console.warn(`[Webhook:event] Unknown event type: ${event}`);
            }
        } catch (error) {
            console.error(`[Webhook:event] Error on "${event}" for call ${providerCallId}:`, error);
        } finally {
            if (event === 'terminate') {
                await redisCleanupService.cleanupCall(providerCallId);
                console.log(`[Webhook:event] Cleaned up ownership for call ${providerCallId}`);
            } else if (event === 'connect') {
                const latestCall = await CallRepository.findByProviderCallId(providerCallId);
                if (!latestCall || [CallStatus.TERMINATED, CallStatus.FAILED].includes(latestCall.status)) {
                    await redisCleanupService.cleanupCall(providerCallId);
                    return;
                }
                const madePermanent = await callOwnershipService.setCallOwnershipPermanent(providerCallId);
                if (!madePermanent) {
                    console.warn(`[Webhook:event] Could not make ownership permanent for call ${providerCallId}`);
                }
            }
        }
    }

    // ── Status processing ─────────────────────────────────────────────────────

    async _processCallStatus(callStatus, channel) {
        const { id: providerCallId, type, status, timestamp } = callStatus;

        if (type !== 'call') return;

        console.log(`[Webhook:status] Processing - providerCallId=${providerCallId}, status=${status}`);

        try {
            const call = await CallRepository.findByProviderCallId(providerCallId);
            if (!call) {
                console.warn(`[Webhook:status] Call not found for providerCallId=${providerCallId}`);
                return;
            }
            if (!this._belongsTo(call, channel)) return;

            const callId = call.id;
            const agentId = call.agent_id ?? null;
            const previousStatus = call.status;
            const timestampValue = timestamp ? new Date(parseInt(timestamp) * 1000) : new Date();
            const isTerminal = [CallStatus.TERMINATED, CallStatus.FAILED, CallStatus.CANCELLED].includes(previousStatus);

            switch (status) {
                case 'RINGING':
                    // Meta's timestamp is authoritative for ringing_at (outbound calls
                    // seed an approximation at creation).
                    await CallRepository.updateTimestamp(callId, 'ringing_at', timestampValue);
                    // Out-of-order: terminate already ran before RINGING arrived —
                    // patch ringing_duration retroactively now that ringing_at is known.
                    if (isTerminal && call.ringing_duration == null) {
                        const ringingEnd = call.answered_at
                            ? new Date(call.answered_at)
                            : (call.ended_at ? new Date(call.ended_at) : new Date());
                        const retroRingingDuration = Math.max(0, Math.floor((ringingEnd - timestampValue) / 1000));
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
                        callLifecycleLogger.logOutboundRinging(callId, call.tenant_id, agentId, {
                            providerCallId, previousState: previousStatus,
                        }).catch(() => { });
                    }
                    break;

                case 'ACCEPTED':
                    // If RINGING was dropped/reordered, ensure ringing_at is still populated.
                    if (!call.ringing_at) {
                        await CallRepository.updateTimestamp(callId, 'ringing_at', timestampValue);
                        if (isTerminal && call.ringing_duration == null) {
                            // ACCEPTED without a preceding RINGING is instantaneous ringing.
                            await CallRepository.updateDuration(callId, 'ringing_duration', 0);
                        }
                    }
                    // updateTimestamp('answered_at') self-heals a stale NO_ANSWER verdict
                    // if our own termination flow raced ahead of this webhook.
                    await CallRepository.updateTimestamp(callId, 'answered_at', timestampValue);
                    if (!isTerminal && previousStatus !== CallStatus.IN_PROGRESS) {
                        await CallRepository.updateStatus(callId, CallStatus.IN_PROGRESS);
                        await CallRepository.updateState(callId, 'ACTIVE');
                    }
                    if (call.direction === CallDirection.OUTBOUND) {
                        callLifecycleLogger.logOutboundAccepted(callId, call.tenant_id, agentId, {
                            providerCallId, previousState: previousStatus,
                        }).catch(() => { });
                        EventBus.emit('call:handled', {
                            callId, tenantId: call.tenant_id, userId: agentId,
                            agentName: agentId ? await AgentRepository.getNameById(agentId) : null,
                            action: 'accepted',
                        });
                    }
                    break;

                case 'REJECTED':
                    await CallRepository.updateTimestamp(callId, 'ended_at', timestampValue);
                    // REJECTED is the terminal event for customer-declined calls —
                    // _handleCallTerminate never runs for them, so compute here.
                    if (call.ringing_at && call.ringing_duration == null) {
                        const rejRingingDuration = Math.max(
                            0,
                            Math.floor((timestampValue - new Date(call.ringing_at)) / 1000)
                        );
                        await CallRepository.updateDuration(callId, 'ringing_duration', rejRingingDuration);
                    }
                    await CallRepository.terminateCall(callId, TerminationReason.REJECTED, TerminatedBy.CUSTOMER);
                    if (call.direction === CallDirection.OUTBOUND) {
                        callLifecycleLogger.logOutboundRejected(callId, call.tenant_id, agentId, {
                            providerCallId, previousState: previousStatus,
                        }).catch(() => { });
                    }
                    await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_REJECTED, {
                        callId,
                        providerCallId,
                        tenantId: call.tenant_id,
                        userId: agentId,
                        direction: call.direction,
                        reason: 'CUSTOMER_REJECTED',
                        timestamp: timestampValue,
                    });
                    break;

                case 'FAILED': {
                    // Meta can deliver FAILED via `statuses` independently of (or
                    // instead of) the `calls.terminate` event. Only fill durations the
                    // terminate webhook hasn't set — finalizeCallAsFailed COALESCEs,
                    // so null preserves Meta's authoritative value.
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
                        terminatedBy: TerminatedBy.PROVIDER,
                        endedAt: failedEndedAt,
                        callDuration: failedCallDuration,
                        ringingDuration: failedRingingDuration,
                    });

                    // Gate side effects: Meta often sends both a FAILED status and a
                    // calls.terminate — only the path that finalized fires them.
                    if (failedFinalized) {
                        emitCallError({ callId, code: null, message: 'Call failed (status webhook)' });

                        await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TERMINATED, {
                            callId,
                            userId: agentId,
                            reason: 'failed',
                        });

                        if (agentId) {
                            agentAssignmentCoordinator.releaseAgentIfIdle(agentId)
                                .catch((e) => console.error(`[Webhook:status/FAILED] Agent release error:`, e));
                            agentAssignmentCoordinator.emitQueueUpdate(call.tenant_id, call.queue_id)
                                .catch(() => { });
                        }

                        callLifecycleLogger.logTerminated(callId, call.tenant_id, agentId, {
                            reason: 'FAILED',
                            terminated_by: TerminatedBy.PROVIDER,
                            direction: call.direction,
                        }).catch(() => { });

                        EventBus.emit('call:terminated', {
                            callId,
                            tenantId: call.tenant_id,
                            reason: 'provider_termination',
                        });
                    }
                    break;
                }
            }

            EventBus.emit('call:status', {
                callId,
                tenantId: call.tenant_id,
                status,
                // Lets clients tell "another agent's call" from "my own".
                userId: agentId,
                ringingAt: status === 'RINGING' ? timestampValue.toISOString() : undefined,
                answeredAt: status === 'ACCEPTED' ? timestampValue.toISOString() : undefined,
            });

            console.log(`[Webhook:status] Updated call ${callId} to ${status}`);
        } catch (error) {
            console.error(`[Webhook:status] Error processing ${status} for providerCallId=${providerCallId}:`, error);
        }
    }

    // ── Connect handler ───────────────────────────────────────────────────────

    async _handleCallConnect(call, channel, contact) {
        const { id: providerCallId, direction, session } = call;

        if (!session?.sdp || !session?.sdp_type || !['offer', 'answer'].includes(session.sdp_type.toLowerCase())) {
            console.error(`[Webhook:connect] Invalid session payload for call ${providerCallId}`);
            return;
        }

        const existingCall = await CallRepository.findByProviderCallId(providerCallId);

        if (direction === 'USER_INITIATED' && session.sdp_type === 'offer') {
            if (existingCall) {
                console.warn(`[Webhook:connect] Call ${providerCallId} already exists, skipping`);
                return;
            }
            await this._handleIncomingCall(call, channel, contact);
            return;
        }

        if (direction === 'BUSINESS_INITIATED' && session.sdp_type === 'answer') {
            if (!existingCall) {
                console.warn(`[Webhook:connect] No outgoing call found for providerCallId=${providerCallId}`);
                return;
            }
            if (!this._belongsTo(existingCall, channel)) return;
            // The provider's answer may arrive after its RINGING status (webhook
            // order isn't guaranteed), so RINGING still takes the answer.
            if (existingCall.status !== CallStatus.INITIATED && existingCall.status !== CallStatus.RINGING) {
                console.warn(`[Webhook:connect] Outgoing call ${existingCall.id} is ${existingCall.status}, not awaiting an answer — skipping`);
                return;
            }
            await this._handleOutgoingCall(call, existingCall);
        }
    }

    // ── Incoming call handler ─────────────────────────────────────────────────

    async _handleIncomingCall(call, channel, contact) {
        const { id: providerCallId, from: callerNumber, session, timestamp } = call;
        const callerBsuid = contact?.user_id ?? null;

        try {
            const tenantId = channel.tenant_id;

            // The customer is whoever Meta says is calling — a phone number, or a
            // business-scoped user id for customers who call without one.
            const customerAddress = toE164(callerNumber) ?? callerBsuid;
            const customerAddressType = toE164(callerNumber) ? CustomerAddressType.E164 : CustomerAddressType.WHATSAPP_USER;
            const providerMetadata = {
                wa_id: contact?.wa_id ?? null,
                bsuid: callerBsuid,
                username: contact?.username ?? contact?.profile?.username ?? null,
            };
            const ringingAt = timestamp ? new Date(Number(timestamp) * 1000) : new Date();

            const baseRow = {
                tenant_id: tenantId,
                channel_id: channel.id,
                channel: Channel.WHATSAPP,
                channel_address: channel.address,
                provider_call_id: providerCallId,
                queue_id: channel.inbound_queue_id ?? null,
                customer_address: customerAddress,
                customer_address_type: customerAddressType,
                customer_name: contact?.profile?.name ?? null,
                direction: CallDirection.INBOUND,
                status: CallStatus.RINGING,
                ringing_at: ringingAt,
            };

            // Out-of-order webhook: if `terminate` already arrived for this call
            // (and gave up after its retry), persist it directly as a missed call.
            const tombRaw = await redisBaseService.get(tombstoneKey(providerCallId));
            if (tombRaw) {
                await this._handleMissedBeforeConnect({ baseRow, providerMetadata, tombRaw });
                return;
            }

            // Dedup: Meta occasionally fires two `connect`s with different call ids
            // for the same caller within milliseconds (relay retry). The per-call
            // ownership lock can't catch that, so record the duplicate as CANCELLED
            // for the audit trail and stop — no ring, no media.
            const activeCall = await CallRepository.findActiveInboundByCustomer(tenantId, customerAddress);
            if (activeCall) {
                console.warn(
                    `[Webhook:incoming] Dedup: customer ${customerAddress} already has active call ${activeCall.id} ` +
                    `(providerCallId=${activeCall.provider_call_id}) for tenant ${tenantId} — recording ${providerCallId} as CANCELLED`
                );
                const dupCallId = await CallRepository.create({ ...baseRow, metadata: { provider: providerMetadata } })
                    .catch((err) => {
                        console.error(`[Webhook:incoming] Failed to record duplicate call ${providerCallId}:`, err);
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
                        console.error(`[Webhook:incoming] Failed to finalize duplicate call ${dupCallId}:`, err)
                    );
                    callLifecycleLogger.logTerminated(dupCallId, tenantId, null, {
                        reason: TerminationReason.CANCELLED,
                        terminated_by: TerminatedBy.SYSTEM,
                        direction: CallDirection.INBOUND,
                        duplicate_of: activeCall.id,
                    }).catch(() => { });
                }
                return;
            }

            // Optional consumer enrichment (name, refs) or rejection, bounded by a timeout.
            const lookup = await customerLookup.lookup(tenantId, {
                channel: Channel.WHATSAPP,
                channelAddress: channel.address,
                customerAddress,
                customerAddressType,
                customerName: baseRow.customer_name,
            });

            const queue = await queueRouter.getQueue(channel.inbound_queue_id);

            // IVR is an overlay on the queue: a flow whose trigger holds takes the
            // call first; it reaches the queue when the flow transfers it.
            const ivrFlowId = lookup.reject ? null : await queueRouter.selectIvrFlow(channel, queue);

            const assignedAgent = (!lookup.reject && !ivrFlowId) ? await queueRouter.claimForNewCall(queue) : null;
            const userId = assignedAgent?.id ?? null;

            const callId = await CallRepository.create({
                ...baseRow,
                customer_name: lookup.customerName ?? baseRow.customer_name,
                external_ref: lookup.externalRef ?? null,
                consumer_metadata: lookup.consumerMetadata ?? null,
                agent_id: userId,
                ivr_flow_id: ivrFlowId,
                // state='IVR' set at insert closes the window where the queue drain
                // could see this call as assignable before IVR claims it.
                state: ivrFlowId ? 'IVR' : null,
                metadata: { provider: providerMetadata },
            });
            consumerEventPublisher.publishForCall(callId, 'call.created');

            await CallConnectionRepository.create({
                call_id: callId,
                connection_type: ConnectionType.CUSTOMER,
                remote_sdp: session.sdp,
            });

            if (lookup.reject) {
                await this._rejectByConsumer(callId, tenantId, userId);
                return;
            }

            // Race safety net: a `terminate` for this call can land (and write its
            // tombstone) after the pre-check above but before this create
            // finished. Without this re-check the call would sit in RINGING
            // forever. Finalize as CANCELLED and stop before ringing anyone.
            const lateTombstone = await redisBaseService.get(tombstoneKey(providerCallId));
            if (lateTombstone) {
                await CallRepository.finalizeFromWebhook(callId, {
                    status: CallStatus.TERMINATED,
                    terminationReason: TerminationReason.CANCELLED,
                    terminatedBy: TerminatedBy.CUSTOMER,
                    endedAt: ringingAt,
                    answeredAt: null,
                    callDuration: 0,
                    ringingDuration: 0,
                });
                if (userId) {
                    await agentAssignmentCoordinator.releaseAgentIfIdle(userId).catch((err) =>
                        console.error(`[Webhook:incoming] race-release agent ${userId} failed:`, err)
                    );
                }
                callLifecycleLogger.logTerminated(callId, tenantId, userId ?? null, {
                    reason: 'TERMINATED',
                    terminated_by: TerminatedBy.CUSTOMER,
                    direction: CallDirection.INBOUND,
                    out_of_order_terminate: true,
                    race: 'connect_create_after_terminate_tombstone',
                }).catch((err) => console.error(`[Webhook:incoming] race-log error:`, err));
                await redisBaseService.del(tombstoneKey(providerCallId));
                EventBus.emit('call:terminated', {
                    callId,
                    tenantId,
                    reason: 'provider_termination_race',
                    terminationReason: TerminationReason.CANCELLED,
                });
                console.log(`[Webhook:incoming] Race detected for ${providerCallId}: finalized call ${callId} as CANCELLED.`);
                return;
            }

            if (userId) {
                const agentSocketCount = await presenceService.getUserSocketCount(userId);
                await callLifecycleLogger.logAssigned(callId, tenantId, userId, {
                    assignment_type: AssignmentType.DIRECT,
                    queue_id: queue?.id ?? null,
                    queue_strategy: queue?.strategy ?? null,
                    agent_connected: agentSocketCount > 0,
                    agent_socket_count: agentSocketCount,
                });
            } else {
                await callLifecycleLogger.logQueued(callId, tenantId, {
                    providerCallId,
                    queue_id: queue?.id ?? null,
                    queue_strategy: queue?.strategy ?? null,
                });
            }

            const callRow = await CallRepository.findById(callId);

            // ── IVR: auto-accept the WhatsApp call without waiting for an agent ──
            if (ivrFlowId) {
                console.log(`[Webhook:incoming] IVR call ${callId} — auto-accepting for flow ${ivrFlowId}`);
                const ivrAnsweredAt = new Date();
                const flowHeader = await IvrRepository.findFlowHeader(ivrFlowId, tenantId).catch(() => null);
                try {
                    const customerSdpAnswer = await sdpCoordinator.createSDPAnswer(
                        callId, session.sdp, ConnectionType.CUSTOMER
                    );
                    await acceptWhatsAppCall(callId, customerSdpAnswer);
                    // Guarded (state='IVR'): acceptWhatsAppCall is a real ~0.5s round
                    // trip and a trivial flow can finish before it returns — see
                    // markIvrAutoAccepted's own comment.
                    await CallRepository.markIvrAutoAccepted(callId);
                    await CallRepository.updateTimestamp(callId, 'answered_at', ivrAnsweredAt);
                    await callLifecycleLogger.logIvrAutoAccepted(callId, tenantId, {
                        providerCallId,
                        ivr_flow_id: ivrFlowId,
                        ivr_flow_name: flowHeader?.name ?? null,
                        accepted_by: 'system',
                    });
                    console.log(`[Webhook:incoming] IVR call ${callId} accepted by system — IVR session starts on media connect`);
                } catch (ivrErr) {
                    console.error(`[Webhook:incoming] IVR auto-accept failed for call ${callId}:`, ivrErr);
                }

                // Supervisors see the call; IVR assignment type tells clients no
                // agent can accept it yet.
                EventBus.emit('call:incoming', IncomingCallPayload.fromCall(
                    { ...callRow, status: CallStatus.IN_PROGRESS, state: 'IVR', answered_at: ivrAnsweredAt },
                    { agentId: null, offeredAgentIds: [], assignmentType: AssignmentType.IVR }
                ));
                return;
            }

            const sdpOffer = await sdpCoordinator.createSDPOffer(callId, ConnectionType.AGENT, callEventHandler.handleCallEvent);

            if (userId) {
                EventBus.emit('call:incoming', IncomingCallPayload.fromCall(callRow, {
                    agentId: userId,
                    agentName: assignedAgent.name ?? null,
                    sdpOffer,
                    assignmentType: AssignmentType.DIRECT,
                }));
                // The claim flipped the agent ON_CALL — tell their own socket.
                EventBus.emit('call:agent_availability', {
                    tenantId,
                    userId,
                    availability: AgentAvailability.ON_CALL,
                    updatedAt: new Date().toISOString(),
                });
            } else if (queueRouter.isRingAll(queue)) {
                const offered = await queueRouter.ringAllTargets(queue, tenantId);
                EventBus.emit('call:incoming', IncomingCallPayload.fromCall(callRow, {
                    agentId: null,
                    offeredAgentIds: offered.map((a) => a.id),
                    sdpOffer,
                    assignmentType: AssignmentType.QUEUED,
                }));
            } else {
                EventBus.emit('call:waiting', { callId, tenantId, queueId: queue?.id ?? null });
                // No agent claimed at webhook time (all busy, or older calls waiting)
                // — drain now so it's picked up as soon as someone is free.
                agentAssignmentCoordinator.assignOldestUnassignedCall(tenantId).catch((err) =>
                    console.error(`[Webhook:incoming] deferred assignment trigger failed for call ${callId}:`, err)
                );
            }

            await agentAssignmentCoordinator.emitQueueUpdate(tenantId, queue?.id ?? null);
        } catch (error) {
            console.error(`[Webhook:incoming] Failed to handle call ${providerCallId}:`, error);
        }
    }

    // The consumer's lookup hook asked to reject this call.
    async _rejectByConsumer(callId, tenantId, userId) {
        try {
            await rejectWhatsAppCall(callId);
        } catch (err) {
            console.error(`[Webhook:incoming] Reject (consumer lookup) failed at provider for call ${callId}:`, err);
        }
        await CallRepository.terminateCallIfNotTerminated(callId, TerminationReason.REJECTED, TerminatedBy.SYSTEM);
        if (userId) await agentAssignmentCoordinator.releaseAgentIfIdle(userId).catch(() => { });
        callLifecycleLogger.logTerminated(callId, tenantId, null, {
            reason: TerminationReason.REJECTED,
            terminated_by: TerminatedBy.SYSTEM,
            direction: CallDirection.INBOUND,
            rejected_by_lookup: true,
        }).catch(() => { });
        EventBus.emit('call:terminated', { callId, tenantId, reason: 'rejected_by_consumer' });
        console.log(`[Webhook:incoming] Call ${callId} rejected by consumer lookup hook`);
    }

    // ── Missed-before-connect handler ─────────────────────────────────────────
    // Persists an inbound call directly as missed when its `terminate` webhook
    // arrived before `connect`. No agent is assigned and nothing rings.
    async _handleMissedBeforeConnect({ baseRow, providerMetadata, tombRaw }) {
        let payload = {};
        try { payload = JSON.parse(tombRaw) ?? {}; } catch { /* malformed tombstone — treat as empty */ }

        // No media ever flowed, so treat the call as instantaneous: CANCELLED
        // with 0s rather than a fabricated ring duration.
        const isFailed = payload.status === 'FAILED';
        const terminationReason = isFailed ? TerminationReason.SYSTEM_ERROR : TerminationReason.CANCELLED;
        const endedAt = payload.end_time
            ? new Date(parseInt(payload.end_time) * 1000)
            : (payload.timestamp ? new Date(parseInt(payload.timestamp) * 1000) : baseRow.ringing_at);

        // Created as RINGING (not terminal) so finalize* below can set
        // termination_reason/terminated_by — their Phase-2 guard skips terminal rows.
        const callId = await CallRepository.create({
            ...baseRow,
            metadata: {
                provider: providerMetadata,
                customer_cancelled_immediately: !isFailed,
                out_of_order_terminate: true,
            },
        });
        consumerEventPublisher.publishForCall(callId, 'call.created');

        if (isFailed) {
            await CallRepository.finalizeCallAsFailed(callId, {
                terminatedBy: TerminatedBy.PROVIDER,
                endedAt,
                callDuration: 0,
                ringingDuration: 0,
            });
        } else {
            await CallRepository.finalizeFromWebhook(callId, {
                status: CallStatus.TERMINATED,
                terminationReason,
                terminatedBy: TerminatedBy.CUSTOMER,
                endedAt,
                answeredAt: null,
                callDuration: 0,
                ringingDuration: 0,
            });
        }

        if (isFailed && (payload.errors || payload.biz_opaque_callback_data)) {
            const details = {};
            if (payload.errors) details.errors = payload.errors;
            if (payload.biz_opaque_callback_data) details.provider_callback_data = payload.biz_opaque_callback_data;
            await CallRepository.updateFailureDetails(callId, details);
        }

        await redisBaseService.del(tombstoneKey(baseRow.provider_call_id));

        callLifecycleLogger.logQueued(callId, baseRow.tenant_id, {
            providerCallId: baseRow.provider_call_id,
            out_of_order_terminate: true,
        }).catch((err) => console.error(`[Webhook:incoming] missed-call logQueued error:`, err));

        callLifecycleLogger.logTerminated(callId, baseRow.tenant_id, null, {
            reason: isFailed ? CallStatus.FAILED : CallStatus.TERMINATED,
            terminated_by: TerminatedBy.CUSTOMER,
            direction: CallDirection.INBOUND,
            out_of_order_terminate: true,
        }).catch((err) => console.error(`[Webhook:incoming] missed-call logTerminated error:`, err));

        EventBus.emit('call:terminated', {
            callId,
            tenantId: baseRow.tenant_id,
            reason: 'provider_termination_before_connect',
            terminationReason,
        });

        console.log(
            `[Webhook:incoming] Out-of-order terminate consumed for ${baseRow.provider_call_id}; ` +
            `created missed call ${callId} (no agent assigned, no ring).`
        );
    }

    // ── Outgoing call handler ─────────────────────────────────────────────────

    async _handleOutgoingCall(call, existingCall) {
        const { id: providerCallId, session } = call;
        try {
            await redisPubSubService.publishCallEvent(existingCall.id, EventTypes.CUSTOMER_ANSWER_RECEIVED, {
                callId: existingCall.id,
                providerCallId,
                sdpAnswer: session.sdp,
            });
        } catch (error) {
            console.error(`[Webhook:outgoing] Error handling call ${providerCallId}:`, error);
            throw error;
        }
    }

    // ── Terminate handler ─────────────────────────────────────────────────────

    async _handleCallTerminate(call, channel) {
        const { id: providerCallId, status, duration, start_time, end_time, timestamp, errors, biz_opaque_callback_data } = call;

        try {
            let existingCall = await CallRepository.findByProviderCallId(providerCallId);

            if (!existingCall) {
                await new Promise(resolve => setTimeout(resolve, 300));
                existingCall = await CallRepository.findByProviderCallId(providerCallId);
                if (!existingCall) {
                    // Out-of-order delivery: terminate beat connect. Leave a
                    // tombstone so the late connect persists a missed call instead
                    // of ringing an agent for a call Meta already finished.
                    const tombstonePayload = JSON.stringify({
                        providerCallId,
                        status: status ?? null,
                        duration: duration ?? null,
                        start_time: start_time ?? null,
                        end_time: end_time ?? null,
                        timestamp: timestamp ?? null,
                        errors: errors ?? null,
                        biz_opaque_callback_data: biz_opaque_callback_data ?? null,
                        recordedAt: Date.now(),
                    });
                    await redisBaseService.setnx(tombstoneKey(providerCallId), tombstonePayload, TERMINATE_TOMBSTONE_TTL_SECONDS);
                    console.warn(
                        `[Webhook:terminate] Out-of-order: no row for ${providerCallId} after retry; ` +
                        `recorded tombstone (TTL ${TERMINATE_TOMBSTONE_TTL_SECONDS}s) for late connect`
                    );
                    return;
                }
            }

            if (!this._belongsTo(existingCall, channel)) return;

            const {
                id: callId,
                agent_id: userId,
                tenant_id: tenantId,
                queue_id: queueId,
                status: existingStatus,
                ringing_at: ringingAt,
                answered_at: existingAnsweredAt,
                ended_at: existingEndedAt,
                failure_details: existingFailureDetailsRaw,
                direction,
            } = existingCall;

            let existingFailureDetails = null;
            if (existingFailureDetailsRaw) {
                if (typeof existingFailureDetailsRaw === 'string') {
                    try {
                        existingFailureDetails = JSON.parse(existingFailureDetailsRaw);
                    } catch {
                        console.warn(`[Webhook:terminate] Malformed failure_details for call ${callId} — treating as null`);
                    }
                } else {
                    existingFailureDetails = existingFailureDetailsRaw;
                }
            }

            // ── Meta's authoritative timing (unix seconds) ───────────────────────
            // start_time is absent for pre-connect terminations; end_time/duration
            // may be absent for failures — `timestamp` then stands in for ended_at.
            const answeredAt = start_time ? new Date(parseInt(start_time) * 1000) : null;
            const endedAt = end_time
                ? new Date(parseInt(end_time) * 1000)
                : (timestamp ? new Date(parseInt(timestamp) * 1000) : null);
            const metaDurationSec = duration ? parseInt(duration) : null;

            const effectiveAnsweredAt = answeredAt ?? (existingAnsweredAt ? new Date(existingAnsweredAt) : null);
            const effectiveEndedAt = endedAt ?? (existingEndedAt ? new Date(existingEndedAt) : new Date());
            let callDurationSec = metaDurationSec;
            if (callDurationSec == null) {
                callDurationSec = (effectiveAnsweredAt && effectiveEndedAt)
                    ? Math.max(0, Math.floor((effectiveEndedAt - effectiveAnsweredAt) / 1000))
                    : 0;
            }

            // ringing_duration from our ringing_at + the effective answer time (so a
            // call already FAILED locally still gets a correct value when Meta
            // omits start_time).
            let ringingDurationSec = null;
            if (ringingAt && effectiveAnsweredAt) {
                ringingDurationSec = Math.max(0, Math.floor((effectiveAnsweredAt - new Date(ringingAt)) / 1000));
            } else if (ringingAt && !effectiveAnsweredAt) {
                const ringingEnd = endedAt ?? new Date();
                ringingDurationSec = Math.max(0, Math.floor((ringingEnd - new Date(ringingAt)) / 1000));
            }

            // Some provider error codes (138019, 138021) arrive with a non-FAILED
            // status but a populated errors array — treat any errors as a failure.
            const isFailed = status === 'FAILED' || (Array.isArray(errors) && errors.length > 0);

            // ── termination_reason, highest priority first ───────────────────────
            //  1. PROVIDER_ERROR — the provider failed the call.
            //  2. No start_time and still pre-connect on our side:
            //       INBOUND  <5s ringing → CANCELLED (customer gave up at once)
            //       INBOUND ≥5s ringing → NO_ANSWER
            //       OUTBOUND              → NO_ANSWER
            //  3. No start_time but we'd marked IN_PROGRESS: the customer cancelled
            //     at the instant the agent accepted — CANCELLED, nothing was exchanged.
            //  4. COMPLETED otherwise.
            let terminationReason = TerminationReason.COMPLETED;
            if (isFailed) {
                terminationReason = TerminationReason.PROVIDER_ERROR;
            } else if (!answeredAt) {
                if (ringingDurationSec == null) ringingDurationSec = 0;
                if (existingStatus === CallStatus.INITIATED || existingStatus === CallStatus.RINGING) {
                    const isInbound = direction === CallDirection.INBOUND;
                    terminationReason = (isInbound && ringingDurationSec < 5)
                        ? TerminationReason.CANCELLED
                        : TerminationReason.NO_ANSWER;
                } else if (existingStatus === CallStatus.IN_PROGRESS) {
                    terminationReason = TerminationReason.CANCELLED;
                }
            }

            // terminated_by: keep whatever the agent path already stamped (COALESCE
            // in finalize*); otherwise CUSTOMER, or PROVIDER for provider failures.
            const webhookTerminatedBy = isFailed ? TerminatedBy.PROVIDER : TerminatedBy.CUSTOMER;

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

            // Merge the provider's errors with internal errors (90xxx codes) that
            // local detection paths may already have written.
            if (isFailed) {
                const providerErrors = errors ?? [];
                const providerExtra = {};
                if (providerErrors.length > 0) providerExtra.errors = providerErrors;
                if (biz_opaque_callback_data) providerExtra.provider_callback_data = biz_opaque_callback_data;

                if (Object.keys(providerExtra).length) {
                    const existing = existingFailureDetails ?? {};
                    await CallRepository.updateFailureDetails(callId, {
                        ...existing,
                        ...providerExtra,
                        errors: [...(existing.errors ?? []), ...(providerExtra.errors ?? [])],
                    });
                }

                emitCallError({ callId, code: errors?.[0]?.code, message: errors?.[0]?.title });

                // Already FAILED by a local path (e.g. CUSTOMER_NETWORK_LOSS): Phase 2
                // was blocked, leaving terminated_by=SYSTEM. Patch it from the first
                // error code — relay-side errors are the provider's, others the customer's.
                if (!finalizedByThisWebhook && errors?.length > 0) {
                    const relayErrors = new Set([138019, 138020, 138021]);
                    const providerTerminatedBy = relayErrors.has(errors[0].code)
                        ? TerminatedBy.PROVIDER
                        : TerminatedBy.CUSTOMER;
                    await CallRepository.updateTerminatedByIfFailed(callId, providerTerminatedBy);
                }
            }

            // Safety net: never leave ended_at null after the webhook is processed.
            if (!endedAt && !existingEndedAt) {
                await CallRepository.updateTimestamp(callId, 'ended_at');
            }

            // ── Post-termination side effects ─────────────────────────────────────
            // Only when this webhook caused the transition — the agent hang-up path
            // already released/logged if it won the race.
            if (finalizedByThisWebhook && userId) {
                try {
                    if (direction === CallDirection.OUTBOUND) {
                        await agentAssignmentCoordinator.releaseAgentOfflineIfIdle(userId);
                    } else {
                        await agentAssignmentCoordinator.releaseAgentIfIdle(userId);
                        await agentAssignmentCoordinator.assignOldestUnassignedCall(tenantId);
                    }
                    await agentAssignmentCoordinator.emitQueueUpdate(tenantId, queueId);
                } catch (err) {
                    console.error(`[Webhook:terminate] Agent release error for call ${providerCallId}:`, err);
                }

                if (direction === CallDirection.INBOUND && terminationReason === TerminationReason.NO_ANSWER) {
                    await this._applyAutoOffline({ callId, tenantId, queueId, userId });
                }
            }

            if (finalizedByThisWebhook) {
                callLifecycleLogger.logTerminated(callId, tenantId, userId ?? null, {
                    reason: isFailed ? 'FAILED' : status,
                    terminated_by: webhookTerminatedBy,
                    direction,
                }).catch((err) => {
                    console.error(`[Webhook:terminate] Lifecycle log error for call ${providerCallId}:`, err);
                });

                // Only the path that caused the transition notifies — the owning
                // worker already told clients if the agent path won.
                await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TERMINATED, {
                    callId,
                    userId: userId ?? null,
                    reason: isFailed ? 'failed' : 'completed',
                });

                EventBus.emit('call:terminated', { callId, tenantId, reason: 'provider_termination' });
            }
        } catch (error) {
            console.error(`[Webhook:terminate] Error for call ${providerCallId}:`, error);
        }
    }

    // Auto-offline policy: an agent who misses N consecutive offers is taken
    // offline. Only for queues that offer to one agent at a time — under
    // RING_ALL nobody in particular "missed" the call.
    async _applyAutoOffline({ callId, tenantId, queueId, userId }) {
        try {
            const queue = queueId ? await queueRouter.getQueue(queueId) : null;
            if (!queue || queueRouter.isRingAll(queue)) return;

            const policy = await TenantRepository.getAutoOfflineSettings(tenantId);
            if (!policy.enabled) return;

            // A NO_ANSWER while the agent is on another active call was a
            // double-dispatch race, not negligence — don't count it.
            if (await CallRepository.hasAgentActiveCall(userId, callId)) {
                console.log(`[AutoOffline] Skipping missed-streak for agent ${userId} — on an active call (missed=${callId})`);
                return;
            }

            const streak = await agentMissedCallTracker.increment(userId);
            console.log(`[AutoOffline] Agent ${userId} missed-streak=${streak}/${policy.threshold} (tenant=${tenantId}, call=${callId})`);
            if (streak < policy.threshold) return;

            const flipped = await AgentRepository.updateAgentAvailability(userId, AgentAvailability.OFFLINE);
            await agentMissedCallTracker.reset(userId);
            if (flipped) {
                EventBus.emit('call:agent_availability', {
                    tenantId,
                    userId,
                    availability: AgentAvailability.OFFLINE,
                    reason: 'auto_offline_missed_calls',
                    consecutiveMissed: streak,
                    updatedAt: new Date().toISOString(),
                });
                await agentAssignmentCoordinator.emitQueueUpdate(tenantId).catch(() => { });
                console.log(`[AutoOffline] Flipped agent ${userId} OFFLINE after ${streak} consecutive missed calls`);
            }
        } catch (err) {
            console.error(`[AutoOffline] policy check failed for agent ${userId}:`, err);
        }
    }
}

export const callWebhookProcessor = new CallWebhookProcessor();
