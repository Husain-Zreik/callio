// src/core/channels/ChannelIngress.js
// Where customer-channel adapters report what their provider says about a
// call, in Callio's terms. Everything a call's lifecycle needs from the
// customer side lives here once, for every channel: dedup, the consumer
// lookup, IVR vs. queue, offering agents, termination reasons and timing,
// releasing agents, auto-offline. An adapter (src/channels/<name>/) only
// resolves its line to a `channels` row, translates its payloads into the
// calls below, and implements the outbound actions in CustomerChannels.js.
//
// Every method takes the resolved `channel` row and a provider call id; a
// provider event can only touch calls on its own channel.
//
//   inboundCall(channel, { providerCallId, customer: { address, addressType, name },
//                          sdpOffer, offeredAt, providerMetadata })
//   outboundAnswered(channel, { providerCallId, sdpAnswer })
//   statusChanged(channel, { providerCallId, status, at })
//       status: RINGING | ACCEPTED | REJECTED | FAILED (others are relayed only)
//   callEnded(channel, { providerCallId, providerStatus, failed, answeredAt, endedAt,
//                        durationSec, errors, providerCallbackData, failureTerminatedBy })
//       answeredAt/endedAt/durationSec: the provider's own timing when it has it
//       errors: [{ code, title, ... }] as the provider reported them
//       failureTerminatedBy: who a provider failure is attributed to (PROVIDER | CUSTOMER)
import EventBus from '../EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import IvrRepository from '../../persistence/IvrRepository.js';
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import { callEventHandler } from '../events/CallEventHandler.js';
import { sdpCoordinator } from '../../media/webrtc/SDPCoordinator.js';
import { callOwnershipService } from '../../infra/cluster/CallOwnershipService.js';
import { redisPubSubService } from '../../infra/redis/RedisPubSubService.js';
import { redisCleanupService } from '../../infra/cluster/RedisCleanupService.js';
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { agentAssignmentCoordinator } from '../routing/AgentAssignmentCoordinator.js';
import { queueRouter } from '../routing/QueueRouter.js';
import { callLifecycleLogger } from '../calls/CallLifecycleLogger.js';
import { customerLookup } from '../calls/CustomerLookup.js';
import { consumerEventPublisher } from '../events/ConsumerEventPublisher.js';
import { EventTypes } from '../events/EventTypes.js';
import { emitCallError } from '../events/CallErrorEmitter.js';
import { presenceService } from '../agents/PresenceService.js';
import { IncomingCallPayload } from '../calls/IncomingCallPayload.js';
import { customerChannels } from './CustomerChannels.js';
import { callTerminator } from '../calls/CallTerminator.js';
import { autoOfflinePolicy } from '../routing/AutoOfflinePolicy.js';
import {
    CallStatus,
    CallDirection,
    ConnectionType,
    AssignmentType,
    AgentAvailability,
    TerminationReason,
    TerminatedBy,
} from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.channels.ChannelIngress');

// Tombstone written when the provider's end-of-call arrives before its
// inbound offer. The late offer looks this up to persist the call directly
// as a missed call instead of ringing an agent for a call that already ended.
// TTL bounds how long we'll wait for the offer to land.
const TERMINATE_TOMBSTONE_PREFIX = 'call:terminate:tombstone:';
const TERMINATE_TOMBSTONE_TTL_SECONDS = 120;

// Provider call ids are only unique per channel type.
const providerKey = (channel, providerCallId) => `${channel.type}:${providerCallId}`;
const tombstoneKey = (channel, providerCallId) => `${TERMINATE_TOMBSTONE_PREFIX}${providerKey(channel, providerCallId)}`;

const toDate = (value) => (value ? new Date(value) : null);

class ChannelIngress {

    // A call row may only be touched by events for its own line.
    _belongsTo(call, channel) {
        if (String(call.channel_id) === String(channel.id)) return true;
        log.warn({ callId: call.id, channelId: channel.id, callChannelId: call.channel_id }, 'Event for a call on another channel — ignored');
        return false;
    }

    _findCall(channel, providerCallId) {
        return CallRepository.findByProviderCallId(providerCallId, channel.type);
    }

