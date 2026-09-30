// A supervisor listening to a call (docs/agent-protocol.md, Monitoring).
// Created by CallioAgent.monitor() — don't construct directly.
//
// Two audio lines to Callio: the first sends the supervisor's microphone and
// receives the agent, the second receives the customer. Callio mixes, so a
// mode change needs no renegotiation:
//   listen   the supervisor hears both; nobody hears the supervisor
//   whisper  the agent hears the supervisor; the customer doesn't
//   barge    both hear the supervisor
//
// state: connecting → active → ended
// Events: 'state' (state, previous), 'agentStream' (MediaStream),
// 'customerStream' (MediaStream), 'mode' (mode), 'agentPrivate' ({ active }),
// 'agentReconnected', 'ended' ({ reason }).
import { Emitter } from './emitter.js';

const CONNECT_TIMEOUT_MS = 15000;
const MODES = new Set(['listen', 'whisper', 'barge']);

export class Monitor extends Emitter {
    constructor(agent, callId) {
        super();
        this.agent = agent;
        this.callId = callId;
        this.state = 'connecting';
        this.mode = 'listen';
        this.muted = false;
        this.agentStream = null;
        this.customerStream = null;
        this.localStream = null;
        this._ownsLocalStream = false;
        this.pc = null;
        this._pendingRemote = [];
        this._timer = null;
    }

    /** 'listen' | 'whisper' | 'barge'. */
    setMode(mode) {
        if (!MODES.has(mode)) throw new Error(`Unknown monitor mode "${mode}" (listen, whisper, barge)`);
        if (this.state === 'ended') return;
        this.agent._send('call:monitor:mode', { callId: this.callId, mode });
    }

    /** Mute the supervisor's microphone (whisper / barge). */
    mute(muted = true) {
        this.muted = Boolean(muted);
        for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !this.muted;
    }

    stop() {
        if (this.state === 'ended') return;
        this.agent._send('call:monitor:stop', { callId: this.callId });
        this._end('stopped');
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    async _start(stream) {
        const { RTCPeerConnection, MediaStream } = this.agent.webrtc;
        const pc = new RTCPeerConnection({ iceServers: this.agent.iceServers });
        this.pc = pc;

        this._ownsLocalStream = !stream;
        this.localStream = stream ?? await this.agent._getMicrophone();
        const mic = this.localStream.getAudioTracks()[0];
        const agentLine = pc.addTransceiver(mic ?? 'audio', { direction: 'sendrecv', streams: [this.localStream] });
        const customerLine = pc.addTransceiver('audio', { direction: 'recvonly' });

        pc.onicecandidate = (e) => {
            if (!e.candidate || pc !== this.pc) return;
            this.agent._send('connection:ice-candidate', {
                callId: this.callId, connectionType: 'MONITOR',
                candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex },
            });
        };
        // By transceiver, never by arrival order.
        pc.ontrack = (e) => {
            if (pc !== this.pc) return;
            const s = new MediaStream([e.track]);
            if (e.transceiver === agentLine || e.transceiver?.mid === agentLine.mid) {
                this.agentStream = s;
                this.emit('agentStream', s, e.track);
            } else if (e.transceiver === customerLine || e.transceiver?.mid === customerLine.mid) {
                this.customerStream = s;
                this.emit('customerStream', s, e.track);
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc !== this.pc) return;
            if (pc.connectionState === 'connected') { clearTimeout(this._timer); this._setState('active'); }
            else if (pc.connectionState === 'failed') this.stop();
        };
        this._timer = setTimeout(() => { if (this.state === 'connecting') this.stop(); }, CONNECT_TIMEOUT_MS);

        await pc.setLocalDescription(await pc.createOffer());
        this.agent._send('call:monitor', { callId: this.callId, sdpOffer: pc.localDescription.sdp });
    }

    async _onStarted({ sdpAnswer }) {
        if (!this.pc || this.pc.remoteDescription) return;
        await this.pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });
        for (const c of this._pendingRemote.splice(0)) await this.pc.addIceCandidate(c).catch(() => { });
    }

    async _onServerCandidate(candidate) {
        if (!candidate) return;
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => { });
        else this._pendingRemote.push(candidate);
    }

    _onMode(mode) {
        if (!MODES.has(mode) || mode === this.mode) return;
        this.mode = mode;
        this.emit('mode', mode);
    }

    _setState(next) {
        if (this.state === next || this.state === 'ended') return;
        const previous = this.state;
        this.state = next;
        this.emit('state', next, previous);
    }

    _end(reason) {
        if (this.state === 'ended') return;
        clearTimeout(this._timer);
        const pc = this.pc;
        this.pc = null;
        try { pc?.close(); } catch { /* already closed */ }
        if (this._ownsLocalStream) for (const t of this.localStream?.getTracks() ?? []) t.stop();
        const previous = this.state;
        this.state = 'ended';
        this.emit('state', 'ended', previous);
        this.emit('ended', { reason });
        this.agent._forgetMonitor(this, reason);
    }
}
