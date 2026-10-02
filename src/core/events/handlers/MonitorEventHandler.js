// src/core/events/handlers/MonitorEventHandler.js
import CallRepository from '../../../persistence/CallRepository.js';
import TenantRepository from '../../../persistence/TenantRepository.js';
import { agentConnections } from '../../agents/AgentConnections.js';
import EventBus from '../../EventBus.js';
import { callMedia } from '../../media/CallMedia.js';
import { mediaLegs } from '../../media/MediaLegs.js';
import { CallErrorCodes } from '../CallErrorCodes.js';
import { emitCallError } from '../CallErrorEmitter.js';
import { ConnectionType, ParticipantKind, LeaveReason } from '../../constants/CallConstants.js';
import { callParticipants } from '../../calls/CallParticipants.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.MonitorEventHandler');

export class MonitorEventHandler {

    async handleMonitorStarted(data) {
        const { callId, userId, tenantId, sdpOffer, socketId } = data;

        try {
            const call = await CallRepository.getInProgressCall(tenantId, callId);
            if (!call) throw new Error('Call not found or already ended');

            // The tenant's allowed modes (settings.monitoring.modes): monitoring
            // starts in listen, so without it nobody monitors.
            if (!(await TenantRepository.getMonitoringModes(tenantId)).includes('listen')) {
                await agentConnections.detachSocketFromCall(socketId, callId).catch(() => { });
                emitCallError({ callId, code: CallErrorCodes.MONITOR_MODE_NOT_ALLOWED, message: 'This tenant does not allow monitoring calls', socketId });
                return;
            }

            if (callMedia.hasSupervisor(callId)) {
                throw new Error('Another supervisor is monitoring this call right now.');
            }

            // Without an offer, Callio offers and the supervisor answers
            // (call:monitor:answer → handleMonitorAnswered) — how a DIRECT call
            // is listened to.
            if (!sdpOffer) {
                const offer = await mediaLegs.offerSupervisor(call, userId);
                EventBus.emit('call:monitor:offer', { callId, sdpOffer: offer, socketId });
                return;
            }

            const sdpAnswer = await mediaLegs.addSupervisor(call, userId, sdpOffer);

            await callParticipants.join(call, { kind: ParticipantKind.SUPERVISOR, agentId: userId });
            log.info({ callId }, 'Monitoring session created');

            EventBus.emit('call:monitor:started', { callId, sdpAnswer, socketId });

        } catch (error) {
            log.error({ err: error }, 'Start failed');

            const isValidationError =
                error.message === 'Call not found or already ended' ||
                error.message === 'Another supervisor is monitoring this call right now.';

            if (!isValidationError) {
                await mediaLegs.removeSupervisor(callId, userId).catch(() => { });
            }

            await agentConnections.detachSocketFromCall(socketId, callId).catch(() => { });

            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }

    // The supervisor's answer to Callio's monitor offer.
    async handleMonitorAnswered({ callId, userId, tenantId, sdpAnswer, socketId }) {
        try {
            const call = await CallRepository.getInProgressCall(tenantId, callId);
            if (!call) throw new Error('Call not found or already ended');
            await mediaLegs.supervisorAnswered(call, userId, sdpAnswer);
            await callParticipants.join(call, { kind: ParticipantKind.SUPERVISOR, agentId: userId });
            log.info({ callId }, 'Monitoring session created');
            EventBus.emit('call:monitor:started', { callId, socketId });
        } catch (error) {
            log.error({ err: error }, 'Monitor answer failed');
            await mediaLegs.removeSupervisor(callId, userId).catch(() => { });
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
            const call = await CallRepository.findById(callId);
            if (call && !(await TenantRepository.getMonitoringModes(call.tenant_id)).includes(mode)) {
                emitCallError({ callId, code: CallErrorCodes.MONITOR_MODE_NOT_ALLOWED, message: `This tenant does not allow '${mode}'`, socketId });
                return;
            }
            const endedPrivate = await callMedia.setSupervisorMode(callId, mode);
            // Confirm to the supervisor, and reflect the mode to the agent so their
            // active-call UI can show "supervisor is whispering" / "joined the call".
            EventBus.emit('call:monitor:mode:changed', { callId, mode, socketId });
            // Leaving whisper ends the agent's private reply: tell the call room.
            if (endedPrivate) EventBus.emit('call:agent:private:changed', { callId, active: false });
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
            const now = await callMedia.setAgentPrivate(callId, !!active);
            // Broadcast the state the bridge is actually in, so the agent's UI
            // and the supervisor's indicator never show a mute that didn't happen.
            EventBus.emit('call:agent:private:changed', { callId, active: now, socketId });
            if (!!active && !now) {
                emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED,
                    message: 'A private reply only works while a supervisor is whispering to you', socketId });
                return;
            }
            log.info({ callId }, `Agent-private set to ${now}`);
        } catch (error) {
            log.error({ err: error }, 'Agent-private change failed');
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }

    async handleMonitorStopped(data) {
        const { callId, userId, socketId } = data;

        try {
            log.info({ callId, agentId: userId }, 'Stopping monitoring');

            // Closing the monitor leg ends a private reply; the agent must hear of it.
            const wasPrivate = await mediaLegs.removeSupervisor(callId, userId);
            await callParticipants.leave(callId, { kind: ParticipantKind.SUPERVISOR, agentId: userId, reason: LeaveReason.MONITOR_STOPPED });
            if (wasPrivate) EventBus.emit('call:agent:private:changed', { callId, active: false });

            await agentConnections.detachSocketFromCall(socketId, callId).catch(() => { });

            EventBus.emit('call:monitor:ended', { callId, userId, socketId });

        } catch (error) {
            log.error({ err: error }, 'Stop failed');
            emitCallError({ callId, code: CallErrorCodes.MONITOR_FAILED, message: error.message, socketId });
        }
    }
}
