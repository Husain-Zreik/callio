// src/websocket/namespaces/call/socketHandlers.js
import { redisPubSubService } from "../../../services/redis/RedisPubSubService.js";
import { callQueryService } from "../../../services/call/query/CallQueryService.js";
import { callEventHandler } from "../../../services/call/events/CallEventHandler.js";
import { roomManager } from "../../managers/RoomManager.js";
import { callAgentAssignmentService } from "../../../services/redis/CallAgentAssignmentService.js";
import { agentAssignmentCoordinator } from "../../../services/call/assignment/AgentAssignmentCoordinator.js";
import { EventTypes } from "../../../services/call/events/EventTypes.js";
import { CallErrorCodes } from "../../../services/call/events/CallErrorCodes.js";
import { emitCallError } from "../../../services/call/events/CallErrorEmitter.js";

export default function registerCallSocketListeners(socket) {

    // ── Queries ───────────────────────────────────────────────────────────────

    socket.on('call:ongoing', async () => {
        try {
            const businessId = socket.business?.id ?? null;
            if (!businessId) {
                emitCallError({ callId: null, code: CallErrorCodes.MISSING_BUSINESS_CONTEXT, message: 'Business context not found', socket });
                return;
            }

            const userId = socket.user?.id ?? null;
            // Role was resolved at auth time and cached on the socket — no DB query here.
            // Managers see all calls (including IVR-active ones).
            // Agents only see calls assigned to them — they should never see
            // IVR calls with user_id=null, which caused spurious "reconnecting" UI.
            const userRole = socket.callCenterRole ?? 'system';
            const agentId = userRole === 'agent' ? userId : null;

            const ongoing = await callQueryService.getOngoingCalls(businessId, agentId);
            socket.emit('calls:list', { ongoing });

            const snapshot = await callAgentAssignmentService.getQueueSnapshotForBusiness(businessId);
            if (snapshot) socket.emit('call:agent_queue', snapshot);

        } catch (error) {
            console.error('[Socket] Fetch ongoing calls error:', error);
            emitCallError({ callId: null, code: CallErrorCodes.FAILED_FETCH_ACTIVE, message: 'Failed to fetch ongoing calls', socket });
        }
    });

    socket.on('call:agent-queue:sync', async (data) => {
        try {
            const businessId = socket.business?.id ?? null;
            if (!businessId) return;

            if (data?.broadcast) {
                await agentAssignmentCoordinator.emitQueueUpdate(businessId);
            } else {
                const snapshot = await callAgentAssignmentService.getQueueSnapshotForBusiness(businessId);
                if (snapshot) socket.emit('call:agent_queue', snapshot);
            }
        } catch (error) {
            console.error('[Socket] Fetch agent queue error:', error);
            emitCallError({ callId: null, code: CallErrorCodes.AGENT_QUEUE_SYNC_FAILED, message: 'Failed to sync agent queue', socket });
        }
    });

    socket.on('call:agent-availability:sync', async (data) => {
        try {
            const businessId = socket.business?.id ?? null;
            if (!businessId) return;

            const actorUserId = Number(socket.user?.id);
            const targetUserId = Number(data?.userId);

            await agentAssignmentCoordinator.syncAgentAvailability(businessId, actorUserId, targetUserId);
        } catch (error) {
            console.error('[Socket] Agent availability sync error:', error);
            emitCallError({ callId: null, code: CallErrorCodes.AGENT_AVAILABILITY_SYNC_FAILED, message: 'Failed to sync agent availability', socket });
        }
    });

    // ── Outbound call initiation ──────────────────────────────────────────────

    socket.on('call:initiate', async (data) => {
        try {
            const { calleeId, callerId, sdpOffer } = data;
            if (!calleeId || !callerId || !sdpOffer) {
                emitCallError({ callId: null, code: CallErrorCodes.CALL_INITIATION_FAILED, message: 'Missing required fields: calleeId, callerId, sdpOffer', socket });
                return;
            }

            const initiatePayload = {
                calleeId,
                callerId,
                sdpOffer,
                userId: socket.user?.id,
                businessId: socket.business?.id,
                socketId: socket.id,
                deviceId: socket.user?.deviceId ?? null,
            };

            console.log(`[Socket] Initiating call for business ${initiatePayload.businessId}`);

            const callData = await callEventHandler.initiateCall(initiatePayload);

            socket.callId = callData.callId;
            roomManager.joinCallRoom(socket, callData.callId);

            // Dispatch WhatsApp connection via the standard Redis → CallEventHandler pipeline.
            await redisPubSubService.publishCallEvent(callData.callId, EventTypes.CALL_INITIATE, { callId: callData.callId });

            // Broadcast immediately so the agent gets the sdpAnswer without waiting for Redis round-trip.
            roomManager.broadcastToBusiness(callData.businessId, 'call:initiated', callData);
        } catch (error) {
            console.error('[Socket] Call initiation error:', error);
            emitCallError({ callId: null, code: CallErrorCodes.CALL_INITIATION_FAILED, message: error.message || 'Failed to initiate call', socket });
        }
    });

    // ── Inbound call actions (publish to Redis → event handler) ──────────────

    socket.on('call:accept', async (data) => {
        const { callId, sdpAnswer } = data;

        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.ACCEPT_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!sdpAnswer) {
                emitCallError({ callId, code: CallErrorCodes.ACCEPT_FAILED, message: 'Missing SDP answer', socket });
                return;
            }

            socket.callId = callId;
            roomManager.joinCallRoom(socket, callId);

            await redisPubSubService.publishCallEvent(callId, EventTypes.AGENT_JOINED, {
                callId,
                userId: socket.user?.id,
                businessId: socket.business?.id,
                sdpAnswer,
                socketId: socket.id,
                deviceId: socket.user?.deviceId ?? null,
            });

        } catch (error) {
            console.error('[Socket] Accept call error:', error);
            roomManager.leaveCallRoom(socket, callId);
            emitCallError({ callId, code: CallErrorCodes.ACCEPT_FAILED, message: error?.message || 'Failed to accept call', socket });
        }
    });

    socket.on('call:reject', async (data) => {
        try {
            const { callId } = data;
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.REJECT_FAILED, message: 'Missing callId', socket });
                return;
            }

            await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_REJECTED, {
                callId,
                userId: socket.user?.id,
                businessId: socket.business?.id,
                socketId: socket.id,
                deviceId: socket.user?.deviceId ?? null,
            });

            roomManager.leaveCallRoom(socket, callId);

        } catch (error) {
            console.error('[Socket] Reject call error:', error);
            emitCallError({ callId: data?.callId, code: CallErrorCodes.REJECT_FAILED, message: 'Failed to reject call', socket });
        }
    });

    socket.on('call:terminate', async (data) => {
        try {
            const { callId, reason } = data;
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.TERMINATE_FAILED, message: 'Missing callId', socket });
                return;
            }

            await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TERMINATED, {
                callId,
                userId: socket.user?.id,
                businessId: socket.business?.id,
                socketId: socket.id,
                reason: reason ?? null,
            });

            roomManager.leaveCallRoom(socket, callId);
            if (reason !== 'system_failed') {
                socket.emit('call:success', { message: 'Call terminated successfully' });
            }

        } catch (error) {
            console.error('[Socket] Terminate call error:', error);
            emitCallError({ callId: data?.callId, code: CallErrorCodes.TERMINATE_FAILED, message: 'Failed to terminate call', socket });
        }
    });

    socket.on('call:cancel', async (data) => {
        try {
            const { callId } = data;
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.CANCEL_FAILED, message: 'Missing callId', socket });
                return;
            }

            await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TERMINATED, {
                callId,
                userId: socket.user?.id,
                businessId: socket.business?.id,
                reason: 'cancelled',
                socketId: socket.id,
            });

            roomManager.leaveCallRoom(socket, callId);
            socket.emit('call:success', { message: 'Call cancelled successfully' });

        } catch (error) {
            console.error('[Socket] Cancel call error:', error);
            emitCallError({ callId: data?.callId, code: CallErrorCodes.CANCEL_FAILED, message: 'Failed to cancel call', socket });
        }
    });

    socket.on('call:reconnect', async (data) => {
        try {
            const { callId, sdpOffer, reconnectTrigger } = data;

            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.RECONNECT_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!sdpOffer) {
                emitCallError({ callId, code: CallErrorCodes.RECONNECT_FAILED, message: 'Missing SDP offer', socket });
                return;
            }

            socket.callId = callId;
            roomManager.joinCallRoom(socket, callId);

            await redisPubSubService.publishCallEvent(callId, EventTypes.AGENT_RECONNECTED, {
                callId,
                userId: socket.user?.id,
                businessId: socket.business?.id,
                sdpOffer,
                socketId: socket.id,
                deviceId: socket.user?.deviceId ?? null,
                reconnectTrigger: reconnectTrigger ?? null,
            });

        } catch (error) {
            console.error('[Socket] Reconnect call error:', error);
            emitCallError({ callId: data?.callId, code: CallErrorCodes.RECONNECT_FAILED, message: 'Failed to reconnect call', socket });
        }
    });

    socket.on('call:transfer', async (data) => {
        try {
            const { callId, userId, userName, agentId, groupId } = data;
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.CALL_TRANSFER_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!agentId && !groupId) {
                emitCallError({ callId, code: CallErrorCodes.CALL_TRANSFER_FAILED, message: 'Missing transfer target (agent or group)', socket });
                return;
            }

            const targetType = groupId ? 'group' : 'agent';

            await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TRANSFERRED, {
                callId,
                oldAgentId: userId,
                oldAgentName: userName,
                newAgentId: agentId,
                targetType,
                targetGroupId: groupId || null,
                businessId: socket.business?.id,
                socketId: socket.id,
                assignorId: socket.user?.id,
                assignorName: socket.user?.name,
            });

        } catch (error) {
            console.error('[Socket] Call transfer error:', error);
            emitCallError({ callId: data?.callId, code: CallErrorCodes.CALL_TRANSFER_FAILED, message: error.message || 'Failed to transfer the call', socket });
        }
    });

    // ── ICE / Monitor ─────────────────────────────────────────────────────────

    socket.on('connection:ice-candidate', async (data) => {
        const { callId, candidate, connectionType } = data;
        if (!callId || !candidate) return;

        try {
            await redisPubSubService.publishCallEvent(callId, EventTypes.ICE_CANDIDATE, {
                callId,
                candidate,
                connectionType,
                socketId: socket.id,
            });
        } catch (error) {
            console.error('[Socket] ICE candidate error:', error);
        }
    });

    socket.on('call:monitor', async (data) => {
        const { callId, sdpOffer } = data;

        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.MONITOR_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!sdpOffer) {
                emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: 'Missing SDP offer', socket });
                return;
            }

            socket.callId = callId;
            socket.isMonitoring = true;
            roomManager.joinCallRoom(socket, callId);

            await redisPubSubService.publishCallEvent(callId, EventTypes.MONITOR_STARTED, {
                callId,
                userId: socket.user?.id,
                businessId: socket.business?.id,
                sdpOffer,
                socketId: socket.id,
            });

        } catch (error) {
            console.error('[Socket] Monitor call error:', error);
            roomManager.leaveCallRoom(socket, callId);
            socket.isMonitoring = false;
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socket });
        }
    });

    socket.on('call:monitor:mode', async (data) => {
        const { callId, mode } = data;

        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.MONITOR_FAILED, message: 'Missing callId', socket });
                return;
            }
            if (!mode) {
                emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: 'Missing mode', socket });
                return;
            }

            await redisPubSubService.publishCallEvent(callId, EventTypes.MONITOR_MODE_CHANGED, {
                callId,
                mode,
                socketId: socket.id,
            });

        } catch (error) {
            console.error('[Socket] Monitor mode change error:', error);
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socket });
        }
    });

    // Agent toggles "whisper back to supervisor" (mute self to customer, keep
    // talking to the supervisor). Routed to the call-owner worker via Redis.
    socket.on('call:agent:private', async (data) => {
        const { callId, active } = data;

        try {
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.AGENT_PRIVATE_FAILED, message: 'Missing callId', socket });
                return;
            }

            await redisPubSubService.publishCallEvent(callId, EventTypes.AGENT_PRIVATE_CHANGED, {
                callId,
                active: !!active,
                socketId: socket.id,
            });

        } catch (error) {
            console.error('[Socket] Agent private change error:', error);
            emitCallError({ callId, code: CallErrorCodes.AGENT_PRIVATE_FAILED, message: error.message, socket });
        }
    });

    // Agent mic mute state — purely informational (no audio routing), relayed to
    // the call room so any supervisor monitoring the call sees it. broadcastToCall
    // is cross-worker via the Socket.IO Redis adapter, so no owner-worker hop needed.
    socket.on('call:agent:muted', (data) => {
        const { callId, muted } = data || {};
        if (!callId) return;
        roomManager.broadcastToCall(callId, 'call:agent:muted', { callId, muted: !!muted });
    });

    socket.on('call:monitor:stop', async (data) => {
        try {
            const { callId } = data;
            if (!callId) {
                emitCallError({ callId: null, code: CallErrorCodes.STOP_MONITOR_FAILED, message: 'Missing callId', socket });
                return;
            }

            await redisPubSubService.publishCallEvent(callId, EventTypes.MONITOR_STOPPED, {
                callId,
                userId: socket.user?.id,
                socketId: socket.id,
            });

            roomManager.leaveCallRoom(socket, callId);
            socket.isMonitoring = false;

        } catch (error) {
            console.error('[Socket] Stop monitoring error:', error);
            emitCallError({ callId: data?.callId, code: CallErrorCodes.STOP_MONITOR_FAILED, message: error.message, socket });
        }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────

    socket.on('disconnect', async () => {
        if (!socket.callId) return;

        const userId = socket.user?.id;

        if (socket.isMonitoring) {
            console.log(`[Socket] Monitor ${userId} disconnected from call ${socket.callId}`);
            await redisPubSubService.publishCallEvent(socket.callId, EventTypes.MONITOR_STOPPED, {
                callId: socket.callId,
                userId,
                reason: 'disconnect',
                socketId: socket.id,
            });
        } else {
            console.log(`[Socket] User ${userId} disconnected from call ${socket.callId}`);
            await redisPubSubService.publishCallEvent(socket.callId, EventTypes.FRONTEND_DISCONNECTED, {
                callId: socket.callId,
                userId,
                businessId: socket.business?.id,
                reason: 'disconnect',
                socketId: socket.id,
            });
        }
    });
}
