// src/core/calls/CallView.js
// The one shape a call is described in to agents (socket events, resync) and
// consumers (API responses, event webhooks). Built from a `calls` row so every
// path reports the same fields the same way.

function iso(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseJson(value) {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

// A UUID-shaped id for the call, for native call UIs that require one
// (CallKit, Android Telecom). Deterministic, and sent with every call payload
// and push, so clients never derive it themselves.
export function callUuid(callId) {
    return `00000000-0000-0000-0000-${String(callId).padStart(12, '0')}`;
}

export function toCallView(call, { agentName = null, deviceId = undefined } = {}) {
    if (!call) return null;
    const view = {
        callId: call.id,
        callUuid: callUuid(call.id),
        tenantId: call.tenant_id,
        channel: call.channel,
        channelId: call.channel_id ?? null,
        channelAddress: call.channel_address ?? null,
        queueId: call.queue_id ?? null,
        direction: call.direction,
        status: call.status,
        state: call.state ?? null,
        // 'DIRECT': rtpengine alone carries it — reconnect without an offer
        // (docs/agent-protocol.md → Reconnect).
        mediaTopology: call.media_topology ?? 'ROOM',
        customer: {
            address: call.customer_address ?? null,
            addressType: call.customer_address_type ?? null,
            name: call.customer_name ?? null,
        },
        agentId: call.agent_id ?? null,
        agentName,
        externalRef: call.external_ref ?? null,
        ringingAt: iso(call.ringing_at),
        answeredAt: iso(call.answered_at),
        endedAt: iso(call.ended_at),
    };
    if (deviceId !== undefined) view.deviceId = deviceId;
    return view;
}

// Consumer-facing view: adds the terminal outcome, durations and the
// consumer's own metadata. Never includes SDP.
export function toConsumerCallView(call, { tenantRef = null, agentRef = null, agentName = null, channelRef = null } = {}) {
    const view = toCallView(call, { agentName });
    if (!view) return null;
    return {
        ...view,
        tenantRef,
        channelRef,
        agentRef,
        providerCallId: call.provider_call_id ?? null,
        ivrFlowId: call.ivr_flow_id ?? null,
        terminationReason: call.termination_reason ?? null,
        terminatedBy: call.terminated_by ?? null,
        durations: {
            ringing: call.ringing_duration ?? 0,
            call: call.call_duration ?? 0,
            queue: call.queue_duration ?? 0,
        },
        failureDetails: parseJson(call.failure_details),
        consumerMetadata: parseJson(call.consumer_metadata),
        createdAt: iso(call.created_at),
    };
}
