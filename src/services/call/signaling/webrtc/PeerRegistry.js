// services/call/signaling/webrtc/PeerRegistry.js
// Registry of all active WebRTC peer connections.
// Owns the peerConnections Map, all peer lifecycle operations,
// and the connectionReady/trackReceived event wiring from PeerEventManager.
// Singleton — import `peerRegistry` everywhere instead of going through CallManager.
import wrtc from '@roamhq/wrtc';
import CallConnectionRepository from '../../../../repositories/CallConnectionRepository.js';
import CallRepository from '../../../../repositories/CallRepository.js';
import { redisPubSubService } from '../../../redis/RedisPubSubService.js';
import { audioCoordinator } from '../../audio/AudioCoordinator.js';
import { iceCoordinator } from './ice/ICECandidateCoordinator.js';
import { peerEventManager } from './PeerEventManager.js';
import { emitCallError } from '../../events/CallErrorEmitter.js';
import { CallErrorCodes } from '../../events/CallErrorCodes.js';
import { Peer } from './Peer.js';
import { CallContext } from './CallContext.js';
import { PeerConfig } from './PeerConfig.js';
import { ConnectionType } from '../../constants/CallConstants.js';
import { ivrCoordinator } from '../../ivr/IvrCoordinator.js';

const { RTCPeerConnection } = wrtc;

class PeerRegistry {
    constructor() {
        // callId -> { FRONTEND?, WHATSAPP?, MONITOR?, context: CallContext }
        this.peerConnections = new Map();
        // callId -> { frontend?: Timeout, whatsapp?: Timeout }
        this._iceStallTimers = new Map();

        // Wire peer lifecycle events directly — no roundtrip through CallManager.
        peerEventManager.on('connectionReady', (data) => this._onConnectionReady(data));
        peerEventManager.on('trackReceived', ({ callId, connectionType, track, stream }) => {
            if (connectionType === ConnectionType.MONITOR) {
                // Supervisor's microphone track — route to the bridge for optional mixing.
                // In listen mode the capture is created but never consulted by any relay,
                // so there is zero audio impact until the supervisor switches mode.
                console.log(`📥 Supervisor mic track received for call ${callId}`);
                audioCoordinator.handleSupervisorTrack(callId, track);
                return;
            }
            console.log(`📥 Track received: callId=${callId}, type=${connectionType}, trackId=${track.id}`);
            audioCoordinator.handleTrackReceived(callId, connectionType, track, stream);

            // If a WHATSAPP audio track arrives after checkAndStartBridging already ran
            // (and returned early because customerTrack was null), retry now.
            if (connectionType === ConnectionType.WHATSAPP && track.kind === 'audio') {
                this.checkAndStartBridging(callId).catch(err =>
                    console.error(`[PeerRegistry] Bridge retry on trackReceived failed for call ${callId}:`, err.message)
                );
            }
        });
    }

    // ── Connection lifecycle events ────────────────────────────────────────────

    _onConnectionReady({ callId, connectionType }) {
        console.log(`Connection ready: ${connectionType} for call ${callId}`);

        const result = this.getConnectionData(callId, connectionType);
        if (!result.valid) return;
        result.data.setReady(true);

        if (connectionType === ConnectionType.MONITOR) {
            this._activateMonitor(callId).catch(err =>
                console.error(`[PeerRegistry] Monitor activation failed for call ${callId}:`, err.message)
            );
        } else {
            this.checkAndStartBridging(callId).catch(err =>
                console.error(`[PeerRegistry] Bridge start failed for call ${callId}:`, err.message)
            );
        }
    }

    async _activateMonitor(callId) {
        const bridge = audioCoordinator.getBridge(callId);
        if (!bridge || !bridge.isActive) {
            await this.closePeerConnection(callId, ConnectionType.MONITOR);
            emitCallError({ callId, code: CallErrorCodes.BRIDGE_NOT_READY, message: 'Call is not active or bridge not ready for monitoring' });
            return;
        }

        const monitorResult = this.getConnectionData(callId, ConnectionType.MONITOR);
        if (!monitorResult.valid) {
            await this.closePeerConnection(callId, ConnectionType.MONITOR);
            emitCallError({ callId, code: CallErrorCodes.MONITOR_CONNECTION_FAILED, message: 'Failed to create monitor connection' });
            return;
        }

        const added = audioCoordinator.addMonitorConnection(callId, monitorResult.data);
        if (!added) {
            await this.closePeerConnection(callId, ConnectionType.MONITOR);
            emitCallError({ callId, code: CallErrorCodes.MONITOR_ADD_FAILED, message: 'Failed to add monitor to audio bridge' });
            return;
        }

        console.log(`[Monitor] Monitoring enabled for call ${callId}`);
    }

    // ── Peer connection creation ───────────────────────────────────────────────

    createPeerConnection(callId, connectionType) {
        console.log(`Creating ${connectionType} peer connection for call ${callId}`);
        return new RTCPeerConnection(PeerConfig.getDefaultConfig());
    }

