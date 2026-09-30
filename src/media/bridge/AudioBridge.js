// src/media/bridge/AudioBridge.js
//
// Single responsibility: relay audio tracks between a AGENT and a CUSTOMER
// peer connection for one active call, and optionally to a MONITOR connection.
//
// Track delivery to peers is delegated to Peer.deliverTrack / deliverMonitorTrack —
// this class never reaches into peer audio-state directly.
import { ConnectionType } from '../../core/constants/CallConstants.js';
import { leakMetrics } from '../../infra/monitoring/leakMetrics.js';
import { MixingRelay } from './MixingRelay.js';
import { SupervisorCapture } from './SupervisorCapture.js';
import { placeholderTrackFactory } from './PlaceholderTrackFactory.js';
import { CustomerSilenceWatchdog } from './CustomerSilenceWatchdog.js';
import { CustomerNetworkMonitor } from './CustomerNetworkMonitor.js';
import EventBus from '../../core/EventBus.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.bridge.AudioBridge');

export class AudioBridge {
    constructor(callId) {
        this.callId = callId;
        this.customerConnection = null;
        this.frontendConnection = null;
        this.monitorConnection = null;

        this.frontendTracks = [];
        this.customerTracks = [];

        this.isActive = false;
        this.stats = {
            bridgeStartTime: null,
            tracksRelayed: 0,
        };

        // Supervisor feature state
        this.supervisorMode = 'listen';         // 'listen' | 'whisper' | 'barge'
        this._supervisorCapture = null;         // SupervisorCapture — set when supervisor mic arrives
        this._frontendMixingRelay = null;       // MixingRelay: customer→agent path (whisper + barge)
        this._customerMixingRelay = null;       // MixingRelay: agent→customer path (barge only)
        this._agentTrack = null;                // agent's received track (from AGENT receiver)
        this._customerTrack = null;             // customer's received track (from the CUSTOMER receiver)

        // Agent whisper-back: mute agent → customer while the supervisor (who hears
        // the agent via the monitor connection) keeps hearing them.
        this._agentPrivate = false;
        this._agentPrivateSilenceTrack = null;

        this._silenceWatchdog = null;
        this._networkMonitor = null;

        log.debug({ callId: this.callId }, 'Created');
    }

    // ─────────────────────────────────────────────────────────────────
    // CONNECTIONS
    // ─────────────────────────────────────────────────────────────────

    setConnections(customerConn, frontendConn) {
        if (!frontendConn || frontendConn.pc.connectionState === 'closed') {
            log.error({ callId: this.callId }, 'Cannot set closed frontend connection');
            return false;
        }

        if (!customerConn || customerConn.pc.connectionState === 'closed') {
            log.error({ callId: this.callId }, 'Cannot set closed customer connection');
            return false;
        }

        this.customerConnection = customerConn;
        this.frontendConnection = frontendConn;

        log.debug({ callId: this.callId }, `Connections set — frontend: ${frontendConn.pc.connectionState}, customer: ${customerConn.pc.connectionState}`);

        // Re-relay any live WhatsApp track to the (possibly new) frontend connection.
        this._relayCustomerTrackToFrontend();

        // Flush any tracks that arrived before both connections were ready.
        this._processBufferedTracks();

        return true;
    }

    addMonitor(monitorConnection) {
        if (!monitorConnection || monitorConnection.pc.connectionState === 'closed') {
            log.error({ callId: this.callId }, 'Cannot add closed monitor');
            return false;
        }

        this.monitorConnection = monitorConnection;
        log.info({ callId: this.callId }, 'Monitor added');

        // Stop placeholder tone intervals on the monitor; real tracks will replace them.
        let monitorSenders = [];
        try { monitorSenders = monitorConnection.pc.getSenders(); } catch (err) {
            log.warn({ callId: this.callId, err }, 'getSenders in addMonitor failed');
        }
        monitorSenders.forEach(sender => {
            if (sender.track?._placeholderInterval) {
                clearInterval(sender.track._placeholderInterval);
                sender.track._placeholderInterval = null;
                leakMetrics.placeholderCleared++;   // DIAGNOSTIC
            }
        });

        this._relayExistingTracksToMonitor();
        return true;
    }

