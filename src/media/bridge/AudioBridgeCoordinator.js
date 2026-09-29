// src/media/bridge/AudioBridgeCoordinator.js
//
// Single responsibility: own the Map of active AudioBridge instances (one per call)
// and expose bridge lifecycle operations — start, stop, cleanup, monitor management,
// and track extraction for recording.
//
// AudioBridge (per-call relay logic) lives in AudioBridge.js.
import { AudioBridge } from './AudioBridge.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.bridge.AudioBridgeCoordinator');

export class AudioBridgeCoordinator {
    constructor() {
        this.activeBridges = new Map(); // callId -> AudioBridge
    }

    // ─────────────────────────────────────────────────────────────────
    // BRIDGE LIFECYCLE
    // ─────────────────────────────────────────────────────────────────

    async checkAndStartBridging(callId, frontendConnection, customerConnection) {
        const frontendReady = frontendConnection?.pc?.connectionState === 'connected';
        const customerReady = customerConnection?.pc?.connectionState === 'connected';

        if (!frontendReady) {
            log.info({ callId }, `Frontend not ready: ${frontendConnection?.pc?.connectionState ?? 'missing'}`);
            return false;
        }

        if (!customerReady) {
            log.info({ callId }, `Customer leg not ready: ${customerConnection?.pc?.connectionState ?? 'missing'}`);
            return false;
        }

        log.info({ callId }, 'Starting bridge');

        let bridge = this.activeBridges.get(callId);
        if (!bridge) {
            bridge = new AudioBridge(callId);
            this.activeBridges.set(callId, bridge);
        }

        const bridgeSet = bridge.setConnections(customerConnection, frontendConnection);
        if (bridgeSet) {
            await bridge.startBridging();
            return true;
        }

        return false;
    }

    cleanup(callId) {
        const bridge = this.activeBridges.get(callId);
        if (bridge) {
            bridge.stopBridging();
            this.activeBridges.delete(callId);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // MONITOR
    // ─────────────────────────────────────────────────────────────────

    addMonitorConnection(callId, monitorConnection) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge) {
            log.warn({ callId }, 'No active bridge');
            return false;
        }

        log.info({ callId }, 'Adding monitor');
        return bridge.addMonitor(monitorConnection);
    }

    removeMonitorConnection(callId) {
        const bridge = this.activeBridges.get(callId);
        if (bridge) {
            bridge.removeMonitor();
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // SUPERVISOR
    // ─────────────────────────────────────────────────────────────────

    setSupervisorTrack(callId, track) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge) {
            log.warn({ callId }, 'No active bridge for supervisor track');
            return;
        }
        bridge.setSupervisorTrack(track);
    }

    setSupervisorMode(callId, mode) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge) {
            log.warn({ callId }, 'No active bridge for supervisor mode change');
            return;
        }
        bridge.setSupervisorMode(mode);
    }

    setAgentPrivate(callId, active) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge) {
            log.warn({ callId }, 'No active bridge for agent-private change');
            return;
        }
        bridge.setAgentPrivate(active);
    }

    // ─────────────────────────────────────────────────────────────────
    // TRACK EXTRACTION (for recording)
    // ─────────────────────────────────────────────────────────────────

    getTracksForRecording(callId) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge?.isActive) {
            log.warn({ callId }, 'No active bridge');
            return null;
        }

        const agentTrack = this._getTrackFromConnection(bridge.frontendConnection, 'agent');
        const customerTrack = this._getTrackFromConnection(bridge.customerConnection, 'customer');

        if (!agentTrack || !customerTrack) {
            log.warn({ callId, hasAgent: !!agentTrack,
                hasCustomer: !!customerTrack }, 'Missing tracks');
            return null;
        }

        return { agentTrack, customerTrack };
    }

    getAgentTrackForRecording(callId) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge?.isActive) {
            log.warn({ callId }, 'No active bridge');
            return null;
        }

        const agentTrack = this._getTrackFromConnection(bridge.frontendConnection, 'agent');
        if (!agentTrack) {
            log.warn({ callId }, 'No live agent track');
        }

        return agentTrack;
    }

    getCustomerTrackForDTMF(callId) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge?.isActive) {
            log.warn({ callId }, 'No active bridge');
            return null;
        }

        const customerTrack = this._getTrackFromConnection(bridge.customerConnection, 'customer');
        if (!customerTrack) {
            log.warn({ callId }, 'No live customer track');
        }

        return customerTrack;
    }

    // ─────────────────────────────────────────────────────────────────
    // ACCESSORS
    // ─────────────────────────────────────────────────────────────────

    getBridge(callId) {
        return this.activeBridges.get(callId);
    }

    // ─────────────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────────────

    _getTrackFromConnection(connection, label) {
        if (!connection?.pc) {
            log.error(`No connection for ${label}`);
            return null;
        }

        let receivers;
        try {
            receivers = connection.pc.getReceivers();
        } catch (err) {
            log.error({ err }, `getReceivers threw for ${label}`);
            return null;
        }

        for (const receiver of receivers) {
            if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
                return receiver.track;
            }
        }

        log.warn(`No live audio track for ${label}`);
        return null;
    }
}
