// src/media/webrtc/SDPCoordinator.js
// SDP offer/answer creation and processing for all connection types.
// Singleton — import `sdpCoordinator` directly instead of going through CallManager.
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import { redisPubSubService } from '../../infra/redis/RedisPubSubService.js';
import { audioCoordinator } from '../bridge/AudioCoordinator.js';
import { iceCoordinator } from './ice/ICECandidateCoordinator.js';
import { peerRegistry } from './PeerRegistry.js';
import { sdpProcessor } from './SDPProcessor.js';
import { ConnectionType } from '../../core/constants/CallConstants.js';

class SDPCoordinator {

    /**
     * @param {Function|null} callEventHandler - Redis event callback (CallManager.handleCallEvent).
     *   Pass when this is an AGENT offer that needs Redis subscription (inbound call, transfer).
     *   Omit for CUSTOMER offers.
     * @param {object} [options.sdpProfile] - the channel adapter's SDP rewrites; CUSTOMER leg only.
     */
    async createSDPOffer(callId, connectionType, callEventHandler = null, { sdpProfile = null } = {}) {
        console.log(`Creating ${connectionType} SDP offer for call ${callId}`);

        if (connectionType === ConnectionType.AGENT) {
            iceCoordinator.resetOutbound(callId);
        }

        const { pc, connectionData } = peerRegistry.getOrCreateConnection(callId, connectionType);

        try {
            await peerRegistry.prepareConnection(callId, connectionType, connectionData);

            if (connectionType === ConnectionType.AGENT && callEventHandler) {
                const subscribed = await redisPubSubService.subscribeToCallEvents(callId, callEventHandler);
                if (subscribed) console.log(`[SDPCoordinator] 🔔 Subscribed to events for call ${callId}`);
            }

            await iceCoordinator.flushPreConnectionCandidates(pc, callId, connectionType);
            await audioCoordinator.addPlaceholderTrack(pc, connectionData);

            const sdp = await sdpProcessor.createOffer(pc, connectionType, sdpProfile);
            await CallConnectionRepository.updateSDP(callId, connectionType, sdp, null, 'OFFER');
            connectionData.setSdp({ type: 'OFFER', local: sdp });

            console.log(`${connectionType} SDP offer ready for call ${callId}`);
            return sdp;
        } catch (err) {
            console.error(`Failed to create ${connectionType} offer: ${err.message}`);
            await peerRegistry.closePeerConnection(callId, connectionType);
            throw err;
        }
    }

    async createSDPAnswer(callId, sdpOffer, connectionType, { sdpProfile = null } = {}) {
        console.log(`Creating ${connectionType} SDP answer for call ${callId}`);

        if (connectionType === ConnectionType.MONITOR) {
            const existingConnection = await CallConnectionRepository.findByCallAndType(callId, ConnectionType.MONITOR);
            if (existingConnection) {
                console.log(`[MONITOR FIX] Closing existing MONITOR for call ${callId} before creating new one`);
                await peerRegistry.closePeerConnection(callId, ConnectionType.MONITOR);
            }
        }

        const { pc, connectionData } = peerRegistry.getOrCreateConnection(callId, connectionType);

        try {
            await peerRegistry.prepareConnection(callId, connectionType, connectionData);
            await iceCoordinator.flushPreConnectionCandidates(pc, callId, connectionType);

            if (connectionType === ConnectionType.CUSTOMER) {
                await peerRegistry.extractAndStoreCandidates(sdpOffer, callId, connectionType);
            }

            // MONITOR connections must be silent — the monitor hears only the real
            // agent/customer tracks once the bridge relays them. The reconnecting tone
            // would otherwise bleed into the monitor's ears between connection and relay.
            const placeholderType = connectionType === ConnectionType.MONITOR ? 'silence' : 'reconnecting';
            await audioCoordinator.addPlaceholderTrack(pc, connectionData, placeholderType);

            if (connectionType === ConnectionType.MONITOR) {
                await audioCoordinator.addPlaceholderTrack(pc, connectionData, 'silence');
            }

            const sdp = await sdpProcessor.createAnswer(pc, sdpOffer, connectionType, sdpProfile);
            await CallConnectionRepository.updateSDP(callId, connectionType, sdp, sdpOffer, 'ANSWER');
            connectionData.setSdp({ type: 'ANSWER', local: sdp, remote: sdpOffer });

            await iceCoordinator.flushPostConnectionCandidates(pc, callId, connectionType);

            console.log(`${connectionType} SDP answer created for call ${callId}`);
            return sdp;
        } catch (err) {
            console.error(`Failed to create ${connectionType} answer: ${err.message}`);
            await peerRegistry.closePeerConnection(callId, connectionType);
            throw err;
        }
    }

    async processSDPAnswer(callId, sdpAnswer, connectionType, { sdpProfile = null } = {}) {
        const result = peerRegistry.getConnectionData(callId, connectionType);
        if (!result.valid) throw new Error(`${connectionType} connection invalid: ${result.reason}`);

        const connectionData = result.data;
        const pc = connectionData.pc;

        // Guard: if the peer connection is already stable, the answer was already
        // processed (e.g. duplicate AGENT_JOINED event). Skip silently instead of
        // crashing with "Called in wrong state: kStable".
        if (pc.signalingState === 'stable') {
            console.log(`[SDPCoordinator] ${connectionType} answer for call ${callId} skipped — connection already stable`);
            return;
        }

        try {
            if (connectionType === ConnectionType.CUSTOMER) {
                await peerRegistry.extractAndStoreCandidates(sdpAnswer, callId, connectionType);
            }

            const processedSdp = await sdpProcessor.processAnswer(pc, sdpAnswer, connectionType, sdpProfile);
            await CallConnectionRepository.updateSDP(callId, connectionType, null, processedSdp);
            connectionData.setSdp({ remote: processedSdp });

            await iceCoordinator.flushPostConnectionCandidates(pc, callId, connectionType);

            if (connectionType !== ConnectionType.CUSTOMER) {
                iceCoordinator.markClientReady(callId);
            }
        } catch (err) {
            console.error(`Failed to process ${connectionType} SDP answer: ${err.message}`);
            await peerRegistry.closePeerConnection(callId, connectionType);
            throw err;
        }
    }
}

export const sdpCoordinator = new SDPCoordinator();