    getConnectionData(callId, connectionType, requireReady = false) {
        const callConnections = this.peerConnections.get(callId);
        if (!callConnections) return { valid: false, reason: `No connections found for call ${callId}` };

        const connectionData = callConnections[connectionType];
        if (!connectionData) return { valid: false, reason: `No ${connectionType} connection found` };

        if (requireReady && !connectionData.isReady) return { valid: false, reason: `${connectionType} connection not ready` };

        return { valid: true, data: connectionData };
    }

    getOrCreateConnection(callId, connectionType) {
        const result = this.getConnectionData(callId, connectionType);
        if (result.valid && result.data.pc.signalingState !== 'closed') {
            return { pc: result.data.pc, connectionData: result.data, reused: true };
        }

        const pc = this.createPeerConnection(callId, connectionType);
        const callConnections = this.peerConnections.get(callId);
        const context = callConnections?.context ?? new CallContext(callId);
        const connectionData = new Peer(pc, connectionType, context);
        return { pc, connectionData, reused: false };
    }

    async prepareConnection(callId, connectionType, connectionData) {
        await connectionData.insertConnectionRecord();

        peerEventManager.setupPeerConnectionListeners(
            connectionData.pc, callId, connectionType, connectionData.audio.trackBuffer
        );

        if (!this.peerConnections.has(callId)) this.peerConnections.set(callId, {});
        const callConnections = this.peerConnections.get(callId);
        callConnections[connectionType] = connectionData;
        if (!callConnections.context) callConnections.context = connectionData.context;
    }

    async extractAndStoreCandidates(sdp, callId, connectionType) {
        const candidateLines = sdp.split(/\r?\n/).filter(line => line.startsWith('a=candidate:'));
        for (const line of candidateLines) {
            await CallConnectionRepository.addICECandidate(callId, connectionType, { candidate: line });
        }
    }

    // ── Bridge helper ─────────────────────────────────────────────────────────

    async checkAndStartBridging(callId) {
        const context = this.peerConnections.get(callId)?.context;

        // ivrMenuId caching: undefined = not yet fetched; null = fetched, confirmed no IVR.
        // Non-IVR calls (majority) skip the DB round-trip on every connection-ready event
        // after the first. IVR calls always re-fetch because state changes during the session.
        let callRecord = null;
        let ivrMenuId;

        if (context?.ivrMenuId === undefined) {
            callRecord = await CallRepository.findById(callId).catch(() => null);
            ivrMenuId = callRecord?.ivr_menu_id ?? null;
            if (context) {
                context.ivrMenuId = ivrMenuId;
                // Seed businessId now so it survives the non-IVR fast-path (DB skipped on
                // subsequent calls). Without this, callRecord is null when both peers finally
                // become ready and AGENT_JOINED hasn't fired yet — recording gets no businessId.
                if (callRecord?.business_id && !context.businessId) {
                    context.update({ businessId: callRecord.business_id });
                }
            }
        } else if (context.ivrMenuId !== null) {
            // Known IVR call — re-fetch to get current state
            callRecord = await CallRepository.findById(callId).catch(() => null);
            ivrMenuId = context.ivrMenuId;
        } else {
            // Confirmed non-IVR — skip DB
            ivrMenuId = null;
        }

        if (ivrMenuId && callRecord?.state === 'IVR' && !ivrCoordinator.isActive(callId) && !ivrCoordinator.hasCompleted(callId)) {
            // IVR mode: only the WhatsApp connection is needed
            const whatsappResult = this.getConnectionData(callId, ConnectionType.WHATSAPP, true);
            if (!whatsappResult.valid) {
                console.log(`[PeerRegistry] ⏳ IVR waiting for WHATSAPP — call ${callId}`);
                return;
            }

            const whatsappPeer = whatsappResult.data; // Peer object — has shiftPlaceholderSender()
            const whatsappPc = whatsappPeer.pc;
            const customerTrack = whatsappPc.getReceivers()
                .find(r => r.track?.kind === 'audio')?.track ?? null;

            if (!customerTrack) {
                // Audio track not yet available — trackReceived will re-trigger bridging.
                console.log(`[PeerRegistry] ⏳ IVR waiting for audio track (ontrack pending) — call ${callId}`);
                return;
            }

            const callMeta = {
                businessId: context?.businessId ?? callRecord?.business_id,
                businessNumberId: context?.callee?.id ?? callRecord?.business_number_id,
            };

            console.log(`[PeerRegistry] 🔊 IVR mode — starting IVR session for call ${callId}, menu ${ivrMenuId}`);
            await ivrCoordinator.startSession(callId, ivrMenuId, whatsappPc, customerTrack, callMeta, whatsappPeer);
            return;
        }

        // Normal mode: both FRONTEND and WHATSAPP must be ready
        const frontendResult = this.getConnectionData(callId, ConnectionType.FRONTEND, true);
        const whatsappResult = this.getConnectionData(callId, ConnectionType.WHATSAPP, true);

        if (!frontendResult.valid || !whatsappResult.valid) {
            console.log(`[PeerRegistry] ⏳ Bridge not ready for call ${callId} — FRONTEND=${frontendResult.valid}, WHATSAPP=${whatsappResult.valid}`);
            this._scheduleIceStallWarning(callId, frontendResult.valid, whatsappResult.valid);
            return;
        }

        this._clearIceStallTimers(callId);

        const resolvedBusinessId = frontendResult.data?.context?.businessId
            ?? whatsappResult.data?.context?.businessId
            ?? callRecord?.business_id
            ?? null;

        // Bridge events can fire before AGENT_JOINED updates context; seed from DB as fallback.
        if (resolvedBusinessId && context && !context.businessId) {
            context.update({ businessId: resolvedBusinessId });
        }

        console.log(`[PeerRegistry] 🚀 Both connections ready, starting bridge for call ${callId}`);
        await audioCoordinator.checkAndStartBridging(
            callId,
            frontendResult.data,
            whatsappResult.data,
            resolvedBusinessId,
        );
    }

