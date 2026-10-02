// src/realtime/namespaces/call/socketHandlers.js
// Agent gateway — client → server call events (docs/agent-protocol.md).
// Handlers check payload shape, authorize the socket for the call (identity
// always from the verified token, never the payload), then hand off to the
// core via Redis to the worker that owns the call's media.
import { callInbox } from "../../../infra/cluster/CallInbox.js";
import { callQueryService } from "../../../core/calls/CallQueryService.js";
import { callEventHandler } from "../../../core/events/CallEventHandler.js";
import { callAccess } from "../../../core/calls/CallAccess.js";
import { roomManager } from "../../managers/RoomManager.js";
import { board, BoardError, Tier } from "../../managers/Board.js";
import { agentAssignmentCoordinator } from "../../../core/routing/AgentAssignmentCoordinator.js";
import { EventTypes } from "../../../core/events/EventTypes.js";
import { CallErrorCodes } from "../../../core/events/CallErrorCodes.js";
import { emitCallError } from "../../../core/events/CallErrorEmitter.js";
import { AgentRole } from "../../../core/constants/CallConstants.js";
import { logger } from '../../../infra/logging/logger.js';

const log = logger('realtime.socketHandlers');

export default function registerCallSocketListeners(socket) {
    const identity = () => ({
        agentId: socket.user?.id,
        tenantId: socket.tenant?.id,
        role: socket.user?.role,
    });
    const isSupervisor = () => socket.user?.role === AgentRole.SUPERVISOR;
    // Events that only make sense once this socket is bound to the call.
    const boundTo = (callId) => callId != null && String(socket.callId) === String(callId);

    // ── Queries ───────────────────────────────────────────────────────────────

    const syncCalls = async () => {
        try {
            const tenantId = socket.tenant?.id ?? null;
            if (!tenantId) {
                emitCallError({ callId: null, code: CallErrorCodes.MISSING_TENANT_CONTEXT, message: 'Tenant context not found', socket });
                return;
            }
            // Supervisors see every call (including IVR-active ones); agents only
            // their own.
            const agentId = isSupervisor() ? null : socket.user?.id;
            const ongoing = await callQueryService.getOngoingCalls(tenantId, agentId);
            socket.emit('calls:list', { ongoing });

            if (board.canSee(socket)) {
                for (const snapshot of await agentAssignmentCoordinator.getQueueSnapshots(tenantId)) {
                    socket.emit('call:agent_queue', snapshot);
                }
            }
        } catch (error) {
            log.error({ err: error }, 'Fetch ongoing calls error');
            emitCallError({ callId: null, code: CallErrorCodes.FAILED_FETCH_ACTIVE, message: 'Failed to fetch ongoing calls', socket });
        }
    };
    socket.on('calls:sync', syncCalls);
    socket.on('call:ongoing', syncCalls);

    // ── The board (managers/Board.js) ─────────────────────────────────────────

    // Replies through the ack when the client passed one, else as an event.
    const reply = (ack, event, data) => (typeof ack === 'function' ? ack(data) : socket.emit(event, data));
    const boardFailed = (ack, err) => {
        if (!(err instanceof BoardError)) log.error({ err }, 'Board request failed');
        const message = err instanceof BoardError ? err.message : 'Board request failed';
        emitCallError({ callId: null, code: CallErrorCodes.BOARD_REQUEST_FAILED, message, socket });
        if (typeof ack === 'function') ack({ error: { code: CallErrorCodes.BOARD_REQUEST_FAILED, message } });
    };

    // { channelIds?, queueIds?, agentIds? } — narrows this socket's board to
    // what they match (any of them); {} or null = the whole tenant.
    socket.on('board:subscribe', async (filter, ack) => {
        try {
            const applied = await board.subscribe(socket, filter ?? null);
            reply(ack, 'board:subscribed', { filter: applied });
        } catch (err) { boardFailed(ack, err); }
    });

    socket.on('board:unsubscribe', (_data, ack) => {
        board.unsubscribe(socket);
        reply(ack, 'board:unsubscribed', {});
    });

    // A page of the live calls: { channelIds?, queueIds?, agentIds?, cursor?, limit? }.
    socket.on('board:calls', async (query, ack) => {
        try {
            if (!board.canSee(socket)) throw new BoardError('The board is not available to this agent');
            const q = query ?? {};
            const page = await callQueryService.getBoardPage(socket.tenant.id, {
                channelIds: (q.channelIds ?? []).map(Number), queueIds: (q.queueIds ?? []).map(Number), agentIds: (q.agentIds ?? []).map(Number),
                cursor: q.cursor != null ? Number(q.cursor) : null, limit: q.limit,
            });
            reply(ack, 'board:calls', page);
        } catch (err) { boardFailed(ack, err); }
    });

    socket.on('board:counters', async (_data, ack) => {
        try {
            if (!board.canSee(socket, Tier.SUPERVISOR)) throw new BoardError('Counters are for supervisors');
            reply(ack, 'board:counters', await board.counters(socket.tenant.id));
        } catch (err) { boardFailed(ack, err); }
    });

    socket.on('call:agent-queue:sync', async () => {
        try {
            const tenantId = socket.tenant?.id ?? null;
            if (!tenantId || !board.canSee(socket)) return;
            for (const snapshot of await agentAssignmentCoordinator.getQueueSnapshots(tenantId)) {
                socket.emit('call:agent_queue', snapshot);
            }
        } catch (error) {
            log.error({ err: error }, 'Fetch agent queue error');
            emitCallError({ callId: null, code: CallErrorCodes.AGENT_QUEUE_SYNC_FAILED, message: 'Failed to sync agent queue', socket });
        }
    });

    socket.on('call:agent-availability:sync', async (data) => {
        try {
            const tenantId = socket.tenant?.id ?? null;
            if (!tenantId) return;
            await agentAssignmentCoordinator.syncAgentAvailability(tenantId, socket.user?.id, data?.userId ?? socket.user?.id);
        } catch (error) {
            log.error({ err: error }, 'Agent availability sync error');
            emitCallError({ callId: null, code: CallErrorCodes.AGENT_AVAILABILITY_SYNC_FAILED, message: 'Failed to sync agent availability', socket });
        }
    });

    // { availability: 'AVAILABLE'|'OFFLINE', agentId? } — agentId only for a
    // supervisor setting someone else.
    socket.on('agent:availability:set', async (data) => {
        try {
            const tenantId = socket.tenant?.id ?? null;
            if (!tenantId || !data?.availability) return;
            const target = data.agentId ?? socket.user?.id;
            const result = await agentAssignmentCoordinator.setAvailability(
                tenantId, socket.user?.id, target, String(data.availability).toUpperCase()
            );
            if (!result) {
                emitCallError({ callId: null, code: CallErrorCodes.AGENT_AVAILABILITY_SYNC_FAILED, message: 'Availability change not allowed', socket });
            }
        } catch (error) {
            log.error({ err: error }, 'Set availability error');
            emitCallError({ callId: null, code: CallErrorCodes.AGENT_AVAILABILITY_SYNC_FAILED, message: 'Failed to set availability', socket });
        }
    });

    // ── Outbound: start a call the consumer created via the Management API ───

    socket.on('call:start', async (data) => {
        const { callId, sdpOffer } = data || {};
        try {
            if (!callId || !sdpOffer) {
                emitCallError({ callId: callId ?? null, code: CallErrorCodes.CALL_INITIATION_FAILED, message: 'Missing required fields: callId, sdpOffer', socket });
                return;
            }

            const callData = await callEventHandler.startCall({
                callId,
                sdpOffer,
                userId: socket.user?.id,
                tenantId: socket.tenant?.id,
                socketId: socket.id,
                deviceId: socket.user?.deviceId ?? null,
            });

            socket.callId = callData.callId;
            roomManager.joinCallRoom(socket, callData.callId);

            // Dial the customer via the standard Redis → CallEventHandler pipeline.
            await callInbox.post(callData.callId, EventTypes.CALL_INITIATE, { callId: callData.callId });

            // The SDP answer goes to this socket only.
            socket.emit('call:started', callData);
            board.callEvent(Tier.SUPERVISOR, callData.callId, 'call:initiated', { ...callData, sdpOffer: undefined, sdpAnswer: undefined }, { callRoom: false });
        } catch (error) {
            log.error({ err: error }, 'Call start error');
            emitCallError({ callId: callId ?? null, code: CallErrorCodes.CALL_INITIATION_FAILED, message: error.message || 'Failed to start call', socket });
        }
    });

    // ── Inbound call actions ─────────────────────────────────────────────────

    socket.on('call:accept', async (data) => {
        const { callId, sdpAnswer } = data || {};
        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.ACCEPT_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!sdpAnswer) {
                emitCallError({ callId, code: CallErrorCodes.ACCEPT_FAILED, message: 'Missing SDP answer', socket });
                return;
            }
            if (!await callAccess.asAgent(callId, identity())) {
                emitCallError({ callId, code: CallErrorCodes.ACCEPT_FAILED, message: 'This call is not offered to you', socket });
                return;
            }

            socket.callId = callId;
            roomManager.joinCallRoom(socket, callId);

            await callInbox.post(callId, EventTypes.AGENT_JOINED, {
                callId,
                userId: socket.user?.id,
                tenantId: socket.tenant?.id,
                sdpAnswer,
                socketId: socket.id,
                deviceId: socket.user?.deviceId ?? null,
            });
        } catch (error) {
            log.error({ err: error }, 'Accept call error');
            roomManager.leaveCallRoom(socket, callId);
            emitCallError({ callId, code: CallErrorCodes.ACCEPT_FAILED, message: error?.message || 'Failed to accept call', socket });
        }
    });

    socket.on('call:reject', async (data) => {
        const callId = data?.callId;
        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.REJECT_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!await callAccess.asAgent(callId, identity())) {
                emitCallError({ callId, code: CallErrorCodes.REJECT_FAILED, message: 'This call is not offered to you', socket });
                return;
            }

            await callInbox.post(callId, EventTypes.CALL_REJECTED, {
                callId,
                userId: socket.user?.id,
                tenantId: socket.tenant?.id,
                socketId: socket.id,
                deviceId: socket.user?.deviceId ?? null,
            });
            roomManager.leaveCallRoom(socket, callId);
        } catch (error) {
            log.error({ err: error }, 'Reject call error');
            emitCallError({ callId, code: CallErrorCodes.REJECT_FAILED, message: 'Failed to reject call', socket });
        }
    });

    // Hang up (reason 'system_failed' when the client gave up reconnecting), or
    // cancel an outbound call before it's answered.
    const endCall = (errorCode, defaultReason) => async (data) => {
        const callId = data?.callId;
        try {
            if (!callId) {
                emitCallError({ callId: null, code: errorCode, message: 'Missing callId', socket });
                return;
            }
            const allowed = await callAccess.asAgent(callId, identity())
                ?? await callAccess.asSupervisor(callId, identity());
            if (!allowed) {
                emitCallError({ callId, code: errorCode, message: 'You are not on this call', socket });
                return;
            }

            await callInbox.post(callId, EventTypes.CALL_TERMINATED, {
                callId,
                userId: socket.user?.id,
                tenantId: socket.tenant?.id,
                socketId: socket.id,
                // The only reason a client may give: it gave up reconnecting its
                // media. Anything else would let a client pick the call's outcome.
                reason: defaultReason ?? (data?.reason === 'system_failed' ? 'system_failed' : null),
            });
            roomManager.leaveCallRoom(socket, callId);
        } catch (error) {
            log.error({ err: error }, 'End call error');
            emitCallError({ callId, code: errorCode, message: 'Failed to end call', socket });
        }
    };
    socket.on('call:terminate', endCall(CallErrorCodes.TERMINATE_FAILED, null));
    socket.on('call:cancel', endCall(CallErrorCodes.CANCEL_FAILED, 'cancelled'));

    socket.on('call:reconnect', async (data) => {
        const { callId, sdpOffer, reconnectTrigger } = data || {};
        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.RECONNECT_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!sdpOffer) {
                emitCallError({ callId, code: CallErrorCodes.RECONNECT_FAILED, message: 'Missing SDP offer', socket });
                return;
            }
            if (!await callAccess.asAgent(callId, identity())) {
                emitCallError({ callId, code: CallErrorCodes.RECONNECT_FAILED, message: 'You are not on this call', socket });
                return;
            }

            socket.callId = callId;
            roomManager.joinCallRoom(socket, callId);

            await callInbox.post(callId, EventTypes.AGENT_RECONNECTED, {
                callId,
                userId: socket.user?.id,
                tenantId: socket.tenant?.id,
                sdpOffer,
                socketId: socket.id,
                deviceId: socket.user?.deviceId ?? null,
                reconnectTrigger: reconnectTrigger ?? null,
            });
        } catch (error) {
            log.error({ err: error }, 'Reconnect call error');
            emitCallError({ callId, code: CallErrorCodes.RECONNECT_FAILED, message: 'Failed to reconnect call', socket });
        }
    });

    // { callId, agentId } or { callId, queueId }
    socket.on('call:transfer', async (data) => {
        const { callId, agentId, queueId } = data || {};
        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.CALL_TRANSFER_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!agentId && !queueId) {
                emitCallError({ callId, code: CallErrorCodes.CALL_TRANSFER_FAILED, message: 'Missing transfer target (agentId or queueId)', socket });
                return;
            }
            if (!await callAccess.canTransfer(callId, identity())) {
                emitCallError({ callId, code: CallErrorCodes.CALL_TRANSFER_FAILED, message: 'You may not transfer this call', socket });
                return;
            }

            await callInbox.post(callId, EventTypes.CALL_TRANSFERRED, {
                callId,
                newAgentId: agentId ?? null,
                targetType: queueId ? 'queue' : 'agent',
                targetQueueId: queueId ?? null,
                tenantId: socket.tenant?.id,
                socketId: socket.id,
                assignorId: socket.user?.id,
            });
        } catch (error) {
            log.error({ err: error }, 'Call transfer error');
            emitCallError({ callId, code: CallErrorCodes.CALL_TRANSFER_FAILED, message: error.message || 'Failed to transfer the call', socket });
        }
    });

    // ── ICE / Monitor ─────────────────────────────────────────────────────────

    socket.on('connection:ice-candidate', async (data) => {
        const { callId, candidate, connectionType } = data || {};
        if (!callId || !candidate || !boundTo(callId)) return;
        try {
            await callInbox.post(callId, EventTypes.ICE_CANDIDATE, {
                callId,
                candidate,
                connectionType,
                socketId: socket.id,
            });
        } catch (error) {
            log.error({ err: error }, 'ICE candidate error');
        }
    });

    socket.on('call:monitor', async (data) => {
        const { callId, sdpOffer } = data || {};
        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.MONITOR_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!sdpOffer) {
                emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: 'Missing SDP offer', socket });
                return;
            }
            if (!await callAccess.asSupervisor(callId, identity())) {
                emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: 'Only supervisors can monitor calls', socket });
                return;
            }

            socket.callId = callId;
            socket.isMonitoring = true;
            roomManager.joinCallRoom(socket, callId);

            await callInbox.post(callId, EventTypes.MONITOR_STARTED, {
                callId,
                userId: socket.user?.id,
                tenantId: socket.tenant?.id,
                sdpOffer,
                socketId: socket.id,
            });
        } catch (error) {
            log.error({ err: error }, 'Monitor call error');
            roomManager.leaveCallRoom(socket, callId);
            socket.isMonitoring = false;
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socket });
        }
    });

    socket.on('call:monitor:mode', async (data) => {
        const { callId, mode } = data || {};
        try {
            if (!callId || !mode) {
                emitCallError({ callId: callId ?? null, code: CallErrorCodes.MONITOR_FAILED, message: 'Missing callId or mode', socket });
                return;
            }
            if (!socket.isMonitoring || !boundTo(callId)) {
                emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: 'You are not monitoring this call', socket });
                return;
            }
            await callInbox.post(callId, EventTypes.MONITOR_MODE_CHANGED, {
                callId,
                mode,
                socketId: socket.id,
            });
        } catch (error) {
            log.error({ err: error }, 'Monitor mode change error');
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socket });
        }
    });

    // The agent toggles "talk privately to the supervisor" (muted to the customer).
    socket.on('call:agent:private', async (data) => {
        const { callId, active } = data || {};
        try {
            if (!callId || !boundTo(callId) || socket.isMonitoring) {
                emitCallError({ callId: callId ?? null, code: CallErrorCodes.AGENT_PRIVATE_FAILED, message: 'You are not on this call', socket });
                return;
            }
            await callInbox.post(callId, EventTypes.AGENT_PRIVATE_CHANGED, {
                callId,
                active: !!active,
                socketId: socket.id,
            });
        } catch (error) {
            log.error({ err: error }, 'Agent private change error');
            emitCallError({ callId, code: CallErrorCodes.AGENT_PRIVATE_FAILED, message: error.message, socket });
        }
    });

    // Agent mic mute state — informational only, relayed to the call room so a
    // monitoring supervisor sees it.
    socket.on('call:agent:muted', (data) => {
        const { callId, muted } = data || {};
        if (!boundTo(callId) || socket.isMonitoring) return;
        roomManager.broadcastToCall(callId, 'call:agent:muted', { callId, muted: !!muted });
    });

    socket.on('call:monitor:stop', async (data) => {
        const callId = data?.callId;
        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.STOP_MONITOR_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!socket.isMonitoring || !boundTo(callId)) return;

            await callInbox.post(callId, EventTypes.MONITOR_STOPPED, {
                callId,
                userId: socket.user?.id,
                socketId: socket.id,
            });
            roomManager.leaveCallRoom(socket, callId);
            socket.isMonitoring = false;
        } catch (error) {
            log.error({ err: error }, 'Stop monitoring error');
            emitCallError({ callId, code: CallErrorCodes.STOP_MONITOR_FAILED, message: error.message, socket });
        }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────

    socket.on('disconnect', async (reason) => {
        if (!socket.callId) return;
        // This worker is shutting down and handing its calls over: the agent
        // didn't leave — their media stays up and their client reconnects to
        // another worker.
        if (reason === 'server shutting down') return;
        const userId = socket.user?.id;

        if (socket.isMonitoring) {
            log.info({ agentId: userId, callId: socket.callId }, 'Monitor disconnected from call');
            await callInbox.post(socket.callId, EventTypes.MONITOR_STOPPED, {
                callId: socket.callId,
                userId,
                reason: 'disconnect',
                socketId: socket.id,
            });
        } else {
            log.info({ agentId: userId, callId: socket.callId }, 'Agent disconnected from call');
            await callInbox.post(socket.callId, EventTypes.AGENT_DISCONNECTED, {
                callId: socket.callId,
                userId,
                tenantId: socket.tenant?.id,
                reason: 'disconnect',
                socketId: socket.id,
            });
        }
    });
}
