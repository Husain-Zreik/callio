// src/media/bridge/AudioCoordinator.js
//
// Central coordinator for all audio concerns — the SINGLE entry point
// CallManager uses for every audio operation.
//
// No audio business logic lives here; each method delegates to the
// appropriate sub-manager and returns.
//
// Sub-components:
//   AudioBridgeCoordinator — relay tracks between AGENT / CUSTOMER / MONITOR
//   PlaceholderTrackFactory — create and clean up placeholder tone tracks
//   RecordingCoordinator — recording policy decisions + agent track management
import wrtc from '@roamhq/wrtc';
import { AudioBridgeCoordinator } from './AudioBridgeCoordinator.js';
import { placeholderTrackFactory } from './PlaceholderTrackFactory.js';
import { recordingCoordinator } from '../recording/RecordingCoordinator.js';
import { dtmfCoordinator } from '../dtmf/DTMFCoordinator.js';
import { ConnectionType } from '../../core/constants/CallConstants.js';
import EventBus from '../../core/EventBus.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.bridge.AudioCoordinator');

export class AudioCoordinator {
    constructor() {
        this.bridgeManager = new AudioBridgeCoordinator();
    }

    // ─────────────────────────────────────────────────────────────────
    // PLACEHOLDER TRACK MANAGEMENT
    // ─────────────────────────────────────────────────────────────────

    /**
     * Add an initial placeholder sender to a peer connection before the real
     * audio track arrives.  Called during SDP offer/answer creation.
     *
     * @param {RTCPeerConnection} pc
     * @param {Peer}              peer
     * @param {'reconnecting'|'silence'} [type='reconnecting']
     */
    async addPlaceholderTrack(pc, peer, type = 'reconnecting') {
        const track = await placeholderTrackFactory.createTrack(type);
        if (!track) {
            throw new Error('Failed to create placeholder audio track');
        }

        const sender = pc.addTrack(track, new wrtc.MediaStream([track]));
        // Keep a stable reference to the generated placeholder track on the sender.
        // sender.track is later swapped to the real track via replaceTrack(), which
        // would otherwise lose our only handle to stop the RTCAudioSource on teardown.
        sender._placeholderTrack = track;
        log.debug({ leg: peer.connectionType, type, trackId: track.id }, 'Placeholder track added');
        peer.addPlaceholderSender(sender);
    }

    // ─────────────────────────────────────────────────────────────────
    // BRIDGE & RECORDING LIFECYCLE
    // ─────────────────────────────────────────────────────────────────

    /**
     * Called when both AGENT and CUSTOMER connections reach 'connected'.
     * Starts the audio bridge and triggers recording if enabled.
     */
    async checkAndStartBridging(callId, frontendData, customerData, fallbackTenantId = null) {
        const bridgeStarted = await this.bridgeManager.checkAndStartBridging(callId, frontendData, customerData);

        if (!bridgeStarted) {
            // Bridge did not start (one connection not yet ready). Do NOT stop queue
            // audio — the caller must keep hearing hold music until the bridge retries
            // successfully (triggered when the lagging connection reaches 'connected').
            return;
        }

        // Signal QueueAudioCoordinator to stop the queue waiting audio (if running)
        EventBus.emit('call:queue_audio_stop', { callId });

        log.debug({ callId }, 'Bridge started — checking recording');

        const tenantId = frontendData?.context?.tenantId
            ?? customerData?.context?.tenantId
            ?? fallbackTenantId
            ?? null;

        try {
            await recordingCoordinator.checkAndStartRecording(callId, tenantId, {
                getTracks: () => this.bridgeManager.getTracksForRecording(callId),
                getAgentTrack: () => this.bridgeManager.getAgentTrackForRecording(callId),
                isBridgeActive: () => this.bridgeManager.getBridge(callId)?.isActive === true,
            });
        } catch (err) {
            // Recording failure must never abort bridge start. The bridge ran successfully;
            // only recording init threw (e.g. native getReceivers() in an edge state).
            log.error({ callId, err }, 'Recording init failed');
        }

        // DTMF detection is not started here — IvrCoordinator owns its own DTMF
        // lifecycle (startCapture on session start, stopCapture on session end).
        // Running Goertzel on every bridged call burns ~5% CPU/call for no benefit
        // once the IVR phase is complete.
    }

