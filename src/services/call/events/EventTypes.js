// services/calling/events/EventTypes.js

/**
 * Event type constants for Redis Pub/Sub
 * Prevents typos and provides single source of truth
 */
export const EventTypes = {
    AGENT_JOINED: 'agent_joined',
    AGENT_RECONNECTED: 'agent_reconnected',
    RINGING_AGENT_RECONNECT: 'ringing_agent_reconnect',
    FRONTEND_DISCONNECTED: 'frontend_disconnected',
    ICE_CANDIDATE: 'ice_candidate',
    MONITOR_STARTED: 'monitor_started',
    MONITOR_STOPPED: 'monitor_stopped',
    MONITOR_MODE_CHANGED: 'monitor_mode_changed',
    AGENT_PRIVATE_CHANGED: 'agent_private_changed',
    CALL_INITIATE: 'call_initiate',
    WHATSAPP_ANSWER_RECEIVED: 'whatsapp_answer_received',
    CALL_TERMINATED: 'call_terminated',
    CALL_REJECTED: 'call_rejected',
    CALL_TRANSFERRED: 'call_transferred'
};

/**
 * Check if an event type is valid
 */
export function isValidEventType(eventType) {
    return Object.values(EventTypes).includes(eventType);
}
