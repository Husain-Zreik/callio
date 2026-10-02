// src/core/events/handlers/ConnectionEventHandler.js
import CallRepository from '../../../persistence/CallRepository.js';
import { callLifecycleLogger } from '../../calls/CallLifecycleLogger.js';
import { callTerminator } from '../../calls/CallTerminator.js';
import { callMedia } from '../../media/CallMedia.js';
import { TerminationReason, TerminatedBy } from '../../constants/CallConstants.js';
import { deadlines } from '../../../infra/cluster/Deadlines.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.ConnectionEventHandler');

// How long (ms) to wait for agent reconnect before terminating the call. A
// stored deadline (infra/cluster/Deadlines.js): it holds even if the worker
// that saw the disconnect dies, and expires on whichever worker claims it.
const RECONNECT_TIMEOUT_MS = 120_000;
const RECONNECT = 'agent-reconnect';

export class ConnectionEventHandler {
    constructor() {
        deadlines.on(RECONNECT, (callId) => this._reconnectExpired(callId));
    }

    async clearReconnectTimer(callId) {
        await deadlines.clear(RECONNECT, callId).catch((err) => log.warn({ callId, err }, 'Clearing the reconnect deadline failed'));
    }

    async _reconnectExpired(callId) {
        log.warn({ callId }, `Agent did not reconnect within ${RECONNECT_TIMEOUT_MS / 1000}s — terminating`);
        // The agent is gone (browser closed, network died): end the call, tell
        // the provider so the customer isn't left on a dead line, and release
        // the agent OFFLINE — AVAILABLE would put an absent agent back into
        // routing. A no-op if the call already ended meanwhile.
        const call = await CallRepository.findById(callId);
        if (!call) return;
        await callTerminator.end(call, {
            reason: TerminationReason.AGENT_DISCONNECTED,
            terminatedBy: TerminatedBy.SYSTEM,
            provider: 'terminate',
            source: 'agent_disconnect_timeout',
            agentAfter: 'offline',
        });
    }

    async handleFrontendDisconnected(data) {
        const { callId, userId } = data;

        // Defense in depth alongside RoomManager.removeUserFromCallRoom now
        // actively clearing socket.callId on transfer: that clear depends on
        // fetchSockets()/serverSideEmit succeeding (a Redis round-trip), so
        // there's still a residual window (adapter hiccup, or any other path
        // that leaves a stale binding) where this event can arrive for a
        // user who is no longer this call's assigned agent. Trust a fresh DB
        // read over the event's own claimed state — mirrors
        // RejectionEventHandler.handleCallRejected's own stale-event guard.
        // Without this, a stale FRONTEND_DISCONNECTED injects a "reconnecting"
        // beep into the live customer audio and starts a 120s countdown to
        // wrongfully terminating a healthy call and releasing the wrong agent.
        if (userId) {
            const call = await CallRepository.findById(callId);
            if (!call || String(call.agent_id) !== String(userId)) {
                log.debug({ callId, agentId: userId }, 'Ignoring stale FRONTEND_DISCONNECTED — user is not the current assigned agent');
                return;
            }
        }

        log.info({ callId }, 'Frontend disconnected');

        callLifecycleLogger.logDisconnected(callId, data.tenantId, userId ?? null, {
            reason: data.reason ?? 'disconnect',
        }).catch(() => {});

        // The agent's leg goes; the customer hears the reconnect tone until
        // they're back (a reconnect brings a new leg).
        try {
            await callMedia.dropAgent(callId, userId ?? null);
        } catch (error) {
            log.error({ callId, err: error }, 'Dropping the agent leg failed');
        }

        await deadlines.set(RECONNECT, callId, RECONNECT_TIMEOUT_MS);
    }

    // A client's trickled ICE candidate. rtpengine learns the client's address
    // from the client's own connectivity checks, so trickled candidates aren't
    // needed for the leg to connect.
    async handleICECandidate(data) {
        log.trace({ callId: data.callId }, `ICE candidate for ${data.connectionType} (not needed)`);
    }
}