    removeMonitor() {
        if (this.monitorConnection) {
            log.info({ callId: this.callId }, 'Monitor removed from call');
            this.monitorConnection = null;
            // Tear down any active mixing relays and supervisor capture.
            this._teardownSupervisor();
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────
    // TRACK ROUTING
    // ─────────────────────────────────────────────────────────────────

    handleIncomingTrack(track, stream, connectionType) {
        if (!this.isActive) {
            log.debug(`Bridge not active, discarding ${connectionType} track`);
            return;
        }

        const toType = connectionType === ConnectionType.AGENT
            ? ConnectionType.CUSTOMER
            : ConnectionType.AGENT;

        this.relayTrack(track, stream, connectionType, toType);
    }

    relayTrack(track, stream, fromType, toType) {
        const targetConnection = toType === ConnectionType.AGENT
            ? this.frontendConnection
            : this.customerConnection;

        if (!targetConnection) {
            log.warn(`Target connection missing for ${fromType} → ${toType}`);
            return;
        }

        // Store real track references so mixing relays can restore direct wires on deactivation.
        if (fromType === ConnectionType.AGENT) {
            this._agentTrack = track;

            // When a new AGENT track arrives (agent reconnected), refresh the monitor's
            // agent audio sender so the manager's audio is restored without closing the modal.
            if (this.monitorConnection) {
                this._refreshAgentTrackInMonitor(track);
            }

            // In barge mode the WhatsApp relay's RTCAudioSink was bound to the previous
            // (now-ended) AGENT track.  Rebuild it so the customer still hears the mix.
            if (this._customerMixingRelay && toType === ConnectionType.CUSTOMER) {
                this._rebuildCustomerRelay(track);
                return; // relay output is already on the customer sender — skip deliverTrack
            }
        }

        if (fromType === ConnectionType.CUSTOMER) {
            this._customerTrack = track;
            if (!this._silenceWatchdog || this._silenceWatchdog.trackId !== track.id) {
                if (this._silenceWatchdog) this._silenceWatchdog.destroy();
                try {
                    this._silenceWatchdog = new CustomerSilenceWatchdog(track, this.callId, (callId, state) => {
                        EventBus.emit('customer:media:state', { callId, state });
                    });
                } catch (err) {
                    log.error({ callId: this.callId, err }, 'CustomerSilenceWatchdog failed');
                }
            }
            if (!this._networkMonitor && this.customerConnection?.pc) {
                this._networkMonitor = new CustomerNetworkMonitor(
                    this.customerConnection.pc,
                    this.callId,
                    (callId, quality) => EventBus.emit('call:network:quality:customer', { callId, ...quality })
                );
                this._networkMonitor.start();
            }
        }

        log.debug({ callId: this.callId, from: fromType, to: toType, trackId: track.id }, 'Relaying track');
        targetConnection.deliverTrack(track, stream);
        this.stats.tracksRelayed++;

        // If the agent was whispering privately (muted to the customer) before the
        // reconnect, the deliverTrack above just un-muted them.  Re-apply the silence
        // track so the customer does not accidentally hear the agent.
        if (fromType === ConnectionType.AGENT && this._agentPrivate) {
            this._reapplyAgentPrivate(); // async fire-and-forget — see method below
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // LIFECYCLE
    // ─────────────────────────────────────────────────────────────────

    async startBridging() {
        if (this.isActive) return;

        this.isActive = true;
        this.stats.bridgeStartTime = new Date();

        const wPC = this.customerConnection?.pc;
        const fPC = this.frontendConnection?.pc;

        // Log both peer connection states at bridge activation — if either leg is not
        // truly 'connected' here, media will not flow even though the bridge is "active".
        log.debug({ callId: this.callId }, `Active: frontend=${fPC?.connectionState}(ice=${fPC?.iceConnectionState}), customer=${wPC?.connectionState}(ice=${wPC?.iceConnectionState})`);

        // Inspect WhatsApp receivers at bridge start. A 'live' track here means the
        // RTP stream from Meta is already flowing; 'ended' or absent means it never
        // arrived — strong signal for the 138021 "no media" root cause.
        // Wrapped in try/catch: wrtc throws "Invalid argument" in some native edge
        // cases during peer connection state transitions (Pattern A race condition).
        try {
            const waReceivers = (wPC?.getReceivers() ?? []).filter(r => r.track?.kind === 'audio');
            if (waReceivers.length === 0) {
                log.warn({ callId: this.callId }, 'No customer audio receivers at bridge start');
            } else {
                const detail = waReceivers.map(r =>
                    `${r.track.id}(${r.track.readyState},muted=${r.track.muted})`
                ).join(', ');
                log.debug({ callId: this.callId }, `Customer audio receivers at bridge start: ${detail}`);
            }
        } catch (err) {
            log.warn({ callId: this.callId, err }, 'getReceivers diagnostic skipped');
        }
    }

    stopBridging() {
        if (!this.isActive) return;

        const durationSec = this.stats.bridgeStartTime
            ? Math.round((Date.now() - this.stats.bridgeStartTime.getTime()) / 1000)
            : '?';
        log.info({ callId: this.callId }, `Stopped — bridge_duration=${durationSec}s, tracks_relayed=${this.stats.tracksRelayed}`);

        this.isActive = false;
        this.monitorConnection = null;
        this.frontendTracks = [];
        this.customerTracks = [];

        if (this._silenceWatchdog) {
            this._silenceWatchdog.destroy();
            this._silenceWatchdog = null;
        }

        if (this._networkMonitor) {
            this._networkMonitor.stop();
            this._networkMonitor = null;
        }

        this._teardownSupervisor();
    }

    // ─────────────────────────────────────────────────────────────────
    // SUPERVISOR MODE (listen / whisper / barge)
    // ─────────────────────────────────────────────────────────────────

    /**
     * Called when the supervisor's microphone track arrives from the MONITOR
     * peer connection (PeerRegistry routes it here instead of discarding it).
     * Creates a SupervisorCapture and links it to any already-active relays.
     *
     * @param {MediaStreamTrack} track
     */
    setSupervisorTrack(track) {
        if (this._supervisorCapture) {
            this._supervisorCapture.destroy();
        }
        try {
            this._supervisorCapture = new SupervisorCapture(track);
        } catch (err) {
            log.error({ callId: this.callId, err }, 'SupervisorCapture failed');
            return;
        }
        // Link capture to any mixing relays that were already activated.
        if (this._frontendMixingRelay) this._frontendMixingRelay.setSupervisorCapture(this._supervisorCapture);
        if (this._customerMixingRelay) this._customerMixingRelay.setSupervisorCapture(this._supervisorCapture);
        log.info({ callId: this.callId }, 'Supervisor audio capture started');
    }

    /**
     * Switch supervisor mode mid-call. Activates or deactivates MixingRelay
     * instances on the customer→agent and agent→customer paths as needed.
     * Mode transitions that keep a relay running (whisper↔barge) do not
     * call replaceTrack — only transitions into/out of 'listen' do.
     *
     * @param {'listen'|'whisper'|'barge'} mode
     * @returns {boolean} whether this ended the agent's private reply
     */
    setSupervisorMode(mode) {
        if (this.supervisorMode === mode) return false;

        const prev = this.supervisorMode;
        this.supervisorMode = mode;
        log.info({ callId: this.callId }, `Supervisor mode: ${prev} → ${mode}`);

        // Agent whisper-back only makes sense during whisper; restore the
        // agent→customer wire when leaving whisper so the customer hears the agent.
        const endedPrivate = mode !== 'whisper' && this._agentPrivate;
        if (endedPrivate) this._resetAgentPrivate();

        // Frontend relay (customer→agent path): needed for whisper + barge.
        const needFrontend = mode === 'whisper' || mode === 'barge';
        if (needFrontend && !this._frontendMixingRelay) {
            this._activateFrontendRelay();
        } else if (!needFrontend && this._frontendMixingRelay) {
            this._deactivateFrontendRelay();
        }

        // WhatsApp relay (agent→customer path): needed for barge only.
        if (mode === 'barge' && !this._customerMixingRelay) {
            this._activateCustomerRelay();
        } else if (mode !== 'barge' && this._customerMixingRelay) {
            this._deactivateCustomerRelay();
        }
        return endedPrivate;
    }

    /**
     * Agent whisper-back. When active, mute the agent's audio to the customer by
     * swapping the WhatsApp sender to a silence track; the supervisor keeps
     * hearing the agent through the monitor connection (an independent path).
     * When inactive, restore the agent's track. Honoured only during 'whisper'.
     *
     * @param {boolean} active
     * @returns {Promise<boolean>} the agent-private state after the call
     */
    async setAgentPrivate(active) {
        if (this._agentPrivate === active) return this._agentPrivate;

        if (active && this.supervisorMode !== 'whisper') {
            log.debug({ callId: this.callId }, `Ignoring agent-private (supervisorMode=${this.supervisorMode})`);
            return this._agentPrivate;
        }

        const sender = this.customerConnection?.audio.getActivePlaceholderSender();
        if (!sender) {
            log.warn({ callId: this.callId }, 'No customer sender for agent-private');
            return this._agentPrivate;
        }

        if (active) {
            this._agentPrivate = true;
            try {
                this._agentPrivateSilenceTrack = await placeholderTrackFactory.createTrack('silence');
                if (this._agentPrivateSilenceTrack) sender.replaceTrack(this._agentPrivateSilenceTrack);
            } catch (err) {
                log.error({ callId: this.callId, err }, 'agent-private mute failed');
            }
            log.info({ callId: this.callId }, 'Agent private to supervisor (customer muted)');
        } else {
            this._resetAgentPrivate();
            log.info({ callId: this.callId }, 'Agent-private off (customer hears agent again)');
        }
        return this._agentPrivate;
    }

    get agentPrivate() {
        return this._agentPrivate;
    }

    // ─────────────────────────────────────────────────────────────────
    // SUPERVISOR PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────────────

    // Restore the agent → customer wire and release the silence track. Safe to
    // call when not private (no-op-ish). stopTrack:false — see PlaceholderTrackFactory.
    _resetAgentPrivate() {
        this._agentPrivate = false;
        const sender = this.customerConnection?.audio.getActivePlaceholderSender();
        if (sender && this._agentTrack) {
            try { sender.replaceTrack(this._agentTrack); } catch (err) {
                log.error({ callId: this.callId, err }, 'agent-private restore failed');
            }
        }
        if (this._agentPrivateSilenceTrack) {
            placeholderTrackFactory.releaseGeneratedTrack(this._agentPrivateSilenceTrack, { stopTrack: false });
            this._agentPrivateSilenceTrack = null;
        }
    }

    _activateFrontendRelay() {
        if (!this._customerTrack || !this.frontendConnection) {
            log.warn({ callId: this.callId }, 'Cannot activate frontend relay — no customer track yet');
            return;
        }
        try {
            this._frontendMixingRelay = new MixingRelay(this._customerTrack, 'customer→agent');
        } catch (err) {
            log.error({ callId: this.callId, err }, 'MixingRelay (frontend) creation failed');
            return;
        }
        if (this._supervisorCapture) {
            this._frontendMixingRelay.setSupervisorCapture(this._supervisorCapture);
        }
        const sender = this.frontendConnection.audio.getActivePlaceholderSender();
        if (sender) {
            try { sender.replaceTrack(this._frontendMixingRelay.outputTrack); } catch (err) {
                log.error({ callId: this.callId, err }, 'replaceTrack (frontend relay on) failed');
            }
        }
        log.debug({ callId: this.callId }, 'Frontend mixing relay activated');
    }

    _deactivateFrontendRelay() {
        const relay = this._frontendMixingRelay;
        this._frontendMixingRelay = null;
        if (relay) {
            const sender = this.frontendConnection?.audio.getActivePlaceholderSender();
            if (sender && this._customerTrack) {
                try { sender.replaceTrack(this._customerTrack); } catch (err) {
                    log.error({ callId: this.callId, err }, 'replaceTrack (frontend relay off) failed');
                }
            }
            relay.destroy();
        }
        log.debug({ callId: this.callId }, 'Frontend mixing relay deactivated');
    }

    _activateCustomerRelay() {
        if (!this._agentTrack || !this.customerConnection) {
            log.warn({ callId: this.callId }, 'Cannot activate customer relay — no agent track yet');
            return;
        }
        try {
            this._customerMixingRelay = new MixingRelay(this._agentTrack, 'agent→customer');
        } catch (err) {
            log.error({ callId: this.callId, err }, 'MixingRelay (customer) creation failed');
            return;
        }
        if (this._supervisorCapture) {
            this._customerMixingRelay.setSupervisorCapture(this._supervisorCapture);
        }
        const sender = this.customerConnection.audio.getActivePlaceholderSender();
        if (sender) {
            try { sender.replaceTrack(this._customerMixingRelay.outputTrack); } catch (err) {
                log.error({ callId: this.callId, err }, 'replaceTrack (customer relay on) failed');
            }
        }
        log.debug({ callId: this.callId }, 'Customer mixing relay activated');
    }

    _deactivateCustomerRelay() {
        const relay = this._customerMixingRelay;
        this._customerMixingRelay = null;
        if (relay) {
            const sender = this.customerConnection?.audio.getActivePlaceholderSender();
            if (sender && this._agentTrack) {
                try { sender.replaceTrack(this._agentTrack); } catch (err) {
                    log.error({ callId: this.callId, err }, 'replaceTrack (customer relay off) failed');
                }
            }
            relay.destroy();
        }
        log.debug({ callId: this.callId }, 'Customer mixing relay deactivated');
    }

    _teardownSupervisor() {
        // Force mode back to listen first so deactivation paths run cleanly.
        const prev = this.supervisorMode;
        this.supervisorMode = 'listen';

        // Restore the agent→customer wire if the agent was whispering back.
        if (this._agentPrivate || this._agentPrivateSilenceTrack) this._resetAgentPrivate();

        if (this._frontendMixingRelay) this._deactivateFrontendRelay();
        if (this._customerMixingRelay) this._deactivateCustomerRelay();

        if (this._supervisorCapture) {
            this._supervisorCapture.destroy();
            this._supervisorCapture = null;
        }

        this._agentTrack = null;
        this._customerTrack = null;

        if (prev !== 'listen') {
            log.info({ callId: this.callId }, `Supervisor teardown complete (was ${prev})`);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────────────

    _relayCustomerTrackToFrontend() {
        if (!this.customerConnection?.pc || !this.frontendConnection?.pc) return;

        let receivers = [];
        try { receivers = this.customerConnection.pc.getReceivers(); } catch (err) {
            log.warn({ callId: this.callId, err }, 'getReceivers in _relayCustomerTrackToFrontend failed');
        }

        for (const receiver of receivers) {
            if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
                const track = receiver.track;
                this._customerTrack = track; // always keep reference current

                if (this._frontendMixingRelay) {
                    // Whisper/barge mode: rebuild the relay targeting the new AGENT sender.
                    this._rebuildFrontendRelay(track);
                } else {
                    log.debug({ callId: this.callId, trackId: track.id }, 'Re-relaying the customer track to the new frontend');
                    this.relayTrack(track, null, ConnectionType.CUSTOMER, ConnectionType.AGENT);
                }
                return;
            }
        }

        log.warn({ callId: this.callId }, 'No live customer track to relay to new frontend');
    }

    _processBufferedTracks() {
        const frontendBuffer = this.frontendConnection?.audio?.trackBuffer ?? [];
        const customerBuffer = this.customerConnection?.audio?.trackBuffer ?? [];

        if (frontendBuffer.length > 0) {
            log.debug({ callId: this.callId }, `Flushing ${frontendBuffer.length} buffered frontend tracks`);
            frontendBuffer.forEach(({ track, stream }) => {
                this.relayTrack(track, stream, ConnectionType.AGENT, ConnectionType.CUSTOMER);
            });
            this.customerTracks.forEach(({ track, stream }) => {
                this.relayTrack(track, stream, ConnectionType.CUSTOMER, ConnectionType.AGENT);
            });
            this.frontendTracks = [...frontendBuffer];
            this.frontendConnection.audio.clearTrackBuffer();
        }

        if (customerBuffer.length > 0) {
            log.debug({ callId: this.callId }, `Flushing ${customerBuffer.length} buffered customer tracks`);
            customerBuffer.forEach(({ track, stream }) => {
                this.relayTrack(track, stream, ConnectionType.CUSTOMER, ConnectionType.AGENT);
            });
            this.frontendTracks.forEach(({ track, stream }) => {
                this.relayTrack(track, stream, ConnectionType.AGENT, ConnectionType.CUSTOMER);
            });
            this.customerTracks = [...customerBuffer];
            this.customerConnection.audio.clearTrackBuffer();
        }
    }

    _relayExistingTracksToMonitor() {
        if (!this.monitorConnection) return;

        log.info({ callId: this.callId }, 'Relaying existing tracks to monitor');

        // Agent audio first (track index 0), then customer (track index 1).
        if (this.frontendConnection?.pc) {
            let fReceivers = [];
            try { fReceivers = this.frontendConnection.pc.getReceivers(); } catch (err) {
                log.warn({ err }, 'frontend getReceivers in _relayExistingTracksToMonitor failed');
            }
            fReceivers.forEach(receiver => {
                if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
                    this._relayTrackToMonitor(receiver.track, 'agent');
                }
            });
        }

        if (this.customerConnection?.pc) {
            let customerReceivers = [];
            try { customerReceivers = this.customerConnection.pc.getReceivers(); } catch (err) {
                log.warn({ err }, 'customer getReceivers in _relayExistingTracksToMonitor failed');
            }
            customerReceivers.forEach(receiver => {
                if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
                    this._relayTrackToMonitor(receiver.track, 'customer');
                }
            });
        }
    }

    _relayTrackToMonitor(track, label = 'unknown') {
        if (!this.monitorConnection || !track) return;

        let alreadySending = false;
        try {
            alreadySending = this.monitorConnection.pc.getSenders().some(s => s.track?.id === track.id);
        } catch (err) {
            log.warn({ callId: this.callId, err }, 'getSenders in _relayTrackToMonitor failed');
        }

        if (alreadySending) {
            log.debug({ callId: this.callId, trackId: track.id }, 'Monitor track already sending — skipping');
            return;
        }

        this.monitorConnection.deliverMonitorTrack(track);
        this.stats.tracksRelayed++;
        log.debug({ callId: this.callId, leg: label.toUpperCase(), trackId: track.id }, 'Monitor track relayed');
    }

    // ─────────────────────────────────────────────────────────────────
    // RECONNECT HELPERS  (called when the AGENT peer is replaced)
    // ─────────────────────────────────────────────────────────────────

    // Replace the monitor's agent-audio sender with a new track.
    // Called from relayTrack() whenever a AGENT track arrives while a
    // MONITOR connection is active, so audio resumes without closing the modal.
    _refreshAgentTrackInMonitor(agentTrack) {
        if (!this.monitorConnection?.pc || !agentTrack) return;

        let senders;
        try { senders = this.monitorConnection.pc.getSenders(); } catch (err) {
            log.warn({ callId: this.callId, err }, 'getSenders failed in _refreshAgentTrackInMonitor');
            return;
        }

        // Agent is always the first audio sender on the monitor connection
        // (_relayExistingTracksToMonitor relays AGENT first, then CUSTOMER).
        const agentSender = senders.find(s => s.track !== null);
        if (!agentSender) {
            log.warn({ callId: this.callId }, 'No active monitor sender to refresh the agent track');
            return;
        }

        try {
            agentSender.replaceTrack(agentTrack);
            // Notify clients: the manager gets a toast; the agent's supervisor-mode badge
            // and private-whisper-back state are re-broadcast via serverListeners.
            EventBus.emit('call:monitor:agent:reconnected', {
                callId: this.callId,
                supervisorMode: this.supervisorMode,
                agentPrivate: this._agentPrivate,
            });
            log.debug({ callId: this.callId, trackId: agentTrack.id }, 'Monitor agent track refreshed');
        } catch (err) {
            log.error({ callId: this.callId, err }, 'Monitor agent track refresh failed');
        }
    }

    // Re-apply the agent-private mute (silence to customer) after a AGENT reconnect.
    // After deliverTrack() puts the new live agent track on the WhatsApp sender the
    // customer would briefly hear the agent again — this restores the mute immediately.
    // Async because createTrack() must allocate a native RTCAudioSource.
    async _reapplyAgentPrivate() {
        if (!this._agentPrivate) return; // might have been cleared between call and exec
        const sender = this.customerConnection?.audio.getActivePlaceholderSender();
        if (!sender) return;
        try {
            const silenceTrack = await placeholderTrackFactory.createTrack('silence');
            if (!silenceTrack || !this._agentPrivate) return; // guard: state may have changed
            // Release the previous silence track before replacing it.
            if (this._agentPrivateSilenceTrack) {
                placeholderTrackFactory.releaseGeneratedTrack(this._agentPrivateSilenceTrack, { stopTrack: false });
            }
            this._agentPrivateSilenceTrack = silenceTrack;
            const currentSender = this.customerConnection?.audio.getActivePlaceholderSender();
            if (currentSender) currentSender.replaceTrack(silenceTrack);
            log.info({ callId: this.callId }, 'Agent-private mute re-applied after reconnect');
        } catch (err) {
            log.error({ callId: this.callId, err }, '_reapplyAgentPrivate failed');
        }
    }

    // Rebuild the frontend mixing relay (customer→agent path) for a new AGENT
    // connection.  Used when supervisorMode is whisper or barge and the agent reconnects.
    _rebuildFrontendRelay(customerTrack) {
        const oldRelay = this._frontendMixingRelay;
        this._frontendMixingRelay = null;
        try {
            const newRelay = new MixingRelay(customerTrack, 'customer→agent');
            if (this._supervisorCapture) newRelay.setSupervisorCapture(this._supervisorCapture);
            if (this.frontendConnection) {
                this.frontendConnection.deliverTrack(newRelay.outputTrack, null);
            }
            this._frontendMixingRelay = newRelay;
            log.debug({ callId: this.callId }, 'Frontend mixing relay rebuilt after AGENT reconnect');
        } catch (err) {
            log.error({ callId: this.callId, err }, 'Frontend relay rebuild failed');
            if (this.frontendConnection) this.frontendConnection.deliverTrack(customerTrack, null);
        } finally {
            if (oldRelay) oldRelay.destroy();
        }
    }

    // Rebuild the Customer mixing relay (agent→customer path) for a new agent track.
    // Used when supervisorMode is barge and the agent reconnects with a new AGENT.
    _rebuildCustomerRelay(agentTrack) {
        const oldRelay = this._customerMixingRelay;
        this._customerMixingRelay = null;
        try {
            const newRelay = new MixingRelay(agentTrack, 'agent→customer');
            if (this._supervisorCapture) newRelay.setSupervisorCapture(this._supervisorCapture);
            const sender = this.customerConnection?.audio.getActivePlaceholderSender();
            if (sender) {
                sender.replaceTrack(newRelay.outputTrack);
            }
            this._customerMixingRelay = newRelay;
            log.debug({ callId: this.callId }, 'Customer mixing relay rebuilt after AGENT reconnect');
        } catch (err) {
            log.error({ callId: this.callId, err }, 'Customer relay rebuild failed');
            if (this.customerConnection) this.customerConnection.deliverTrack(agentTrack, null);
        } finally {
            if (oldRelay) oldRelay.destroy();
        }
    }
}
