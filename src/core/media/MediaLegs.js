// src/core/media/MediaLegs.js
// The core's calls into the media port (CallMedia.js) that also keep a leg's
// record in call_connections: the SDP each side used (diagnostics, the call
// detail's `legs`), who is on it and from which device (a reloaded client is
// told "this device" or "your other one"), and the agent offer a ringing call
// is re-delivered with. One AGENT row per call: a new offer, a reconnect or
// a transfer replaces it.
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import { callMedia } from './CallMedia.js';
import { ConnectionType } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.media.MediaLegs');

const persist = (callId, what, fn) => fn().catch((err) => log.error({ callId, err }, `Recording the ${what} leg failed`));

class MediaLegs {
    // ── customer ──
    async answerCustomer(call, sdpOffer, profile) {
        const answer = await callMedia.answerCustomer(call, sdpOffer, profile);
        await persist(call.id, 'customer', () => CallConnectionRepository.updateSDP(call.id, ConnectionType.CUSTOMER, answer, sdpOffer, 'ANSWER'));
        return answer;
    }

    async offerCustomer(call, profile) {
        const offer = await callMedia.offerCustomer(call, profile);
        await persist(call.id, 'customer', async () => {
            await CallConnectionRepository.cleanupConnection(call.id, ConnectionType.CUSTOMER);
            await CallConnectionRepository.create({ call_id: call.id, connection_type: ConnectionType.CUSTOMER, local_sdp: offer, sdp_type: 'OFFER' });
        });
        return offer;
    }

    async customerAnswered(call, sdpAnswer, profile) {
        await callMedia.customerAnswered(call, sdpAnswer, profile);
        await persist(call.id, 'customer', async () => {
            await CallConnectionRepository.updateSDP(call.id, ConnectionType.CUSTOMER, null, sdpAnswer);
            await CallConnectionRepository.markReady(call.id, ConnectionType.CUSTOMER);
        });
    }

    // ── agents ──
    async offerAgent(call) {
        const offer = await callMedia.offerAgent(call);
        await persist(call.id, 'agent', async () => {
            await CallConnectionRepository.cleanupConnection(call.id, ConnectionType.AGENT);
            await CallConnectionRepository.create({ call_id: call.id, connection_type: ConnectionType.AGENT, local_sdp: offer, sdp_type: 'OFFER' });
        });
        return offer;
    }

    // The offer a ringing call was last given to agents, if any.
    async storedAgentOffer(callId) {
        return (await CallConnectionRepository.findByCallAndType(callId, ConnectionType.AGENT))?.local_sdp ?? null;
    }

    async agentAccepted(call, agentId, sdpAnswer, deviceId) {
        await callMedia.agentAccepted(call, agentId, sdpAnswer);
        await persist(call.id, 'agent', async () => {
            await CallConnectionRepository.updateSDP(call.id, ConnectionType.AGENT, null, sdpAnswer);
            await CallConnectionRepository.updateAgentId(call.id, ConnectionType.AGENT, agentId);
            await CallConnectionRepository.updateDeviceId(call.id, ConnectionType.AGENT, deviceId ?? null);
            await CallConnectionRepository.markReady(call.id, ConnectionType.AGENT);
        });
    }

    async answerAgent(call, agentId, sdpOffer, deviceId) {
        const answer = await callMedia.answerAgent(call, agentId, sdpOffer);
        await persist(call.id, 'agent', async () => {
            await CallConnectionRepository.cleanupConnection(call.id, ConnectionType.AGENT);
            await CallConnectionRepository.create({
                call_id: call.id, connection_type: ConnectionType.AGENT, agent_id: agentId,
                local_sdp: answer, remote_sdp: sdpOffer, sdp_type: 'ANSWER',
            });
            await CallConnectionRepository.updateDeviceId(call.id, ConnectionType.AGENT, deviceId ?? null);
            await CallConnectionRepository.markReady(call.id, ConnectionType.AGENT);
        });
        return answer;
    }

    // ── supervisors ──
    async addSupervisor(call, supervisorId, sdpOffer) {
        const answer = await callMedia.addSupervisor(call, supervisorId, sdpOffer);
        await persist(call.id, 'monitor', async () => {
            await CallConnectionRepository.cleanupConnection(call.id, ConnectionType.MONITOR);
            await CallConnectionRepository.create({
                call_id: call.id, connection_type: ConnectionType.MONITOR, agent_id: supervisorId,
                local_sdp: answer, remote_sdp: sdpOffer, sdp_type: 'ANSWER',
            });
            await CallConnectionRepository.markReady(call.id, ConnectionType.MONITOR);
        });
        return answer;
    }

    async removeSupervisor(callId, supervisorId) {
        const wasPrivate = await callMedia.removeSupervisor(callId, supervisorId);
        await persist(callId, 'monitor', () => CallConnectionRepository.cleanupConnection(callId, ConnectionType.MONITOR));
        return wasPrivate;
    }

    // ── end ──
    async close(callId) {
        await callMedia.close(callId);
        await persist(callId, 'closed', () => CallConnectionRepository.terminateConnections(callId));
    }
}

export const mediaLegs = new MediaLegs();
