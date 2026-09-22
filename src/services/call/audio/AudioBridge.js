// services/call/audio/AudioBridge.js
//
// Single responsibility: relay audio tracks between a FRONTEND and a WHATSAPP
// peer connection for one active call, and optionally to a MONITOR connection.
//
// Track delivery to peers is delegated to Peer.deliverTrack / deliverMonitorTrack —
// this class never reaches into peer audio-state directly.
import { ConnectionType } from '../constants/CallConstants.js';
import { leakMetrics } from '../../monitoring/leakMetrics.js';
import { MixingRelay } from './bridge/MixingRelay.js';
import { SupervisorCapture } from './bridge/SupervisorCapture.js';
import { placeholderTrackFactory } from './PlaceholderTrackFactory.js';
import { CustomerSilenceWatchdog } from './bridge/CustomerSilenceWatchdog.js';
import { CustomerNetworkMonitor } from './bridge/CustomerNetworkMonitor.js';
import EventBus from '../../core/EventBus.js';

export class AudioBridge {
    constructor(callId) {
        this.callId = callId;
        this.whatsappConnection = null;
        this.frontendConnection = null;
        this.monitorConnection = null;

        this.frontendTracks = [];
        this.whatsappTracks = [];

        this.isActive = false;
        this.stats = {
            bridgeStartTime: null,
            tracksRelayed: 0,
        };

        // Supervisor feature state
        this.supervisorMode = 'listen';         // 'listen' | 'whisper' | 'barge'
        this._supervisorCapture = null;         // SupervisorCapture — set when supervisor mic arrives
        this._frontendMixingRelay = null;       // MixingRelay: customer→agent path (whisper + barge)
        this._whatsappMixingRelay = null;       // MixingRelay: agent→customer path (barge only)
        this._agentTrack = null;                // agent's received track (from FRONTEND receiver)
        this._customerTrack = null;             // customer's received track (from WHATSAPP receiver)

        // Agent whisper-back: mute agent → customer while the supervisor (who hears
        // the agent via the monitor connection) keeps hearing them.
        this._agentPrivate = false;
        this._agentPrivateSilenceTrack = null;

        this._silenceWatchdog = null;
        this._networkMonitor = null;

        console.log(`[AudioBridge] Created for call ${this.callId}`);
    }

    // ─────────────────────────────────────────────────────────────────
    // CONNECTIONS
    // ─────────────────────────────────────────────────────────────────

    setConnections(whatsappConn, frontendConn) {
        if (!frontendConn || frontendConn.pc.connectionState === 'closed') {
            console.error(`[AudioBridge] Cannot set closed frontend connection for call ${this.callId}`);
            return false;
        }

        if (!whatsappConn || whatsappConn.pc.connectionState === 'closed') {
            console.error(`[AudioBridge] Cannot set closed WhatsApp connection for call ${this.callId}`);
            return false;
        }

        this.whatsappConnection = whatsappConn;
        this.frontendConnection = frontendConn;

        console.log(`[AudioBridge] Connections set for call ${this.callId} — frontend: ${frontendConn.pc.connectionState}, whatsapp: ${whatsappConn.pc.connectionState}`);

        // Re-relay any live WhatsApp track to the (possibly new) frontend connection.
        this._relayWhatsAppTrackToFrontend();

        // Flush any tracks that arrived before both connections were ready.
        this._processBufferedTracks();

        return true;
    }

    addMonitor(monitorConnection) {
        if (!monitorConnection || monitorConnection.pc.connectionState === 'closed') {
            console.error(`[AudioBridge] Cannot add closed monitor for call ${this.callId}`);
            return false;
        }

        this.monitorConnection = monitorConnection;
        console.log(`[AudioBridge] Monitor added to call ${this.callId}`);

        // Stop placeholder tone intervals on the monitor; real tracks will replace them.
        let monitorSenders = [];
        try { monitorSenders = monitorConnection.pc.getSenders(); } catch (err) {
            console.warn(`[AudioBridge] getSenders in addMonitor failed for call ${this.callId}: ${err.message}`);
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
            console.log(`[AudioBridge] Monitor removed from call ${this.callId}`);
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
            console.log(`[AudioBridge] Bridge not active, discarding ${connectionType} track`);
            return;
        }

        const toType = connectionType === ConnectionType.FRONTEND
            ? ConnectionType.WHATSAPP
            : ConnectionType.FRONTEND;

        this.relayTrack(track, stream, connectionType, toType);
    }

