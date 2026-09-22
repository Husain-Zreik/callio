// services/call/CallLifecycleLogger.js
import CallLifecycleEventRepository from '../../../repositories/CallLifecycleEventRepository.js';
import CallTransferLogRepository from '../../../repositories/CallTransferLogRepository.js';

class CallLifecycleLogger {
    static IVR_EVENT_TYPES = new Set([
        'ivr_auto_accepted',
        'ivr_started',
        'ivr_node_entered',
        'ivr_dtmf_received',
        'ivr_route_selected',
        'ivr_transferred',
        'ivr_terminated',
        'ivr_agent_missed',
    ]);

    #requireBusinessId(businessId, callId, methodName) {
        const normalized = Number(businessId);
        if (!Number.isInteger(normalized) || normalized <= 0) {
            throw new Error(`[CallLifecycleLogger] ${methodName} requires a valid businessId for call ${callId}`);
        }
        return normalized;
    }

    // -------------------------------------------------------------------------
    // Inbound call lifecycle methods
    // -------------------------------------------------------------------------

    async logQueued(callId, businessId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logQueued');
        await this.#insert(callId, null, 'inbound_queued', metadata, normalizedBusinessId);
    }

    async logAssigned(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logAssigned');
        await this.#insert(callId, agentId, 'inbound_assigned', metadata, normalizedBusinessId);
    }

    async logAccepted(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logAccepted');
        await this.#insert(callId, agentId, 'inbound_accepted', metadata, normalizedBusinessId);
    }

    async logRejected(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logRejected');
        await this.#insert(callId, agentId, 'inbound_rejected', metadata, normalizedBusinessId);
    }

    async logDisconnected(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logDisconnected');
        await this.#insert(callId, agentId, 'inbound_disconnected', metadata, normalizedBusinessId);
    }

    async logReconnected(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logReconnected');
        await this.#insert(callId, agentId, 'inbound_reconnected', metadata, normalizedBusinessId);
    }

    // ── Customer network connectivity events ──────────────────────────────────
    // Detected by CustomerSilenceWatchdog via PLC zero-frame analysis on the
    // WhatsApp incoming track.  Fired only on state transitions (not every frame),
    // so each entry represents a genuine drop or recovery — not a false alarm.
    // agent_id is the assigned agent at the moment of the event (may be null for
    // calls that haven't been assigned yet, though in practice audio only flows
    // once the bridge is active and an agent is on the call).

    async logCustomerNetworkDrop(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logCustomerNetworkDrop');
        await this.#insert(callId, agentId ?? null, 'customer_network_drop', metadata, normalizedBusinessId);
    }

    async logCustomerNetworkReconnected(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logCustomerNetworkReconnected');
        await this.#insert(callId, agentId ?? null, 'customer_network_reconnected', metadata, normalizedBusinessId);
    }

    /**
     * @param {number} callId
     * @param {number|null} businessId
     * @param {number|null} fromAgentId
     * @param {number} toAgentId
     * @param {object} metadata
     * @param {object} transferInitiator
     */
    async logTransferred(
        callId,
        businessId,
        fromAgentId,
        toAgentId,
        metadata = {},
        transferInitiator = { userId: null, type: 'system' }
    ) {
        try {
            const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logTransferred');
            const now = new Date();

            await this.#insert(callId, toAgentId, 'inbound_transferred', {
                ...metadata,
                from_agent_id: fromAgentId,
            }, normalizedBusinessId);

            await CallTransferLogRepository.create(
                callId,
                normalizedBusinessId,
                fromAgentId,
                toAgentId,
                transferInitiator?.userId ?? null,
                transferInitiator?.type || 'system',
                now
            );
        } catch (err) {
            console.error('[CallLifecycleLogger] logTransferred failed:', err.message);
        }
    }

    /**
     * Log the result of attempting to deliver a call:incoming event to the agent's sockets.
     * Records whether the agent had an active WebSocket connection at delivery time.
     */
    async logDeliveryAttempt(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logDeliveryAttempt');
        await this.#insert(callId, agentId, 'inbound_delivery_attempt', metadata, normalizedBusinessId);
    }

    /**
     * Log when an agent who was assigned a call while disconnected finally connects via WebSocket.
     * This helps trace the gap between assignment and the agent actually being reachable.
     */
    async logAgentConnected(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logAgentConnected');
        await this.#insert(callId, agentId, 'inbound_agent_connected', metadata, normalizedBusinessId);
    }

    async logFollowUp(callId, businessId, agentId, metadata = {}) {
        try {
            const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logFollowUp');
            const now = new Date();

            await this.#insert(callId, agentId, 'inbound_follow_up', metadata, normalizedBusinessId);

            const pending = await CallTransferLogRepository.findPendingTransfer(callId, agentId);

            if (pending) {
                const acceptanceSecs = Math.max(
                    0,
                    Math.floor((now - new Date(pending.transferred_at)) / 1000)
                );
                await CallTransferLogRepository.markAccepted(pending.id, now, acceptanceSecs);
            }
        } catch (err) {
            console.error('[CallLifecycleLogger] logFollowUp failed:', err.message);
        }
    }

    async logTerminated(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logTerminated');
        const { direction, ...rest } = metadata;
        const eventType = direction === 'OUTBOUND' ? 'outbound_terminated' : 'inbound_terminated';
        await this.#insert(callId, agentId ?? null, eventType, rest, normalizedBusinessId);
    }

    // -------------------------------------------------------------------------
    // IVR lifecycle methods (end-user facing)
    // -------------------------------------------------------------------------

    async logIvrAutoAccepted(callId, businessId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logIvrAutoAccepted');
        await this.#insert(callId, null, 'ivr_auto_accepted', metadata, normalizedBusinessId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrStarted(callId, businessId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logIvrStarted');
        await this.#insert(callId, null, 'ivr_started', metadata, normalizedBusinessId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrNodeEntered(callId, businessId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logIvrNodeEntered');
        await this.#insert(callId, null, 'ivr_node_entered', metadata, normalizedBusinessId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrDtmfReceived(callId, businessId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logIvrDtmfReceived');
        await this.#insert(callId, null, 'ivr_dtmf_received', metadata, normalizedBusinessId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrRouteSelected(callId, businessId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logIvrRouteSelected');
        await this.#insert(callId, null, 'ivr_route_selected', metadata, normalizedBusinessId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrTransferred(callId, businessId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logIvrTransferred');
        await this.#insert(callId, null, 'ivr_transferred', metadata, normalizedBusinessId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrTerminated(callId, businessId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logIvrTerminated');
        await this.#insert(callId, null, 'ivr_terminated', metadata, normalizedBusinessId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrAgentMissed(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logIvrAgentMissed');
        await this.#insert(callId, agentId ?? null, 'ivr_agent_missed', metadata, normalizedBusinessId, {
            skipDuplicateCheck: true,
        });
    }

    // -------------------------------------------------------------------------
    // Outbound call lifecycle methods
    // -------------------------------------------------------------------------

    async logOutboundInitiated(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logOutboundInitiated');
        await this.#insert(callId, agentId, 'outbound_initiated', metadata, normalizedBusinessId);
    }

    async logOutboundRinging(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logOutboundRinging');
        await this.#insert(callId, agentId, 'outbound_ringing', metadata, normalizedBusinessId);
    }

    async logOutboundAccepted(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logOutboundAccepted');
        await this.#insert(callId, agentId, 'outbound_accepted', metadata, normalizedBusinessId);
    }

    async logOutboundRejected(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logOutboundRejected');
        await this.#insert(callId, agentId, 'outbound_rejected', metadata, normalizedBusinessId);
    }

    async logOutboundFailed(callId, businessId, agentId, metadata = {}) {
        const normalizedBusinessId = this.#requireBusinessId(businessId, callId, 'logOutboundFailed');
        await this.#insert(callId, agentId, 'outbound_failed', metadata, normalizedBusinessId);
    }

    async isFollowUp(callId, agentId) {
        try {
            return await CallTransferLogRepository.hasPendingTransfer(callId, agentId);
        } catch (err) {
            console.error('[CallLifecycleLogger] isFollowUp check failed:', err.message);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    // Fetches the latest lifecycle event once and uses the result for both
    // duplicate-transition detection and duration calculation, eliminating the
    // double DB round-trip the old #secondsSincePrevious / #isDuplicateTransition
    // pair required per log call.
    async #insert(callId, agentId, eventType, metadata, businessId, options = {}) {
        // Captured synchronously, before the getLatestEvent DB round-trip below, so it
        // reflects the instant this call was actually made. Several IVR callers (see
        // IvrCoordinator's logIvrLifecycle helper) fire this fire-and-forget — without
        // an explicit timestamp taken here, occurred_at would instead be assigned by
        // MySQL's NOW() at whichever moment each INSERT happens to reach the server,
        // which is not the same order the events logically occurred in. That let two
        // unawaited writes commit out of order and reversed the story timeline.
        const occurredAt = new Date();
        try {
            const last = await CallLifecycleEventRepository.getLatestEvent(callId);

            let durationSeconds = null;
            if (last?.occurred_at) {
                const secs = Math.floor((occurredAt.getTime() - new Date(last.occurred_at).getTime()) / 1000);
                durationSeconds = secs >= 0 ? secs : null;
            }

            if (!options.skipDuplicateCheck && last && !CallLifecycleLogger.IVR_EVENT_TYPES.has(eventType)) {
                const lastAgentId = last.agent_id == null ? null : Number(last.agent_id);
                const currentAgentId = agentId == null ? null : Number(agentId);
                if (
                    last.event_type === eventType &&
                    lastAgentId === currentAgentId &&
                    durationSeconds !== null &&
                    durationSeconds <= 5
                ) {
                    return;
                }
            }

            await CallLifecycleEventRepository.insert(callId, agentId, businessId, eventType, durationSeconds, metadata, occurredAt);
        } catch (err) {
            console.error(`[CallLifecycleLogger] #insert(${eventType}) for call ${callId} failed:`, err.message);
        }
    }
}

export const callLifecycleLogger = new CallLifecycleLogger();