    // Offers and answers are handled by exactly one worker: the one that
    // claims the provider call id holds the call's media from then on. Once
    // the call is live the claim becomes permanent; if it's already over the
    // claim is dropped.
    async _withOwnership(channel, providerCallId, fn) {
        const key = providerKey(channel, providerCallId);
        const claimed = await callOwnershipService.claimCall(key, 180);
        if (!claimed) {
            const owner = await callOwnershipService.getCallOwner(key);
            log.debug(`Skipping ${key} — already owned by worker ${owner}`);
            return;
        }
        try {
            await fn();
        } finally {
            const latestCall = await this._findCall(channel, providerCallId);
            if (!latestCall || [CallStatus.TERMINATED, CallStatus.FAILED].includes(latestCall.status)) {
                await redisCleanupService.cleanupCall(key);
            } else if (!(await callOwnershipService.setCallOwnershipPermanent(key))) {
                log.warn(`Could not make ownership permanent for ${key}`);
            }
        }
    }

    // ── Inbound call offered ──────────────────────────────────────────────────

    async inboundCall(channel, event) {
        const existing = await this._findCall(channel, event.providerCallId);
        if (existing) {
            log.warn({ providerCallId: event.providerCallId }, 'Call already exists — skipping');
            return;
        }
        await this._withOwnership(channel, event.providerCallId, () => this._handleIncomingCall(channel, event));
    }