    relayTrack(track, stream, fromType, toType) {
        const targetConnection = toType === ConnectionType.FRONTEND
            ? this.frontendConnection
            : this.whatsappConnection;

        if (!targetConnection) {
            console.warn(`[AudioBridge] Target connection missing for ${fromType} → ${toType}`);
            return;
        }

        // Store real track references so mixing relays can restore direct wires on deactivation.
        if (fromType === ConnectionType.FRONTEND) {
            this._agentTrack = track;

            // When a new FRONTEND track arrives (agent reconnected), refresh the monitor's
            // agent audio sender so the manager's audio is restored without closing the modal.
            if (this.monitorConnection) {
                this._refreshAgentTrackInMonitor(track);
            }

            // In barge mode the WhatsApp relay's RTCAudioSink was bound to the previous
            // (now-ended) FRONTEND track.  Rebuild it so the customer still hears the mix.
            if (this._whatsappMixingRelay && toType === ConnectionType.WHATSAPP) {
                this._rebuildWhatsappRelay(track);
                return; // relay output is already on the WhatsApp sender — skip deliverTrack
            }
        }

        if (fromType === ConnectionType.WHATSAPP) {
            this._customerTrack = track;
            if (!this._silenceWatchdog || this._silenceWatchdog.trackId !== track.id) {
                if (this._silenceWatchdog) this._silenceWatchdog.destroy();
                try {
                    this._silenceWatchdog = new CustomerSilenceWatchdog(track, this.callId, (callId, state) => {
                        EventBus.emit('customer:media:state', { callId, state });
                    });
                } catch (err) {
                    console.error(`[AudioBridge] CustomerSilenceWatchdog failed for call ${this.callId}: ${err.message}`);
                }
            }
            if (!this._networkMonitor && this.whatsappConnection?.pc) {
                this._networkMonitor = new CustomerNetworkMonitor(
                    this.whatsappConnection.pc,
                    this.callId,
                    (callId, quality) => EventBus.emit('call:network:quality:customer', { callId, ...quality })
                );
                this._networkMonitor.start();
            }
        }

        console.log(`[AudioBridge] Relay ${fromType} → ${toType}, track=${track.id}`);
        targetConnection.deliverTrack(track, stream);
        this.stats.tracksRelayed++;

        // If the agent was whispering privately (muted to the customer) before the
        // reconnect, the deliverTrack above just un-muted them.  Re-apply the silence
        // track so the customer does not accidentally hear the agent.
        if (fromType === ConnectionType.FRONTEND && this._agentPrivate) {
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

        const wPC = this.whatsappConnection?.pc;
        const fPC = this.frontendConnection?.pc;

        // Log both peer connection states at bridge activation — if either leg is not
        // truly 'connected' here, media will not flow even though the bridge is "active".
        console.log(
            `[AudioBridge] Active for call ${this.callId}: ` +
            `frontend=${fPC?.connectionState}(ice=${fPC?.iceConnectionState}), ` +
            `whatsapp=${wPC?.connectionState}(ice=${wPC?.iceConnectionState})`
        );

        // Inspect WhatsApp receivers at bridge start. A 'live' track here means the
        // RTP stream from Meta is already flowing; 'ended' or absent means it never
        // arrived — strong signal for the 138021 "no media" root cause.
        // Wrapped in try/catch: wrtc throws "Invalid argument" in some native edge
        // cases during peer connection state transitions (Pattern A race condition).
        try {
            const waReceivers = (wPC?.getReceivers() ?? []).filter(r => r.track?.kind === 'audio');
            if (waReceivers.length === 0) {
                console.warn(`[AudioBridge] ⚠️ No WA audio receivers at bridge start for call ${this.callId}`);
            } else {
                const detail = waReceivers.map(r =>
                    `${r.track.id}(${r.track.readyState},muted=${r.track.muted})`
                ).join(', ');
                console.log(`[AudioBridge] WA audio receivers at bridge start for call ${this.callId}: ${detail}`);
            }
        } catch (err) {
            console.warn(`[AudioBridge] getReceivers diagnostic skipped for call ${this.callId}: ${err.message}`);
        }
    }

    stopBridging() {
        if (!this.isActive) return;

        const durationSec = this.stats.bridgeStartTime
            ? Math.round((Date.now() - this.stats.bridgeStartTime.getTime()) / 1000)
            : '?';
        console.log(
            `[AudioBridge] Stopped for call ${this.callId} — ` +
            `bridge_duration=${durationSec}s, tracks_relayed=${this.stats.tracksRelayed}`
        );

        this.isActive = false;
        this.monitorConnection = null;
        this.frontendTracks = [];
        this.whatsappTracks = [];

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
            console.error(`[AudioBridge] SupervisorCapture failed for call ${this.callId}: ${err.message}`);
            return;
        }
        // Link capture to any mixing relays that were already activated.
        if (this._frontendMixingRelay) this._frontendMixingRelay.setSupervisorCapture(this._supervisorCapture);
        if (this._whatsappMixingRelay) this._whatsappMixingRelay.setSupervisorCapture(this._supervisorCapture);
        console.log(`[AudioBridge] Supervisor audio capture started for call ${this.callId}`);
    }