    /**
     * Route an incoming track from a live connection through the bridge.
     */
    handleTrackReceived(callId, connectionType, track, stream) {
        const bridge = this.bridgeManager.getBridge(callId);
        if (!bridge) {
            log.debug({ callId, trackId: track.id }, 'No bridge yet — track buffered');
            return;
        }

        if (bridge.isActive) {
            const toType = connectionType === ConnectionType.AGENT
                ? ConnectionType.CUSTOMER
                : ConnectionType.AGENT;
            log.debug(`Relaying track: ${connectionType} → ${toType}`);
            bridge.handleIncomingTrack(track, stream, connectionType);
        } else {
            log.debug({ trackId: track.id }, 'Bridge not active — track buffered');
        }
    }

    /**
     * Called when the AGENT peer connection closes mid-call.
     * Attaches a reconnecting-tone placeholder to keep the customer hearing
     * audio, and wires it into the recording session if active.
     */
    async handleFrontendDisconnected(callId) {
        const bridge = this.bridgeManager.getBridge(callId);
        if (!bridge?.isActive) {
            log.debug({ callId }, 'No active bridge, skipping beep');
            return;
        }

        // Pause agent recording and get PCM callback for placeholder (null if not recording).
        const onFrame = recordingCoordinator.pauseAgentCapture(callId);

        const beepTrack = await placeholderTrackFactory.createAndRegister(callId, 'reconnecting', onFrame);
        if (!beepTrack) {
            log.error({ callId }, 'Failed to create beep track');
            return;
        }

        bridge.relayTrack(beepTrack, new wrtc.MediaStream([beepTrack]), ConnectionType.AGENT, ConnectionType.CUSTOMER);
        log.info({ callId }, 'Reconnect beep attached');
    }

    // ─────────────────────────────────────────────────────────────────
    // MONITOR CONNECTION
    // ─────────────────────────────────────────────────────────────────

    addMonitorConnection(callId, monitorConnectionData) {
        return this.bridgeManager.addMonitorConnection(callId, monitorConnectionData);
    }

    removeMonitorConnection(callId) {
        this.bridgeManager.removeMonitorConnection(callId);
    }

    /**
     * Called when the supervisor's microphone track arrives from the MONITOR
     * peer connection. Forwards it to the bridge so it can be captured and
     * mixed into the relay path when whisper or barge mode is active.
     *
     * @param {string|number} callId
     * @param {MediaStreamTrack} track
     */
    handleSupervisorTrack(callId, track) {
        this.bridgeManager.setSupervisorTrack(callId, track);
    }

    /**
     * Change the supervisor mode for an active call.
     * The bridge activates or deactivates MixingRelay instances as needed.
     *
     * @param {string|number} callId
     * @param {'listen'|'whisper'|'barge'} mode
     */
    setSupervisorMode(callId, mode) {
        this.bridgeManager.setSupervisorMode(callId, mode);
    }

    /**
     * Toggle the agent's "whisper back to supervisor" privacy: mutes the agent's
     * audio to the customer while the supervisor keeps hearing them (via monitor).
     *
     * @param {string|number} callId
     * @param {boolean} active
     */
    setAgentPrivate(callId, active) {
        this.bridgeManager.setAgentPrivate(callId, active);
    }

    // ─────────────────────────────────────────────────────────────────
    // BRIDGE ACCESSORS
    // ─────────────────────────────────────────────────────────────────

    getBridge(callId) {
        return this.bridgeManager.getBridge(callId);
    }

    // ─────────────────────────────────────────────────────────────────
    // TEARDOWN
    // ─────────────────────────────────────────────────────────────────

    async stopRecording(callId) {
        await recordingCoordinator.stopRecording(callId);
    }

    cleanup(callId) {
        // Final teardown: hard-release the DTMF sink (the call — and its CUSTOMER
        // track — is ending, so stopping the sink is safe here).
        dtmfCoordinator.destroyDetection(callId);
        this.bridgeManager.cleanup(callId);
        // Defensive: clear any reconnect placeholder registered via handleFrontendDisconnected().
        // RecordingManager.stopRecording() clears it when a recording session exists, but calls
        // without an active recording (or calls that ended without agent reconnecting) never
        // reach that path.  clearTrack() is idempotent — a no-op if already cleared.
        placeholderTrackFactory.clearTrack(callId);
    }
}

export const audioCoordinator = new AudioCoordinator();