    // ── ICE stall detection ───────────────────────────────────────────────────

    _scheduleIceStallWarning(callId, frontendReady, whatsappReady) {
        const timers = this._iceStallTimers.get(callId) ?? {};

        if (frontendReady && !whatsappReady && !timers.whatsapp) {
            timers.whatsapp = setTimeout(() => {
                console.warn(`[PeerRegistry] ⚠️ ICE stall: call ${callId} — FRONTEND ready but WHATSAPP stuck in checking >8s, no media will flow`);
            }, 8000);
        }

        if (whatsappReady && !frontendReady && !timers.frontend) {
            timers.frontend = setTimeout(() => {
                console.warn(`[PeerRegistry] ⚠️ ICE stall: call ${callId} — WHATSAPP ready but FRONTEND stuck at new/checking >8s, no media will flow`);
            }, 8000);
        }

        this._iceStallTimers.set(callId, timers);
    }

    _clearIceStallTimers(callId) {
        const timers = this._iceStallTimers.get(callId);
        if (!timers) return;
        clearTimeout(timers.frontend);
        clearTimeout(timers.whatsapp);
        this._iceStallTimers.delete(callId);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    async closePeerConnection(callId, connectionType = null) {
        console.log(`Closing connection for call ${callId} (type: ${connectionType || 'all'})`);

        const callConnections = this.peerConnections.get(callId);
        if (!callConnections) {
            console.log(`No connections found for call ${callId}`);
            return false;
        }

        const closingAll = !connectionType;
        const closingFrontend = connectionType === ConnectionType.FRONTEND;

        if (closingAll || connectionType === ConnectionType.WHATSAPP) {
            console.log(`[PeerRegistry] 🛑 Stopping recording for call ${callId}`);
            await audioCoordinator.stopRecording(callId);
        }

        const typesToClose = connectionType
            ? [connectionType]
            : Object.keys(callConnections).filter(k => k !== 'context');

        await Promise.all(typesToClose.map(async type => {
            const connectionData = callConnections[type];
            if (!connectionData) return;

            if (type === ConnectionType.MONITOR) {
                audioCoordinator.removeMonitorConnection(callId);
            }

            try {
                await connectionData.cleanup();
            } catch (err) {
                console.error(`[PeerRegistry] Error during ${type} cleanup for call ${callId}:`, err.message);
            } finally {
                delete callConnections[type];
                console.log(`${type} connection closed`);
            }
        }));

        if (closingFrontend && callConnections[ConnectionType.WHATSAPP]) {
            await audioCoordinator.handleFrontendDisconnected(callId);
        }

        const hasMainConnections = callConnections[ConnectionType.FRONTEND] || callConnections[ConnectionType.WHATSAPP];

        // Only do full cleanup when closing all, or when a non-FRONTEND connection is removed
        // and no main connections remain.  Closing just FRONTEND (transfer / reconnect) must NOT
        // unsubscribe from Redis or wipe ICE/audio state, because a new FRONTEND will be created
        // immediately afterwards.
        if (closingAll || (!closingFrontend && !hasMainConnections)) {
            this._clearIceStallTimers(callId);

            await redisPubSubService.unsubscribeFromCall(callId);
            console.log(`[PeerRegistry] 🔕 Unsubscribed from events for call ${callId}`);

            this.peerConnections.delete(callId);

            audioCoordinator.cleanup(callId);
            iceCoordinator.cleanup(callId);
            peerEventManager.cleanup(callId);

            await CallConnectionRepository.terminateConnections(callId)
                .catch(err => console.error('Failed to terminate connections in DB:', err));

            console.log(`🧹 Call ${callId} fully cleaned up`);
        } else if (connectionType === ConnectionType.MONITOR) {
            console.log(`✅ Monitor disconnected, main call ${callId} continues`);
        } else {
            console.log(`✅ ${connectionType} closed, call ${callId} continues`);
        }

        return true;
    }
}

export const peerRegistry = new PeerRegistry();