    async _handleIncomingCall(channel, { providerCallId, customer, sdpOffer, offeredAt, providerMetadata = null }) {
        try {
            const tenantId = channel.tenant_id;
            const ringingAt = offeredAt ? new Date(offeredAt) : new Date();

            const baseRow = {
                tenant_id: tenantId,
                channel_id: channel.id,
                channel: channel.type,
                channel_address: channel.address,
                provider_call_id: providerCallId,
                queue_id: channel.inbound_queue_id ?? null,
                customer_address: customer.address,
                customer_address_type: customer.addressType,
                customer_name: customer.name ?? null,
                direction: CallDirection.INBOUND,
                status: CallStatus.RINGING,
                ringing_at: ringingAt,
            };
            const metadata = providerMetadata ? { provider: providerMetadata } : {};

            // Out of order: the provider already ended this call — persist it
            // directly as a missed call.
            const tombRaw = await redisBaseService.get(tombstoneKey(channel, providerCallId));
            if (tombRaw) {
                await this._handleMissedBeforeOffer(channel, { baseRow, metadata, tombRaw });
                return;
            }

            // Dedup: a provider can offer the same caller twice within
            // milliseconds under different call ids (relay retry). The per-call
            // ownership lock can't catch that, so record the duplicate as
            // CANCELLED for the audit trail and stop — no ring, no media.
            const activeCall = await CallRepository.findActiveInboundByCustomer(tenantId, customer.address);
            if (activeCall) {
                log.warn({ tenantId, providerCallId, customer: customer.address, activeCallId: activeCall.id }, 'Customer already has an active call — recording this one as CANCELLED');
                const dupCallId = await CallRepository.create({ ...baseRow, metadata })
                    .catch((err) => {
                        log.error({ providerCallId, err }, 'Recording the duplicate call failed');
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
                        log.error({ callId: dupCallId, err }, 'Finalizing the duplicate call failed')
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
                channel: channel.type,
                channelAddress: channel.address,
                customerAddress: customer.address,
                customerAddressType: customer.addressType,
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
                // An IVR call enters the queue when the flow transfers it.
                queued_at: ivrFlowId ? null : ringingAt,
                offered_at: userId ? new Date() : null,
                metadata,
            });
            consumerEventPublisher.publishForCall(callId, 'call.created');

            await CallConnectionRepository.create({
                call_id: callId,
                connection_type: ConnectionType.CUSTOMER,
                remote_sdp: sdpOffer,
            });

            if (lookup.reject) {
                await this._rejectByConsumer(callId);
                return;
            }

            // Race safety net: the provider's end-of-call can land (and write its
            // tombstone) after the pre-check above but before this create
            // finished. Without this re-check the call would sit in RINGING
            // forever. Finalize as CANCELLED and stop before ringing anyone.
            const lateTombstone = await redisBaseService.get(tombstoneKey(channel, providerCallId));
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
                await redisBaseService.del(tombstoneKey(channel, providerCallId));
                await callTerminator.settle(callId, {
                    reason: TerminationReason.CANCELLED,
                    terminatedBy: TerminatedBy.CUSTOMER,
                    source: 'provider_end_before_offer',
                    log: { out_of_order_terminate: true, race: 'offer_create_after_terminate_tombstone' },
                });
                log.info({ callId, providerCallId }, 'Ended by the provider during setup — finalized as CANCELLED');
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

            // ── IVR: answer the customer without waiting for an agent ──
            if (ivrFlowId) {
                log.info({ callId, ivrFlowId }, 'IVR call — auto-accepting');
                const ivrAnsweredAt = new Date();
                const flowHeader = await IvrRepository.findFlowHeader(ivrFlowId, tenantId).catch(() => null);
                try {
                    // This worker holds the media from here on, and nothing else
                    // subscribes it yet (that's the AGENT offer, after the flow
                    // transfers). Without it a CALL_TERMINATED published during the
                    // IVR — API terminate, supervisor hang-up — reaches no worker.
                    // The later AGENT offer's subscribe is a no-op; closing the
                    // call's peers unsubscribes.
                    await redisPubSubService.subscribeToCallEvents(callId, callEventHandler.handleCallEvent);
                    const adapter = customerChannels.get(channel.type);
                    const customerSdpAnswer = await sdpCoordinator.createSDPAnswer(
                        callId, sdpOffer, ConnectionType.CUSTOMER, { sdpProfile: adapter.sdp }
                    );
                    await adapter.accept(callRow, customerSdpAnswer);
                    // Guarded (state='IVR'): accepting is a real provider round trip
                    // and a trivial flow can finish before it returns — see
                    // markIvrAutoAccepted's own comment.
                    await CallRepository.markIvrAutoAccepted(callId);
                    await CallRepository.updateTimestamp(callId, 'answered_at', ivrAnsweredAt);
                    await callLifecycleLogger.logIvrAutoAccepted(callId, tenantId, {
                        providerCallId,
                        ivr_flow_id: ivrFlowId,
                        ivr_flow_name: flowHeader?.name ?? null,
                        accepted_by: 'system',
                    });
                    log.info({ callId }, 'IVR call accepted by system — IVR session starts on media connect');
                } catch (ivrErr) {
                    log.error({ callId, err: ivrErr }, 'IVR auto-accept failed');
                }

                // Supervisors see the call; IVR assignment type tells clients no
                // agent can accept it yet.
                EventBus.emit('call:incoming', IncomingCallPayload.fromCall(
                    { ...callRow, status: CallStatus.IN_PROGRESS, state: 'IVR', answered_at: ivrAnsweredAt },
                    { agentId: null, offeredAgentIds: [], assignmentType: AssignmentType.IVR }
                ));
                return;
            }

            const agentSdpOffer = await sdpCoordinator.createSDPOffer(callId, ConnectionType.AGENT, callEventHandler.handleCallEvent);

            if (userId) {
                EventBus.emit('call:incoming', IncomingCallPayload.fromCall(callRow, {
                    agentId: userId,
                    agentName: assignedAgent.name ?? null,
                    sdpOffer: agentSdpOffer,
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
                    sdpOffer: agentSdpOffer,
                    assignmentType: AssignmentType.QUEUED,
                }));
            } else {
                EventBus.emit('call:waiting', { callId, tenantId, queueId: queue?.id ?? null });
                // No agent claimed on arrival (all busy, or older calls waiting)
                // — drain now so it's picked up as soon as someone is free.
                agentAssignmentCoordinator.assignOldestUnassignedCall(tenantId).catch((err) =>
                    log.error({ callId, err }, 'deferred assignment trigger failed')
                );
            }

            await agentAssignmentCoordinator.emitQueueUpdate(tenantId, queue?.id ?? null);
        } catch (error) {
            log.error({ providerCallId, err: error }, 'Handling the inbound call failed');
        }
    }

    // The consumer's lookup hook asked to reject this call.
    async _rejectByConsumer(callId) {
        await callTerminator.end(callId, {
            reason: TerminationReason.REJECTED,
            terminatedBy: TerminatedBy.SYSTEM,
            provider: 'reject',
            source: 'rejected_by_consumer',
            log: { rejected_by_lookup: true },
        });
    }

    // Persists an inbound call directly as missed when the provider ended it
    // before its offer arrived. No agent is assigned and nothing rings.
    async _handleMissedBeforeOffer(channel, { baseRow, metadata, tombRaw }) {
        let payload = {};
        try { payload = JSON.parse(tombRaw) ?? {}; } catch { /* malformed tombstone — treat as empty */ }

        // No media ever flowed, so treat the call as instantaneous: CANCELLED
        // with 0s rather than a fabricated ring duration.
        const isFailed = payload.failed === true;
        const terminationReason = isFailed ? TerminationReason.SYSTEM_ERROR : TerminationReason.CANCELLED;
        const endedAt = toDate(payload.endedAt) ?? baseRow.ringing_at;

        // Created as RINGING (not terminal) so finalize* below can set
        // termination_reason/terminated_by — their Phase-2 guard skips terminal rows.
        const callId = await CallRepository.create({
            ...baseRow,
            metadata: {
                ...metadata,
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

        if (isFailed && (payload.errors || payload.providerCallbackData)) {
            const details = {};
            if (payload.errors) details.errors = payload.errors;
            if (payload.providerCallbackData) details.provider_callback_data = payload.providerCallbackData;
            await CallRepository.updateFailureDetails(callId, details);
        }

        await redisBaseService.del(tombstoneKey(channel, baseRow.provider_call_id));

        callLifecycleLogger.logQueued(callId, baseRow.tenant_id, {
            providerCallId: baseRow.provider_call_id,
            out_of_order_terminate: true,
        }).catch((err) => log.error({ err }, 'missed-call logQueued error'));

        await callTerminator.settle(callId, {
            reason: isFailed ? TerminationReason.PROVIDER_ERROR : terminationReason,
            terminatedBy: isFailed ? TerminatedBy.PROVIDER : TerminatedBy.CUSTOMER,
            source: 'provider_end_before_offer',
            log: { out_of_order_terminate: true },
        });

        log.info({ callId, providerCallId: baseRow.provider_call_id }, 'End arrived before the offer — recorded as a missed call');
    }

    // ── Outbound call answered ────────────────────────────────────────────────

    async outboundAnswered(channel, { providerCallId, sdpAnswer }) {
        const existingCall = await this._findCall(channel, providerCallId);
        if (!existingCall) {
            log.warn({ providerCallId }, 'No outgoing call found');
            return;
        }
        if (!this._belongsTo(existingCall, channel)) return;
        // The provider's answer may arrive after its RINGING status (delivery
        // order isn't guaranteed), so RINGING still takes the answer.
        if (existingCall.status !== CallStatus.INITIATED && existingCall.status !== CallStatus.RINGING) {
            log.warn({ callId: existingCall.id, status: existingCall.status }, 'Outgoing call is not awaiting an answer — skipping');
            return;
        }
        // The worker holding the agent's media applies the answer.
        await this._withOwnership(channel, providerCallId, () =>
            redisPubSubService.publishCallEvent(existingCall.id, EventTypes.CUSTOMER_ANSWER_RECEIVED, {
                callId: existingCall.id,
                providerCallId,
                sdpAnswer,
            })
        );
    }

    // ── Provider status updates ───────────────────────────────────────────────

    async statusChanged(channel, { providerCallId, status, at }) {
        log.info({ providerCallId, status }, 'Provider status');

        try {
            const call = await this._findCall(channel, providerCallId);
            if (!call) {
                log.warn({ providerCallId, status }, 'Status for an unknown call');
                return;
            }
            if (!this._belongsTo(call, channel)) return;

            const callId = call.id;
            const agentId = call.agent_id ?? null;
            const previousStatus = call.status;
            const timestampValue = at ? new Date(at) : new Date();
            const isTerminal = [CallStatus.TERMINATED, CallStatus.FAILED, CallStatus.CANCELLED].includes(previousStatus);

            switch (status) {
                case 'RINGING':
                    // The provider's timestamp is authoritative for ringing_at
                    // (outbound calls seed an approximation at creation).
                    await CallRepository.updateTimestamp(callId, 'ringing_at', timestampValue);
                    // Out-of-order: the end already ran before RINGING arrived —
                    // patch ringing_duration retroactively now that ringing_at is known.
                    if (isTerminal && call.ringing_duration == null) {
                        const ringingEnd = call.answered_at
                            ? new Date(call.answered_at)
                            : (call.ended_at ? new Date(call.ended_at) : new Date());
                        const retroRingingDuration = Math.max(0, Math.floor((ringingEnd - timestampValue) / 1000));
                        await CallRepository.updateDuration(callId, 'ringing_duration', retroRingingDuration);
                        log.debug({ callId }, `Retroactive ringing_duration=${retroRingingDuration}s for already-terminal call`);
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
                    // if our own termination flow raced ahead of this update.
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
                    // callEnded never runs for them, so compute here.
                    if (call.ringing_at && call.ringing_duration == null) {
                        const rejRingingDuration = Math.max(
                            0,
                            Math.floor((timestampValue - new Date(call.ringing_at)) / 1000)
                        );
                        await CallRepository.updateDuration(callId, 'ringing_duration', rejRingingDuration);
                    }
                    if (call.direction === CallDirection.OUTBOUND) {
                        callLifecycleLogger.logOutboundRejected(callId, call.tenant_id, agentId, {
                            providerCallId, previousState: previousStatus,
                        }).catch(() => { });
                    }
                    if (await CallRepository.terminateCallIfNotTerminated(callId, TerminationReason.REJECTED, TerminatedBy.CUSTOMER, timestampValue)) {
                        await callTerminator.settle(call, {
                            reason: TerminationReason.REJECTED,
                            terminatedBy: TerminatedBy.CUSTOMER,
                            source: 'customer_rejected',
                        });
                    }
                    break;

                case 'FAILED': {
                    // A provider can report FAILED as a status independently of (or
                    // instead of) its end-of-call event. Only fill durations the end
                    // event hasn't set — finalizeCallAsFailed COALESCEs, so null
                    // preserves the provider's authoritative value.
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

                    // Gate side effects: providers often send both a FAILED status
                    // and an end-of-call — only the path that finalized fires them.
                    if (failedFinalized) {
                        emitCallError({ callId, code: null, message: 'Call failed (provider status)' });
                        await callTerminator.settle(call, {
                            reason: TerminationReason.PROVIDER_ERROR,
                            terminatedBy: TerminatedBy.PROVIDER,
                            source: 'provider_status_failed',
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

            log.info({ callId }, `Updated call to ${status}`);
        } catch (error) {
            log.error({ providerCallId, status, err: error }, 'Processing the provider status failed');
        }
    }

    // ── Provider ended the call ───────────────────────────────────────────────

    // Not ownership-gated (unlike offers and answers): any worker that receives
    // it processes it directly. It never touches worker-local media state — its
    // DB writes are race-safe via the finalize* guards, and CALL_TERMINATED is
    // published over Redis to whichever worker holds the live peers.
    async callEnded(channel, event) {
        try {
            await this._handleCallEnded(channel, event);
        } finally {
            await redisCleanupService.cleanupCall(providerKey(channel, event.providerCallId));
        }
    }

    async _handleCallEnded(channel, {
        providerCallId, providerStatus = null, failed = false, answeredAt: providerAnsweredAt = null,
        endedAt: providerEndedAt = null, durationSec = null, errors = null, providerCallbackData = null,
        failureTerminatedBy = TerminatedBy.PROVIDER,
    }) {
        try {
            let existingCall = await this._findCall(channel, providerCallId);

            if (!existingCall) {
                await new Promise(resolve => setTimeout(resolve, 300));
                existingCall = await this._findCall(channel, providerCallId);
                if (!existingCall) {
                    // Out of order: the end beat the offer. Leave a tombstone so the
                    // late offer persists a missed call instead of ringing an agent
                    // for a call the provider already finished.
                    const tombstonePayload = JSON.stringify({
                        providerCallId,
                        failed,
                        endedAt: providerEndedAt ? new Date(providerEndedAt).toISOString() : null,
                        errors: errors ?? null,
                        providerCallbackData: providerCallbackData ?? null,
                        recordedAt: Date.now(),
                    });
                    await redisBaseService.setnx(tombstoneKey(channel, providerCallId), tombstonePayload, TERMINATE_TOMBSTONE_TTL_SECONDS);
                    log.warn({ providerCallId, ttlSeconds: TERMINATE_TOMBSTONE_TTL_SECONDS }, 'End for an unknown call — tombstone recorded for a late offer');
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
                        log.warn({ callId }, 'Malformed failure_details — treating as null');
                    }
                } else {
                    existingFailureDetails = existingFailureDetailsRaw;
                }
            }

            // ── The provider's authoritative timing ──────────────────────────────
            // answeredAt is absent for pre-connect ends; endedAt/duration may be
            // absent for failures.
            const answeredAt = toDate(providerAnsweredAt);
            const endedAt = toDate(providerEndedAt);

            const effectiveAnsweredAt = answeredAt ?? (existingAnsweredAt ? new Date(existingAnsweredAt) : null);
            const effectiveEndedAt = endedAt ?? (existingEndedAt ? new Date(existingEndedAt) : new Date());
            let callDurationSec = durationSec;
            if (callDurationSec == null) {
                callDurationSec = (effectiveAnsweredAt && effectiveEndedAt)
                    ? Math.max(0, Math.floor((effectiveEndedAt - effectiveAnsweredAt) / 1000))
                    : 0;
            }

            // ringing_duration from our ringing_at + the effective answer time (so a
            // call already FAILED locally still gets a correct value when the
            // provider omits its answer time).
            let ringingDurationSec = null;
            if (ringingAt && effectiveAnsweredAt) {
                ringingDurationSec = Math.max(0, Math.floor((effectiveAnsweredAt - new Date(ringingAt)) / 1000));
            } else if (ringingAt && !effectiveAnsweredAt) {
                const ringingEnd = endedAt ?? new Date();
                ringingDurationSec = Math.max(0, Math.floor((ringingEnd - new Date(ringingAt)) / 1000));
            }

            // ── termination_reason, highest priority first ───────────────────────
            //  1. PROVIDER_ERROR — the provider failed the call.
            //  2. Never answered and still pre-connect on our side:
            //       INBOUND  <5s ringing → CANCELLED (customer gave up at once)
            //       INBOUND ≥5s ringing → NO_ANSWER
            //       OUTBOUND              → NO_ANSWER
            //  3. Never answered per the provider but we'd marked IN_PROGRESS: the
            //     customer cancelled at the instant the agent accepted — CANCELLED.
            //  4. COMPLETED otherwise.
            let terminationReason = TerminationReason.COMPLETED;
            if (failed) {
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
            } else if (existingStatus === CallStatus.RINGING && existingCall.ivr_flow_id) {
            //  5. Answered by the IVR, then waiting in the queue when it ended: no
            //     agent ever took it. Same rule as an unanswered call, timed from
            //     when it entered the queue.
                const waitedSec = existingCall.queued_at
                    ? Math.max(0, Math.floor((effectiveEndedAt - new Date(existingCall.queued_at)) / 1000))
                    : 0;
                terminationReason = (direction === CallDirection.INBOUND && waitedSec < 5)
                    ? TerminationReason.CANCELLED
                    : TerminationReason.NO_ANSWER;
            }

            // terminated_by: keep whatever the agent path already stamped (COALESCE
            // in finalize*); otherwise CUSTOMER, or PROVIDER for provider failures.
            const endTerminatedBy = failed ? TerminatedBy.PROVIDER : TerminatedBy.CUSTOMER;

            let finalizedByThisEvent;
            if (failed) {
                finalizedByThisEvent = await CallRepository.finalizeCallAsFailed(callId, {
                    terminatedBy: endTerminatedBy,
                    endedAt,
                    answeredAt,
                    callDuration: callDurationSec,
                    ringingDuration: ringingDurationSec,
                });
            } else {
                finalizedByThisEvent = await CallRepository.finalizeFromWebhook(callId, {
                    status: 'TERMINATED',
                    terminationReason,
                    terminatedBy: endTerminatedBy,
                    endedAt,
                    answeredAt,
                    callDuration: callDurationSec,
                    ringingDuration: ringingDurationSec,
                });
            }

            // Merge the provider's errors with internal errors (90xxx codes) that
            // local detection paths may already have written.
            if (failed) {
                const providerErrors = errors ?? [];
                const providerExtra = {};
                if (providerErrors.length > 0) providerExtra.errors = providerErrors;
                if (providerCallbackData) providerExtra.provider_callback_data = providerCallbackData;

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
                // was blocked, leaving terminated_by=SYSTEM. Patch it with the
                // party the adapter attributes the provider's failure to.
                if (!finalizedByThisEvent && errors?.length > 0) {
                    await CallRepository.updateTerminatedByIfFailed(callId, failureTerminatedBy);
                }
            }

            // Safety net: never leave ended_at null after the end is processed.
            if (!endedAt && !existingEndedAt) {
                await CallRepository.updateTimestamp(callId, 'ended_at');
            }

            // ── Side effects ──────────────────────────────────────────────────────
            // Only when this event caused the transition — if the agent hang-up
            // path won the race it already settled the call.
            if (finalizedByThisEvent) {
                await callTerminator.settle(existingCall, {
                    reason: terminationReason,
                    terminatedBy: endTerminatedBy,
                    source: 'provider_end',
                    log: { provider_status: providerStatus },
                });
                // The customer gave up while it rang this agent: a missed offer.
                if (userId && direction === CallDirection.INBOUND && terminationReason === TerminationReason.NO_ANSWER) {
                    await autoOfflinePolicy.recordMiss({ callId, tenantId, queueId, agentId: userId });
                }
            }
        } catch (error) {
            log.error({ providerCallId, err: error }, 'Handling the provider end failed');
        }
    }
}

export const channelIngress = new ChannelIngress();
