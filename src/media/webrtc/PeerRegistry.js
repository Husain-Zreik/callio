// src/media/webrtc/PeerRegistry.js
// Registry of all active WebRTC peer connections.
// Owns the peerConnections Map, all peer lifecycle operations,
// and the connectionReady/trackReceived event wiring from PeerEventManager.
// Singleton — import `peerRegistry` everywhere instead of going through CallManager.
import wrtc from '@roamhq/wrtc';
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import CallRepository from '../../persistence/CallRepository.js';
import { redisPubSubService } from '../../infra/redis/RedisPubSubService.js';
import { audioCoordinator } from '../bridge/AudioCoordinator.js';
import { iceCoordinator } from './ice/ICECandidateCoordinator.js';
import { peerEventManager } from './PeerEventManager.js';
import { emitCallError } from '../../core/events/CallErrorEmitter.js';
import { CallErrorCodes } from '../../core/events/CallErrorCodes.js';
import { Peer } from './Peer.js';
import { CallContext } from './CallContext.js';
import { PeerConfig } from './PeerConfig.js';
import { ConnectionType } from '../../core/constants/CallConstants.js';
import { ivrCoordinator } from '../../core/ivr/IvrCoordinator.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.webrtc.PeerRegistry');

const { RTCPeerConnection } = wrtc;

class PeerRegistry {
    constructor() {
        // callId -> { AGENT?, CUSTOMER?, MONITOR?, context: CallContext }
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
                log.debug({ callId }, 'Supervisor mic track received');
                audioCoordinator.handleSupervisorTrack(callId, track);
                return;
            }
            log.debug({ callId }, `Track received: type=${connectionType}, trackId=${track.id}`);
            audioCoordinator.handleTrackReceived(callId, connectionType, track, stream);

