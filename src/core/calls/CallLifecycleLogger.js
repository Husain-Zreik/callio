// src/core/calls/CallLifecycleLogger.js
import CallLifecycleEventRepository from '../../persistence/CallLifecycleEventRepository.js';
import CallTransferLogRepository from '../../persistence/CallTransferLogRepository.js';

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

    #requireTenantId(tenantId, callId, methodName) {
        const normalized = Number(tenantId);
        if (!Number.isInteger(normalized) || normalized <= 0) {
            throw new Error(`[CallLifecycleLogger] ${methodName} requires a valid tenantId for call ${callId}`);
        }
        return normalized;
    }

    // -------------------------------------------------------------------------
    // Inbound call lifecycle methods
    // -------------------------------------------------------------------------

    async logQueued(callId, tenantId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logQueued');
        await this.#insert(callId, null, 'inbound_queued', metadata, normalizedTenantId);
    }

    async logAssigned(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logAssigned');
        await this.#insert(callId, agentId, 'inbound_assigned', metadata, normalizedTenantId);
    }

    async logAccepted(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logAccepted');
        await this.#insert(callId, agentId, 'inbound_accepted', metadata, normalizedTenantId);
    }

    async logRejected(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logRejected');
        await this.#insert(callId, agentId, 'inbound_rejected', metadata, normalizedTenantId);
    }

    async logDisconnected(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logDisconnected');
        await this.#insert(callId, agentId, 'inbound_disconnected', metadata, normalizedTenantId);
    }

    async logReconnected(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logReconnected');
        await this.#insert(callId, agentId, 'inbound_reconnected', metadata, normalizedTenantId);
    }

    // ── Customer network connectivity events ──────────────────────────────────
    // Detected by CustomerSilenceWatchdog via PLC zero-frame analysis on the
    // customer's incoming track.  Fired only on state transitions (not every frame),
    // so each entry represents a genuine drop or recovery — not a false alarm.
    // agent_id is the assigned agent at the moment of the event (may be null for
    // calls that haven't been assigned yet, though in practice audio only flows
    // once the bridge is active and an agent is on the call).

    async logCustomerNetworkDrop(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logCustomerNetworkDrop');
        await this.#insert(callId, agentId ?? null, 'customer_network_drop', metadata, normalizedTenantId);
    }

    async logCustomerNetworkReconnected(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logCustomerNetworkReconnected');
        await this.#insert(callId, agentId ?? null, 'customer_network_reconnected', metadata, normalizedTenantId);
    }

    /**
     * @param {number} callId
     * @param {number|null} tenantId
     * @param {number|null} fromAgentId
     * @param {number} toAgentId
     * @param {object} metadata
     * @param {object} transferInitiator
     */
    async logTransferred(
        callId,
        tenantId,
        fromAgentId,
        toAgentId,
        metadata = {},
        transferInitiator = { userId: null, type: 'system' }
    ) {
        try {
            const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logTransferred');
            const now = new Date();

            await this.#insert(callId, toAgentId, 'inbound_transferred', {
                ...metadata,
                from_agent_id: fromAgentId,
            }, normalizedTenantId);

            await CallTransferLogRepository.create(
                callId,
                fromAgentId,
                toAgentId,
                transferInitiator?.userId ?? null,
                transferInitiator?.type || 'system',
                now,
                metadata?.to_queue_id ?? null
            );
        } catch (err) {
            console.error('[CallLifecycleLogger] logTransferred failed:', err.message);
        }
    }

    /**
     * Log the result of attempting to deliver a call:incoming event to the agent's sockets.
     * Records whether the agent had an active WebSocket connection at delivery time.
     */
    async logDeliveryAttempt(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logDeliveryAttempt');
        await this.#insert(callId, agentId, 'inbound_delivery_attempt', metadata, normalizedTenantId);
    }

    /**
     * Log when an agent who was assigned a call while disconnected finally connects via WebSocket.
     * This helps trace the gap between assignment and the agent actually being reachable.
     */
    async logAgentConnected(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logAgentConnected');
        await this.#insert(callId, agentId, 'inbound_agent_connected', metadata, normalizedTenantId);
    }

    async logFollowUp(callId, tenantId, agentId, metadata = {}) {
        try {
            const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logFollowUp');
            const now = new Date();

            await this.#insert(callId, agentId, 'inbound_follow_up', metadata, normalizedTenantId);

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

    async logTerminated(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logTerminated');
        const { direction, ...rest } = metadata;
        const eventType = direction === 'OUTBOUND' ? 'outbound_terminated' : 'inbound_terminated';
        await this.#insert(callId, agentId ?? null, eventType, rest, normalizedTenantId);
    }

    // -------------------------------------------------------------------------
    // IVR lifecycle methods (end-user facing)
    // -------------------------------------------------------------------------

    async logIvrAutoAccepted(callId, tenantId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logIvrAutoAccepted');
        await this.#insert(callId, null, 'ivr_auto_accepted', metadata, normalizedTenantId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrStarted(callId, tenantId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logIvrStarted');
        await this.#insert(callId, null, 'ivr_started', metadata, normalizedTenantId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrNodeEntered(callId, tenantId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logIvrNodeEntered');
        await this.#insert(callId, null, 'ivr_node_entered', metadata, normalizedTenantId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrDtmfReceived(callId, tenantId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logIvrDtmfReceived');
        await this.#insert(callId, null, 'ivr_dtmf_received', metadata, normalizedTenantId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrRouteSelected(callId, tenantId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logIvrRouteSelected');
        await this.#insert(callId, null, 'ivr_route_selected', metadata, normalizedTenantId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrTransferred(callId, tenantId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logIvrTransferred');
        await this.#insert(callId, null, 'ivr_transferred', metadata, normalizedTenantId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrTerminated(callId, tenantId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logIvrTerminated');
        await this.#insert(callId, null, 'ivr_terminated', metadata, normalizedTenantId, {
            skipDuplicateCheck: true,
        });
    }

    async logIvrAgentMissed(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logIvrAgentMissed');
        await this.#insert(callId, agentId ?? null, 'ivr_agent_missed', metadata, normalizedTenantId, {
            skipDuplicateCheck: true,
        });
    }

    // -------------------------------------------------------------------------
    // Outbound call lifecycle methods
    // -------------------------------------------------------------------------

    async logOutboundInitiated(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logOutboundInitiated');
        await this.#insert(callId, agentId, 'outbound_initiated', metadata, normalizedTenantId);
    }

    async logOutboundRinging(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logOutboundRinging');
        await this.#insert(callId, agentId, 'outbound_ringing', metadata, normalizedTenantId);
    }

    async logOutboundAccepted(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logOutboundAccepted');
        await this.#insert(callId, agentId, 'outbound_accepted', metadata, normalizedTenantId);
    }

    async logOutboundRejected(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logOutboundRejected');
        await this.#insert(callId, agentId, 'outbound_rejected', metadata, normalizedTenantId);
    }

    async logOutboundFailed(callId, tenantId, agentId, metadata = {}) {
        const normalizedTenantId = this.#requireTenantId(tenantId, callId, 'logOutboundFailed');
        await this.#insert(callId, agentId, 'outbound_failed', metadata, normalizedTenantId);
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
    async #insert(callId, agentId, eventType, metadata, tenantId, options = {}) {
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

            await CallLifecycleEventRepository.insert(callId, agentId, eventType, durationSeconds, metadata, occurredAt);
        } catch (err) {
            console.error(`[CallLifecycleLogger] #insert(${eventType}) for call ${callId} failed:`, err.message);
        }
    }
}

export const callLifecycleLogger = new CallLifecycleLogger();
