// services/call/events/handlers/MonitorEventHandler.js
import CallRepository from '../../../../repositories/CallRepository.js';
import CallConnectionRepository from '../../../../repositories/CallConnectionRepository.js';
import { roomManager } from '../../../../websocket/managers/RoomManager.js';
import EventBus from '../../../core/EventBus.js';
import { peerRegistry } from '../../signaling/webrtc/PeerRegistry.js';
import { sdpCoordinator } from '../../signaling/webrtc/SDPCoordinator.js';
import { iceCoordinator } from '../../signaling/webrtc/ice/ICECandidateCoordinator.js';
import { audioCoordinator } from '../../audio/AudioCoordinator.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { emitCallError } from '../CallErrorEmitter.js';
import { ConnectionType } from '../../constants/CallConstants.js';

export class MonitorEventHandler {

    async handleMonitorStarted(data) {
        const { callId, userId, businessId, sdpOffer, socketId } = data;

        try {
            const call = await CallRepository.getInProgressCall(businessId, callId);
            if (!call) throw new Error('Call not found or already ended');

            if (peerRegistry.getConnectionData(callId, ConnectionType.MONITOR).valid) {
                throw new Error('Another Manager is monitoring the call right now.');
            }

            const callConnection = await CallConnectionRepository.findByCallAndType(callId, ConnectionType.MONITOR);
            if (callConnection) throw new Error('Another Manager is monitoring the call right now.');

            iceCoordinator.setConnectionInfo(callId, ConnectionType.MONITOR, socketId);
            const sdpAnswer = await sdpCoordinator.createSDPAnswer(callId, sdpOffer, ConnectionType.MONITOR);
            iceCoordinator.markClientReady(callId);

            console.log(`[MonitorEventHandler] Monitoring session created for call ${callId}`);

            EventBus.emit('call:monitor:started', { callId, sdpAnswer, socketId });

        } catch (error) {
            console.error(`[MonitorEventHandler] ❌ Start failed:`, error.message);

            const isValidationError =
                error.message === 'Call not found or already ended' ||
                error.message === 'Another Manager is monitoring the call right now.';

            if (!isValidationError) {
                await peerRegistry.closePeerConnection(callId, ConnectionType.MONITOR);
            }

            const socket = roomManager.io.sockets.sockets.get(socketId);
            if (socket) { roomManager.leaveCallRoom(socket, callId); socket.isMonitoring = false; }

            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }

    async handleMonitorModeChanged(data) {
        const { callId, mode, socketId } = data;

        const VALID_MODES = ['listen', 'whisper', 'barge'];
        if (!VALID_MODES.includes(mode)) {
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: `Invalid supervisor mode: ${mode}`, socketId });
            return;
        }

        try {
            audioCoordinator.setSupervisorMode(callId, mode);
            // Confirm to the supervisor, and reflect the mode to the agent so their
            // active-call UI can show "supervisor is whispering" / "joined the call".
            EventBus.emit('call:monitor:mode:changed', { callId, mode, socketId });
            console.log(`[MonitorEventHandler] Supervisor mode set to '${mode}' for call ${callId}`);
        } catch (error) {
            console.error(`[MonitorEventHandler] ❌ Mode change failed:`, error.message);
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }

    /**
     * Agent toggles "whisper back to supervisor": the agent's voice is muted to
     * the customer while still reaching the supervisor (the monitor connection
     * already carries the agent's audio). The bridge mutes the agent→customer path.
     */
    async handleAgentPrivateChanged(data) {
        const { callId, active, socketId } = data;

        try {
            audioCoordinator.setAgentPrivate(callId, !!active);
            // Broadcast to the call room so the agent's UI confirms and the
            // supervisor's UI can show that the agent is replying privately.
            EventBus.emit('call:agent:private:changed', { callId, active: !!active, socketId });
            console.log(`[MonitorEventHandler] Agent-private set to ${!!active} for call ${callId}`);
        } catch (error) {
            console.error(`[MonitorEventHandler] ❌ Agent-private change failed:`, error.message);
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }

    async handleMonitorStopped(data) {
        const { callId, userId, socketId } = data;

        try {
            console.log(`[MonitorEventHandler] Stopping monitoring for call ${callId} by ${userId}`);

            await peerRegistry.closePeerConnection(callId, ConnectionType.MONITOR);

            const socket = roomManager.io.sockets.sockets.get(socketId);
            if (socket) { roomManager.leaveCallRoom(socket, callId); socket.isMonitoring = false; }

            EventBus.emit('call:monitor:ended', { callId, userId, socketId });

        } catch (error) {
            console.error(`[MonitorEventHandler] ❌ Stop failed:`, error.message);
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }
}
