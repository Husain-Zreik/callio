// src/core/events/handlers/MonitorEventHandler.js
import CallRepository from '../../../persistence/CallRepository.js';
import CallConnectionRepository from '../../../persistence/CallConnectionRepository.js';
import { agentConnections } from '../../agents/AgentConnections.js';
import EventBus from '../../EventBus.js';
import { peerRegistry } from '../../../media/webrtc/PeerRegistry.js';
import { sdpCoordinator } from '../../../media/webrtc/SDPCoordinator.js';
import { iceCoordinator } from '../../../media/webrtc/ice/ICECandidateCoordinator.js';
import { audioCoordinator } from '../../../media/bridge/AudioCoordinator.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { emitCallError } from '../CallErrorEmitter.js';
import { ConnectionType } from '../../constants/CallConstants.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.MonitorEventHandler');

export class MonitorEventHandler {

    async handleMonitorStarted(data) {
        const { callId, userId, tenantId, sdpOffer, socketId } = data;

        try {
            const call = await CallRepository.getInProgressCall(tenantId, callId);
            if (!call) throw new Error('Call not found or already ended');

            if (peerRegistry.getConnectionData(callId, ConnectionType.MONITOR).valid) {
                throw new Error('Another supervisor is monitoring this call right now.');
            }

            const callConnection = await CallConnectionRepository.findByCallAndType(callId, ConnectionType.MONITOR);
            if (callConnection) throw new Error('Another supervisor is monitoring this call right now.');

            iceCoordinator.setConnectionInfo(callId, ConnectionType.MONITOR, socketId);
            const sdpAnswer = await sdpCoordinator.createSDPAnswer(callId, sdpOffer, ConnectionType.MONITOR);
            iceCoordinator.markClientReady(callId);

            log.info({ callId }, 'Monitoring session created');

            EventBus.emit('call:monitor:started', { callId, sdpAnswer, socketId });

        } catch (error) {
            log.error({ err: error }, 'Start failed');

            const isValidationError =
                error.message === 'Call not found or already ended' ||
                error.message === 'Another supervisor is monitoring this call right now.';

            if (!isValidationError) {
                await peerRegistry.closePeerConnection(callId, ConnectionType.MONITOR);
            }

            await agentConnections.detachSocketFromCall(socketId, callId).catch(() => { });

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
            log.info({ callId }, `Supervisor mode set to '${mode}'`);
        } catch (error) {
            log.error({ err: error }, 'Mode change failed');
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
            log.info({ callId }, `Agent-private set to ${!!active}`);
        } catch (error) {
            log.error({ err: error }, 'Agent-private change failed');
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }

    async handleMonitorStopped(data) {
        const { callId, userId, socketId } = data;

        try {
            log.info({ callId, agentId: userId }, 'Stopping monitoring');

            await peerRegistry.closePeerConnection(callId, ConnectionType.MONITOR);

            await agentConnections.detachSocketFromCall(socketId, callId).catch(() => { });

            EventBus.emit('call:monitor:ended', { callId, userId, socketId });

        } catch (error) {
            log.error({ err: error }, 'Stop failed');
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }
}