    /**
     * Switch supervisor mode mid-call. Activates or deactivates MixingRelay
     * instances on the customer→agent and agent→customer paths as needed.
     * Mode transitions that keep a relay running (whisper↔barge) do not
     * call replaceTrack — only transitions into/out of 'listen' do.
     *
     * @param {'listen'|'whisper'|'barge'} mode
     */
    setSupervisorMode(mode) {
        if (this.supervisorMode === mode) return;

        const prev = this.supervisorMode;
        this.supervisorMode = mode;
        console.log(`[AudioBridge] Supervisor mode: ${prev} → ${mode} for call ${this.callId}`);

        // Agent whisper-back only makes sense during whisper; restore the
        // agent→customer wire when leaving whisper so the customer hears the agent.
        if (mode !== 'whisper' && this._agentPrivate) {
            this._resetAgentPrivate();
        }

        // Frontend relay (customer→agent path): needed for whisper + barge.
        const needFrontend = mode === 'whisper' || mode === 'barge';
        if (needFrontend && !this._frontendMixingRelay) {
            this._activateFrontendRelay();
        } else if (!needFrontend && this._frontendMixingRelay) {
            this._deactivateFrontendRelay();
        }

        // WhatsApp relay (agent→customer path): needed for barge only.
        if (mode === 'barge' && !this._whatsappMixingRelay) {
            this._activateWhatsappRelay();
        } else if (mode !== 'barge' && this._whatsappMixingRelay) {
            this._deactivateWhatsappRelay();
        }
    }

