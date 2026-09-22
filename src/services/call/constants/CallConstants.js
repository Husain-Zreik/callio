// services/call/constants/CallConstants.js
// Single source of truth for all call-domain enumerations.
// Import from here — never use raw string literals for these values.

export const ConnectionType = Object.freeze({
    FRONTEND: 'FRONTEND',
    WHATSAPP: 'WHATSAPP',
    MONITOR: 'MONITOR',
});

export const CallStatus = Object.freeze({
    INITIATED: 'INITIATED',
    RINGING: 'RINGING',
    IN_PROGRESS: 'IN_PROGRESS',
    TERMINATED: 'TERMINATED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
});

export const AgentAvailability = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    OFFLINE: 'OFFLINE',
    ON_CALL: 'ON_CALL',
});

export const CallDirection = Object.freeze({
    INBOUND: 'INBOUND',
    OUTBOUND: 'OUTBOUND',
});

export const AssignmentType = Object.freeze({
    DIRECT: 'DIRECT',
    QUEUED: 'QUEUED',
    TRANSFERRED: 'TRANSFERRED',
    IVR: 'IVR',
});

export const RoutingStrategy = Object.freeze({
    QUEUE: 'QUEUE',
    PRIORITY: 'PRIORITY',
    RECEPTIONIST: 'RECEPTIONIST',
    // IVR is NOT a routing strategy — it is a per-number overlay that activates
    // alongside any of the above strategies when an active IVR menu exists for
    // the called business number.
});

export const TerminationReason = Object.freeze({
    COMPLETED: 'COMPLETED',
    NO_ANSWER: 'NO_ANSWER',
    TIMEOUT: 'TIMEOUT',
    // Used for both inbound and outbound early cancellations.
    // The call direction tells you who cancelled:
    //   INBOUND  → client gave up before an agent answered (formerly CLIENT_CANCELLED)
    //   OUTBOUND → business cancelled before the client answered
    CANCELLED: 'CANCELLED',
    REJECTED: 'REJECTED',
    AGENT_DISCONNECTED: 'AGENT_DISCONNECTED',
    AGENT_MEDIA_NOT_READY: 'AGENT_MEDIA_NOT_READY',
    SYSTEM_ERROR: 'SYSTEM_ERROR',
    SERVICE_MAINTENANCE: 'SERVICE_MAINTENANCE',
    // ICE / WebRTC connectivity failure that could not be recovered after retries.
    // Always paired with CallStatus.FAILED and TerminatedBy.SYSTEM.
    NETWORK_ERROR: 'NETWORK_ERROR',
    // Customer-side RTP silence detected by CustomerSilenceWatchdog (no incoming
    // audio frames for the configured threshold). Always paired with
    // CallStatus.FAILED and TerminatedBy.SYSTEM.
    CUSTOMER_NETWORK_LOSS: 'CUSTOMER_NETWORK_LOSS',
    // Meta/provider-level failure (call:terminate status=FAILED or statuses
    // entry with status=FAILED). Always paired with CallStatus.FAILED.
    PROVIDER_ERROR: 'PROVIDER_ERROR',
    // IVR transferred the call to an agent but the agent did not accept within
    // the configured ring timeout (default 60 s, per-menu via ivr_menus.agent_ring_timeout).
    IVR_AGENT_NO_ANSWER: 'IVR_AGENT_NO_ANSWER',
});

export const TerminatedBy = Object.freeze({
    BUSINESS: 'BUSINESS',
    SYSTEM: 'SYSTEM',   // our infrastructure caused the failure (agent disconnect, cleanup, IVR error)
    CLIENT: 'CLIENT',   // the WhatsApp end-user caused it (hang-up, rejected, no answer)
    WHATSAPP: 'WHATSAPP', // WhatsApp/Meta reported a provider-level failure via webhook errors array
});

export const InitiatorType = Object.freeze({
    AGENT: 'agent',
    SUPERVISOR: 'supervisor',
    SYSTEM: 'system',
});

// Internal error objects written to callback_data.errors when our server detects
// a call failure before Meta's termination webhook arrives. Follow the same
// { code, title, details } shape as Meta error objects so callback_data.errors
// is a uniform array regardless of whether the error came from us or Meta.
// Codes use the 90000 range — Meta uses 1380xx — so the source is unambiguous.
export const InternalErrorCodes = Object.freeze({
    NETWORK_ERROR: Object.freeze({
        code: 90001,
        title: 'ICE/WebRTC connectivity failure — reconnect attempts exhausted',
        details: 'Server-side ICE reconnect was attempted but could not restore the WebRTC connection within the allowed retries.',
        source: 'SYSTEM',
    }),
    CUSTOMER_NETWORK_LOSS: Object.freeze({
        code: 90002,
        title: 'Customer network loss — no incoming audio from WhatsApp client',
        details: 'Server-side silence watchdog detected sustained RTP silence from the WhatsApp client beyond the configured threshold.',
        source: 'SYSTEM',
    }),
});