            // If a CUSTOMER audio track arrives after checkAndStartBridging already ran
            // (and returned early because customerTrack was null), retry now.
            if (connectionType === ConnectionType.CUSTOMER && track.kind === 'audio') {
                this.checkAndStartBridging(callId).catch(err =>
                    log.warn({ callId, err }, 'Bridge retry on trackReceived failed')
                );
            }
        });
    }

    // ── Connection lifecycle events ────────────────────────────────────────────

    _onConnectionReady({ callId, connectionType }) {
        log.info({ callId }, `Connection ready: ${connectionType}`);

        const result = this.getConnectionData(callId, connectionType);
        if (!result.valid) return;
        result.data.setReady(true);

        if (connectionType === ConnectionType.MONITOR) {
            this._activateMonitor(callId).catch(err =>
                log.error({ callId, err }, 'Monitor activation failed')
            );
        } else {
            this.checkAndStartBridging(callId).catch(err =>
                log.error({ callId, err }, 'Bridge start failed')
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

        log.info({ callId }, 'Monitoring enabled');
    }

    // ── Peer connection creation ───────────────────────────────────────────────

    createPeerConnection(callId, connectionType) {
        log.info({ callId }, `Creating ${connectionType} peer connection`);
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

        // ivrFlowId caching: undefined = not yet fetched; null = fetched, confirmed no IVR.
        // Non-IVR calls (majority) skip the DB round-trip on every connection-ready event
        // after the first. IVR calls always re-fetch because state changes during the session.
        let callRecord = null;
        let ivrFlowId;

        if (context?.ivrFlowId === undefined) {
            callRecord = await CallRepository.findById(callId).catch(() => null);
            ivrFlowId = callRecord?.ivr_flow_id ?? null;
            if (context) {
                context.ivrFlowId = ivrFlowId;
                // Seed tenantId now so it survives the non-IVR fast-path (DB skipped on
                // subsequent calls). Without this, callRecord is null when both peers finally
                // become ready and AGENT_JOINED hasn't fired yet — recording gets no tenantId.
                if (callRecord?.tenant_id && !context.tenantId) {
                    context.update({ tenantId: callRecord.tenant_id });
                }
            }
        } else if (context.ivrFlowId !== null) {
            // Known IVR call — re-fetch to get current state
            callRecord = await CallRepository.findById(callId).catch(() => null);
            ivrFlowId = context.ivrFlowId;
        } else {
            // Confirmed non-IVR — skip DB
            ivrFlowId = null;
        }

        if (ivrFlowId && callRecord?.state === 'IVR' && !ivrCoordinator.isActive(callId) && !ivrCoordinator.hasCompleted(callId)) {
            // IVR mode: only the WhatsApp connection is needed
            const customerResult = this.getConnectionData(callId, ConnectionType.CUSTOMER, true);
            if (!customerResult.valid) {
                log.info({ callId }, 'IVR waiting for the CUSTOMER leg');
                return;
            }

            const customerPeer = customerResult.data; // Peer object — has shiftPlaceholderSender()
            const customerPc = customerPeer.pc;
            const customerTrack = customerPc.getReceivers()
                .find(r => r.track?.kind === 'audio')?.track ?? null;

            if (!customerTrack) {
                // Audio track not yet available — trackReceived will re-trigger bridging.
                log.debug({ callId }, 'IVR waiting for the audio track (ontrack pending)');
                return;
            }

            const callMeta = {
                tenantId: context?.tenantId ?? callRecord?.tenant_id,
                channelId: context?.channelId ?? callRecord?.channel_id ?? null,
                queueId: callRecord?.queue_id ?? null,
            };

            log.info({ callId }, `IVR mode — starting IVR session, menu ${ivrFlowId}`);
            await ivrCoordinator.startSession(callId, ivrFlowId, customerPc, customerTrack, callMeta, customerPeer);
            return;
        }

        // Normal mode: both AGENT and CUSTOMER must be ready
        const frontendResult = this.getConnectionData(callId, ConnectionType.AGENT, true);
        const customerResult = this.getConnectionData(callId, ConnectionType.CUSTOMER, true);

        if (!frontendResult.valid || !customerResult.valid) {
            log.info({ callId }, `Bridge not ready — AGENT=${frontendResult.valid}, CUSTOMER=${customerResult.valid}`);
            this._scheduleIceStallWarning(callId, frontendResult.valid, customerResult.valid);
            return;
        }

        this._clearIceStallTimers(callId);

        const resolvedTenantId = frontendResult.data?.context?.tenantId
            ?? customerResult.data?.context?.tenantId
            ?? callRecord?.tenant_id
            ?? null;

        // Bridge events can fire before AGENT_JOINED updates context; seed from DB as fallback.
        if (resolvedTenantId && context && !context.tenantId) {
            context.update({ tenantId: resolvedTenantId });
        }

        log.info({ callId }, 'Both connections ready, starting bridge');
        await audioCoordinator.checkAndStartBridging(
            callId,
            frontendResult.data,
            customerResult.data,
            resolvedTenantId,
        );
    }

    // ── ICE stall detection ───────────────────────────────────────────────────

    _scheduleIceStallWarning(callId, frontendReady, customerReady) {
        const timers = this._iceStallTimers.get(callId) ?? {};

        if (frontendReady && !customerReady && !timers.customer) {
            timers.customer = setTimeout(() => {
                log.warn({ callId }, 'ICE stall: AGENT ready but CUSTOMER stuck in checking >8s, no media will flow');
            }, 8000);
        }

        if (customerReady && !frontendReady && !timers.frontend) {
            timers.frontend = setTimeout(() => {
                log.warn({ callId }, 'ICE stall: CUSTOMER ready but AGENT stuck at new/checking >8s, no media will flow');
            }, 8000);
        }

        this._iceStallTimers.set(callId, timers);
    }

    _clearIceStallTimers(callId) {
        const timers = this._iceStallTimers.get(callId);
        if (!timers) return;
        clearTimeout(timers.frontend);
        clearTimeout(timers.customer);
        this._iceStallTimers.delete(callId);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    async closePeerConnection(callId, connectionType = null) {
        log.info({ callId }, `Closing connection (type: ${connectionType || 'all'})`);

        const callConnections = this.peerConnections.get(callId);
        if (!callConnections) {
            log.debug({ callId }, 'No connections found');
            return false;
        }

        const closingAll = !connectionType;
        const closingFrontend = connectionType === ConnectionType.AGENT;

        if (closingAll || connectionType === ConnectionType.CUSTOMER) {
            log.info({ callId }, 'Stopping recording');
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
                log.error({ callId, err }, `Error during ${type} cleanup`);
            } finally {
                delete callConnections[type];
                log.info(`${type} connection closed`);
            }
        }));

        if (closingFrontend && callConnections[ConnectionType.CUSTOMER]) {
            await audioCoordinator.handleFrontendDisconnected(callId);
        }

        const hasMainConnections = callConnections[ConnectionType.AGENT] || callConnections[ConnectionType.CUSTOMER];

        // Only do full cleanup when closing all, or when a non-AGENT connection is removed
        // and no main connections remain.  Closing just AGENT (transfer / reconnect) must NOT
        // unsubscribe from Redis or wipe ICE/audio state, because a new AGENT will be created
        // immediately afterwards.
        if (closingAll || (!closingFrontend && !hasMainConnections)) {
            this._clearIceStallTimers(callId);

            await redisPubSubService.unsubscribeFromCall(callId);
            log.info({ callId }, 'Unsubscribed from events');

            this.peerConnections.delete(callId);

            audioCoordinator.cleanup(callId);
            iceCoordinator.cleanup(callId);
            peerEventManager.cleanup(callId);

            await CallConnectionRepository.terminateConnections(callId)
                .catch(err => log.error({ err }, 'Failed to terminate connections in DB'));

            log.info({ callId }, 'Call fully cleaned up');
        } else if (connectionType === ConnectionType.MONITOR) {
            log.info({ callId }, 'Monitor disconnected, main call continues');
        } else {
            log.info({ callId }, `${connectionType} closed, call continues`);
        }

        return true;
    }
}

export const peerRegistry = new PeerRegistry();