    /**
     * Agent whisper-back. When active, mute the agent's audio to the customer by
     * swapping the WhatsApp sender to a silence track; the supervisor keeps
     * hearing the agent through the monitor connection (an independent path).
     * When inactive, restore the agent's track. Honoured only during 'whisper'.
     *
     * @param {boolean} active
     */
    async setAgentPrivate(active) {
        if (this._agentPrivate === active) return;

        if (active && this.supervisorMode !== 'whisper') {
            console.log(`[AudioBridge] Ignoring agent-private (supervisorMode=${this.supervisorMode}) for call ${this.callId}`);
            return;
        }

        const sender = this.whatsappConnection?.audio.getActivePlaceholderSender();
        if (!sender) {
            console.warn(`[AudioBridge] No WhatsApp sender for agent-private on call ${this.callId}`);
            return;
        }

        if (active) {
            this._agentPrivate = true;
            try {
                this._agentPrivateSilenceTrack = await placeholderTrackFactory.createTrack('silence');
                if (this._agentPrivateSilenceTrack) sender.replaceTrack(this._agentPrivateSilenceTrack);
            } catch (err) {
                console.error(`[AudioBridge] agent-private mute failed for call ${this.callId}: ${err.message}`);
            }
            console.log(`[AudioBridge] Agent private to supervisor (customer muted) for call ${this.callId}`);
        } else {
            this._resetAgentPrivate();
            console.log(`[AudioBridge] Agent-private off (customer hears agent again) for call ${this.callId}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // SUPERVISOR PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────────────

    // Restore the agent → customer wire and release the silence track. Safe to
    // call when not private (no-op-ish). stopTrack:false — see PlaceholderTrackFactory.
    _resetAgentPrivate() {
        this._agentPrivate = false;
        const sender = this.whatsappConnection?.audio.getActivePlaceholderSender();
        if (sender && this._agentTrack) {
            try { sender.replaceTrack(this._agentTrack); } catch (err) {
                console.error(`[AudioBridge] agent-private restore failed for call ${this.callId}: ${err.message}`);
            }
        }
        if (this._agentPrivateSilenceTrack) {
            placeholderTrackFactory.releaseGeneratedTrack(this._agentPrivateSilenceTrack, { stopTrack: false });
            this._agentPrivateSilenceTrack = null;
        }
    }

    _activateFrontendRelay() {
        if (!this._customerTrack || !this.frontendConnection) {
            console.warn(`[AudioBridge] Cannot activate frontend relay — no customer track yet for call ${this.callId}`);
            return;
        }
        try {
            this._frontendMixingRelay = new MixingRelay(this._customerTrack, 'customer→agent');
        } catch (err) {
            console.error(`[AudioBridge] MixingRelay (frontend) creation failed for call ${this.callId}: ${err.message}`);
            return;
        }
        if (this._supervisorCapture) {
            this._frontendMixingRelay.setSupervisorCapture(this._supervisorCapture);
        }
        const sender = this.frontendConnection.audio.getActivePlaceholderSender();
        if (sender) {
            try { sender.replaceTrack(this._frontendMixingRelay.outputTrack); } catch (err) {
                console.error(`[AudioBridge] replaceTrack (frontend relay on) failed for call ${this.callId}: ${err.message}`);
            }
        }
        console.log(`[AudioBridge] Frontend mixing relay activated for call ${this.callId}`);
    }

    _deactivateFrontendRelay() {
        const relay = this._frontendMixingRelay;
        this._frontendMixingRelay = null;
        if (relay) {
            const sender = this.frontendConnection?.audio.getActivePlaceholderSender();
            if (sender && this._customerTrack) {
                try { sender.replaceTrack(this._customerTrack); } catch (err) {
                    console.error(`[AudioBridge] replaceTrack (frontend relay off) failed for call ${this.callId}: ${err.message}`);
                }
            }
            relay.destroy();
        }
        console.log(`[AudioBridge] Frontend mixing relay deactivated for call ${this.callId}`);
    }

    _activateWhatsappRelay() {
        if (!this._agentTrack || !this.whatsappConnection) {
            console.warn(`[AudioBridge] Cannot activate WhatsApp relay — no agent track yet for call ${this.callId}`);
            return;
        }
        try {
            this._whatsappMixingRelay = new MixingRelay(this._agentTrack, 'agent→customer');
        } catch (err) {
            console.error(`[AudioBridge] MixingRelay (whatsapp) creation failed for call ${this.callId}: ${err.message}`);
            return;
        }
        if (this._supervisorCapture) {
            this._whatsappMixingRelay.setSupervisorCapture(this._supervisorCapture);
        }
        const sender = this.whatsappConnection.audio.getActivePlaceholderSender();
        if (sender) {
            try { sender.replaceTrack(this._whatsappMixingRelay.outputTrack); } catch (err) {
                console.error(`[AudioBridge] replaceTrack (whatsapp relay on) failed for call ${this.callId}: ${err.message}`);
            }
        }
        console.log(`[AudioBridge] WhatsApp mixing relay activated for call ${this.callId}`);
    }

    _deactivateWhatsappRelay() {
        const relay = this._whatsappMixingRelay;
        this._whatsappMixingRelay = null;
        if (relay) {
            const sender = this.whatsappConnection?.audio.getActivePlaceholderSender();
            if (sender && this._agentTrack) {
                try { sender.replaceTrack(this._agentTrack); } catch (err) {
                    console.error(`[AudioBridge] replaceTrack (whatsapp relay off) failed for call ${this.callId}: ${err.message}`);
                }
            }
            relay.destroy();
        }
        console.log(`[AudioBridge] WhatsApp mixing relay deactivated for call ${this.callId}`);
    }

    _teardownSupervisor() {
        // Force mode back to listen first so deactivation paths run cleanly.
        const prev = this.supervisorMode;
        this.supervisorMode = 'listen';

        // Restore the agent→customer wire if the agent was whispering back.
        if (this._agentPrivate || this._agentPrivateSilenceTrack) this._resetAgentPrivate();

        if (this._frontendMixingRelay) this._deactivateFrontendRelay();
        if (this._whatsappMixingRelay) this._deactivateWhatsappRelay();

        if (this._supervisorCapture) {
            this._supervisorCapture.destroy();
            this._supervisorCapture = null;
        }

        this._agentTrack = null;
        this._customerTrack = null;

        if (prev !== 'listen') {
            console.log(`[AudioBridge] Supervisor teardown complete for call ${this.callId} (was ${prev})`);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────────────

    _relayWhatsAppTrackToFrontend() {
        if (!this.whatsappConnection?.pc || !this.frontendConnection?.pc) return;

        let receivers = [];
        try { receivers = this.whatsappConnection.pc.getReceivers(); } catch (err) {
            console.warn(`[AudioBridge] getReceivers in _relayWhatsAppTrackToFrontend failed for call ${this.callId}: ${err.message}`);
        }

        for (const receiver of receivers) {
            if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
                const track = receiver.track;
                this._customerTrack = track; // always keep reference current

                if (this._frontendMixingRelay) {
                    // Whisper/barge mode: rebuild the relay targeting the new FRONTEND sender.
                    this._rebuildFrontendRelay(track);
                } else {
                    console.log(`[AudioBridge] Re-relaying WhatsApp track to new frontend for call ${this.callId}: ${track.id}`);
                    this.relayTrack(track, null, ConnectionType.WHATSAPP, ConnectionType.FRONTEND);
                }
                return;
            }
        }

        console.warn(`[AudioBridge] No live WhatsApp track to relay to new frontend for call ${this.callId}`);
    }

    _processBufferedTracks() {
        const frontendBuffer = this.frontendConnection?.audio?.trackBuffer ?? [];
        const whatsappBuffer = this.whatsappConnection?.audio?.trackBuffer ?? [];

        if (frontendBuffer.length > 0) {
            console.log(`[AudioBridge] Flushing ${frontendBuffer.length} buffered frontend tracks for call ${this.callId}`);
            frontendBuffer.forEach(({ track, stream }) => {
                this.relayTrack(track, stream, ConnectionType.FRONTEND, ConnectionType.WHATSAPP);
            });
            this.whatsappTracks.forEach(({ track, stream }) => {
                this.relayTrack(track, stream, ConnectionType.WHATSAPP, ConnectionType.FRONTEND);
            });
            this.frontendTracks = [...frontendBuffer];
            this.frontendConnection.audio.clearTrackBuffer();
        }

        if (whatsappBuffer.length > 0) {
            console.log(`[AudioBridge] Flushing ${whatsappBuffer.length} buffered WhatsApp tracks for call ${this.callId}`);
            whatsappBuffer.forEach(({ track, stream }) => {
                this.relayTrack(track, stream, ConnectionType.WHATSAPP, ConnectionType.FRONTEND);
            });
            this.frontendTracks.forEach(({ track, stream }) => {
                this.relayTrack(track, stream, ConnectionType.FRONTEND, ConnectionType.WHATSAPP);
            });
            this.whatsappTracks = [...whatsappBuffer];
            this.whatsappConnection.audio.clearTrackBuffer();
        }
    }

    _relayExistingTracksToMonitor() {
        if (!this.monitorConnection) return;

        console.log(`[AudioBridge] Relaying existing tracks to monitor for call ${this.callId}`);

        // Agent audio first (track index 0), then customer (track index 1).
        if (this.frontendConnection?.pc) {
            let fReceivers = [];
            try { fReceivers = this.frontendConnection.pc.getReceivers(); } catch (err) {
                console.warn(`[AudioBridge] frontend getReceivers in _relayExistingTracksToMonitor failed: ${err.message}`);
            }
            fReceivers.forEach(receiver => {
                if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
                    this._relayTrackToMonitor(receiver.track, 'agent');
                }
            });
        }

        if (this.whatsappConnection?.pc) {
            let wReceivers = [];
            try { wReceivers = this.whatsappConnection.pc.getReceivers(); } catch (err) {
                console.warn(`[AudioBridge] whatsapp getReceivers in _relayExistingTracksToMonitor failed: ${err.message}`);
            }
            wReceivers.forEach(receiver => {
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
            console.warn(`[AudioBridge] getSenders in _relayTrackToMonitor failed for call ${this.callId}: ${err.message}`);
        }

        if (alreadySending) {
            console.log(`[AudioBridge] Monitor track ${track.id} already sending, skipping`);
            return;
        }

        this.monitorConnection.deliverMonitorTrack(track);
        this.stats.tracksRelayed++;
        console.log(`[AudioBridge] Monitor track relayed: ${label.toUpperCase()} (${track.id})`);
    }

    // ─────────────────────────────────────────────────────────────────
    // RECONNECT HELPERS  (called when the FRONTEND peer is replaced)
    // ─────────────────────────────────────────────────────────────────

    // Replace the monitor's agent-audio sender with a new track.
    // Called from relayTrack() whenever a FRONTEND track arrives while a
    // MONITOR connection is active, so audio resumes without closing the modal.
    _refreshAgentTrackInMonitor(agentTrack) {
        if (!this.monitorConnection?.pc || !agentTrack) return;

        let senders;
        try { senders = this.monitorConnection.pc.getSenders(); } catch (err) {
            console.warn(`[AudioBridge] getSenders failed in _refreshAgentTrackInMonitor for call ${this.callId}: ${err.message}`);
            return;
        }

        // Agent is always the first audio sender on the monitor connection
        // (_relayExistingTracksToMonitor relays FRONTEND first, then WHATSAPP).
        const agentSender = senders.find(s => s.track !== null);
        if (!agentSender) {
            console.warn(`[AudioBridge] No active monitor sender to refresh agent track — call ${this.callId}`);
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
            console.log(`[AudioBridge] ✓ Monitor agent track refreshed for call ${this.callId}: ${agentTrack.id}`);
        } catch (err) {
            console.error(`[AudioBridge] Monitor agent track refresh failed for call ${this.callId}: ${err.message}`);
        }
    }

    // Re-apply the agent-private mute (silence to customer) after a FRONTEND reconnect.
    // After deliverTrack() puts the new live agent track on the WhatsApp sender the
    // customer would briefly hear the agent again — this restores the mute immediately.
    // Async because createTrack() must allocate a native RTCAudioSource.
    async _reapplyAgentPrivate() {
        if (!this._agentPrivate) return; // might have been cleared between call and exec
        const sender = this.whatsappConnection?.audio.getActivePlaceholderSender();
        if (!sender) return;
        try {
            const silenceTrack = await placeholderTrackFactory.createTrack('silence');
            if (!silenceTrack || !this._agentPrivate) return; // guard: state may have changed
            // Release the previous silence track before replacing it.
            if (this._agentPrivateSilenceTrack) {
                placeholderTrackFactory.releaseGeneratedTrack(this._agentPrivateSilenceTrack, { stopTrack: false });
            }
            this._agentPrivateSilenceTrack = silenceTrack;
            const currentSender = this.whatsappConnection?.audio.getActivePlaceholderSender();
            if (currentSender) currentSender.replaceTrack(silenceTrack);
            console.log(`[AudioBridge] Agent-private mute re-applied after reconnect for call ${this.callId}`);
        } catch (err) {
            console.error(`[AudioBridge] _reapplyAgentPrivate failed for call ${this.callId}: ${err.message}`);
        }
    }

    // Rebuild the frontend mixing relay (customer→agent path) for a new FRONTEND
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
            console.log(`[AudioBridge] Frontend mixing relay rebuilt after FRONTEND reconnect for call ${this.callId}`);
        } catch (err) {
            console.error(`[AudioBridge] Frontend relay rebuild failed for call ${this.callId}: ${err.message}`);
            if (this.frontendConnection) this.frontendConnection.deliverTrack(customerTrack, null);
        } finally {
            if (oldRelay) oldRelay.destroy();
        }
    }

    // Rebuild the WhatsApp mixing relay (agent→customer path) for a new agent track.
    // Used when supervisorMode is barge and the agent reconnects with a new FRONTEND.
    _rebuildWhatsappRelay(agentTrack) {
        const oldRelay = this._whatsappMixingRelay;
        this._whatsappMixingRelay = null;
        try {
            const newRelay = new MixingRelay(agentTrack, 'agent→customer');
            if (this._supervisorCapture) newRelay.setSupervisorCapture(this._supervisorCapture);
            const sender = this.whatsappConnection?.audio.getActivePlaceholderSender();
            if (sender) {
                sender.replaceTrack(newRelay.outputTrack);
            }
            this._whatsappMixingRelay = newRelay;
            console.log(`[AudioBridge] WhatsApp mixing relay rebuilt after FRONTEND reconnect for call ${this.callId}`);
        } catch (err) {
            console.error(`[AudioBridge] WhatsApp relay rebuild failed for call ${this.callId}: ${err.message}`);
            if (this.whatsappConnection) this.whatsappConnection.deliverTrack(agentTrack, null);
        } finally {
            if (oldRelay) oldRelay.destroy();
        }
    }
}
