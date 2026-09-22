// services/call/audio/AudioBridgeCoordinator.js
//
// Single responsibility: own the Map of active AudioBridge instances (one per call)
// and expose bridge lifecycle operations — start, stop, cleanup, monitor management,
// and track extraction for recording.
//
// AudioBridge (per-call relay logic) lives in AudioBridge.js.
import { AudioBridge } from './AudioBridge.js';

export class AudioBridgeCoordinator {
    constructor() {
        this.activeBridges = new Map(); // callId -> AudioBridge
    }

    // ─────────────────────────────────────────────────────────────────
    // BRIDGE LIFECYCLE
    // ─────────────────────────────────────────────────────────────────

    async checkAndStartBridging(callId, frontendConnection, whatsappConnection) {
        const frontendReady = frontendConnection?.pc?.connectionState === 'connected';
        const whatsappReady = whatsappConnection?.pc?.connectionState === 'connected';

        if (!frontendReady) {
            console.log(`[AudioBridgeCoordinator] Frontend not ready for call ${callId}: ${frontendConnection?.pc?.connectionState ?? 'missing'}`);
            return false;
        }

        if (!whatsappReady) {
            console.log(`[AudioBridgeCoordinator] WhatsApp not ready for call ${callId}: ${whatsappConnection?.pc?.connectionState ?? 'missing'}`);
            return false;
        }

        console.log(`[AudioBridgeCoordinator] Starting bridge for call ${callId}`);

        let bridge = this.activeBridges.get(callId);
        if (!bridge) {
            bridge = new AudioBridge(callId);
            this.activeBridges.set(callId, bridge);
        }

        const bridgeSet = bridge.setConnections(whatsappConnection, frontendConnection);
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
            console.error(`[AudioBridgeCoordinator] No active bridge for call ${callId}`);
            return false;
        }

        console.log(`[AudioBridgeCoordinator] Adding monitor to call ${callId}`);
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
            console.warn(`[AudioBridgeCoordinator] No active bridge for supervisor track on call ${callId}`);
            return;
        }
        bridge.setSupervisorTrack(track);
    }

    setSupervisorMode(callId, mode) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge) {
            console.warn(`[AudioBridgeCoordinator] No active bridge for supervisor mode change on call ${callId}`);
            return;
        }
        bridge.setSupervisorMode(mode);
    }

    setAgentPrivate(callId, active) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge) {
            console.warn(`[AudioBridgeCoordinator] No active bridge for agent-private change on call ${callId}`);
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
            console.error(`[AudioBridgeCoordinator] No active bridge for call ${callId}`);
            return null;
        }

        const agentTrack = this._getTrackFromConnection(bridge.frontendConnection, 'agent');
        const customerTrack = this._getTrackFromConnection(bridge.whatsappConnection, 'customer');

        if (!agentTrack || !customerTrack) {
            console.error(`[AudioBridgeCoordinator] Missing tracks for call ${callId}`, {
                hasAgent: !!agentTrack,
                hasCustomer: !!customerTrack,
            });
            return null;
        }

        return { agentTrack, customerTrack };
    }

    getAgentTrackForRecording(callId) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge?.isActive) {
            console.error(`[AudioBridgeCoordinator] No active bridge for call ${callId}`);
            return null;
        }

        const agentTrack = this._getTrackFromConnection(bridge.frontendConnection, 'agent');
        if (!agentTrack) {
            console.warn(`[AudioBridgeCoordinator] No live agent track for call ${callId}`);
        }

        return agentTrack;
    }

    getCustomerTrackForDTMF(callId) {
        const bridge = this.activeBridges.get(callId);
        if (!bridge?.isActive) {
            console.error(`[AudioBridgeCoordinator] No active bridge for call ${callId}`);
            return null;
        }

        const customerTrack = this._getTrackFromConnection(bridge.whatsappConnection, 'customer');
        if (!customerTrack) {
            console.warn(`[AudioBridgeCoordinator] No live customer track for call ${callId}`);
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
            console.error(`[AudioBridgeCoordinator] No connection for ${label}`);
            return null;
        }

        let receivers;
        try {
            receivers = connection.pc.getReceivers();
        } catch (err) {
            console.error(`[AudioBridgeCoordinator] getReceivers() threw for ${label}: ${err.message}`);
            return null;
        }

        for (const receiver of receivers) {
            if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
                return receiver.track;
            }
        }

        console.warn(`[AudioBridgeCoordinator] No live audio track for ${label}`);
        return null;
    }
}
