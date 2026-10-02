// One call as this agent client sees it: its state, its WebRTC leg to Callio
// and the actions an agent takes on it. Created by CallioAgent — don't
// construct directly.
//
// state:
//   ringing     offered to this agent (accept / decline)
//   dialing     an outbound call this agent started; the customer isn't connected yet
//   connecting  accepted / reconnecting; media is being set up
//   active      media connected
//   elsewhere   this agent's call, but its media is on another device (switchHere)
//   ended       over; see call.endReason
//
// Events: 'state' (state, previous), 'remoteStream' (MediaStream), 'ended'
// ({ reason, ...details }), 'updated' (call data), and in-call signals:
// 'customerMedia' ({ state }), 'networkTerminating', 'dtmf' ({ digit }),
// 'supervisorMode' ({ mode }), 'privateChanged' ({ active }).
import { Emitter } from './emitter.js';

// No media within this long after setting up the leg counts as a failure.
const CONNECT_TIMEOUT_MS = 15000;
// Media recovery: this many reconnect attempts, then the call is given up
// (call:terminate reason 'system_failed').
const MAX_RECONNECTS = 1;

export class Call extends Emitter {
    constructor(agent, payload, state) {
        super();
        this.agent = agent;
        this.id = payload.callId;
        this.data = { ...payload };
        this.state = state;
        this.endReason = null;
        this.muted = false;
        this.pc = null;
        this.localStream = null;
        this.remoteStream = null;
        this._ownsLocalStream = false;
        this._bound = false;              // the server knows this socket holds the leg
        this._pendingLocal = [];          // our ICE candidates, until bound
        this._pendingRemote = [];         // Callio's, until the remote description is set
        this._reconnects = 0;
        this._connectTimer = null;
    }

    // ── What the call is ──────────────────────────────────────────────────────
    get direction() { return this.data.direction; }
    get customer() { return this.data.customer ?? {}; }
    get channel() { return this.data.channel; }
    get queueId() { return this.data.queueId ?? null; }
    get callUuid() { return this.data.callUuid ?? null; }
    get isRingAll() { return this.data.assignmentType === 'QUEUED' && this.data.agentId == null; }
    /** 'DIRECT': rtpengine alone carries the call (a personal line's 1:1 call). */
    get isDirect() { return this.data.mediaTopology === 'DIRECT'; }

    // ── Agent actions ─────────────────────────────────────────────────────────

    /** Answer an offered call. stream: the microphone (default: getUserMedia). */
    async accept({ stream } = {}) {
        if (this.state !== 'ringing') throw new Error(`Cannot accept a call that is ${this.state}`);
        if (!this.data.sdpOffer) throw new Error('The call has no offer yet');
        this._setState('connecting');
        try {
            // Candidates Callio sent while the call rang belong to this leg: keep them.
            const pc = this._newPeer({ keepRemoteCandidates: true });
            await this._attachMicrophone(pc, stream);
            await pc.setRemoteDescription({ type: 'offer', sdp: this.data.sdpOffer });
            await this._flushRemote();
            await pc.setLocalDescription(await pc.createAnswer());
            this.agent._send('call:accept', { callId: this.id, sdpAnswer: pc.localDescription.sdp });
            this._markBound();
        } catch (err) {
            this._end('accept_failed', { error: err.message });
            throw err;
        }
    }

    /** Decline an offered call (in a queue, it passes to the next agent). */
    decline() {
        if (this.state !== 'ringing') return;
        this.agent._send('call:reject', { callId: this.id });
        this._end('declined');
    }

    /** Hang up. */
    hangup() {
        if (this.state === 'ended') return;
        if (this.state === 'dialing') this.agent._send('call:cancel', { callId: this.id });
        else this.agent._send('call:terminate', { callId: this.id });
        this._end('hangup');
    }

    /** Mute or unmute the microphone (supervisors see it). */
    mute(muted = true) {
        this.muted = Boolean(muted);
        for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !this.muted;
        this.agent._send('call:agent:muted', { callId: this.id, muted: this.muted });
    }

    /** Transfer to an agent ({ agentId }) or into a queue ({ queueId }). */
    transfer(target) {
        if (!target?.agentId && !target?.queueId) throw new Error('transfer needs { agentId } or { queueId }');
        this.agent._send('call:transfer', { callId: this.id, ...target });
    }

    /** Talk privately to the monitoring supervisor (the customer can't hear). */
    setPrivate(active) {
        this.agent._send('call:agent:private', { callId: this.id, active: Boolean(active) });
    }

    /** Move a call that's active on another of your devices to this one. */
    async switchHere({ stream } = {}) {
        if (this.state !== 'elsewhere') throw new Error(`Cannot switch a call that is ${this.state}`);
        await this._reconnect('other_device', stream);
    }

    // ── Media ─────────────────────────────────────────────────────────────────

    // A new leg. Callio's buffered candidates are for the previous leg and are
    // dropped — except on accept, where they arrived for this one while ringing.
    _newPeer({ keepRemoteCandidates = false } = {}) {
        this._closePeer();
        const RTCPeerConnection = this.agent.webrtc.RTCPeerConnection;
        const pc = new RTCPeerConnection({ iceServers: this.agent.iceServers });
        this.pc = pc;
        this._bound = false;
        this._pendingLocal = [];
        if (!keepRemoteCandidates) this._pendingRemote = [];

        pc.onicecandidate = (e) => {
            if (!e.candidate || pc !== this.pc) return;
            const candidate = { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex };
            if (this._bound) this._sendCandidate(candidate);
            else this._pendingLocal.push(candidate);
        };
        pc.ontrack = (e) => {
            if (pc !== this.pc) return;
            const MediaStream = this.agent.webrtc.MediaStream;
            this.remoteStream = e.streams?.[0] ?? (MediaStream ? new MediaStream([e.track]) : null);
            this.emit('remoteStream', this.remoteStream, e.track);
        };
        pc.onconnectionstatechange = () => {
            if (pc !== this.pc) return;
            if (pc.connectionState === 'connected') {
                clearTimeout(this._connectTimer);
                this._reconnects = 0;
                if (this.state === 'connecting' || (this.state === 'dialing' && this._customerAnswered)) this._setState('active');
                this._mediaConnected = true;
            } else if (pc.connectionState === 'failed') {
                this._mediaFailed('ice_failure');
            }
        };
        clearTimeout(this._connectTimer);
        this._connectTimer = setTimeout(() => {
            if (pc === this.pc && pc.connectionState !== 'connected') this._mediaFailed('ice_failure');
        }, CONNECT_TIMEOUT_MS);
        return pc;
    }

    async _attachMicrophone(pc, stream) {
        if (!this.localStream || this.localStream.getAudioTracks().every((t) => t.readyState === 'ended')) {
            this._ownsLocalStream = !stream;
            this.localStream = stream ?? await this.agent._getMicrophone();
        }
        for (const track of this.localStream.getAudioTracks()) {
            track.enabled = !this.muted;
            pc.addTrack(track, this.localStream);
        }
    }

    _markBound() {
        this._bound = true;
        for (const c of this._pendingLocal.splice(0)) this._sendCandidate(c);
    }

    _sendCandidate(candidate) {
        this.agent._send('connection:ice-candidate', { callId: this.id, candidate, connectionType: 'AGENT' });
    }

    async _onServerCandidate(candidate) {
        if (!candidate) return;
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => { });
        else this._pendingRemote.push(candidate);
    }

    async _flushRemote() {
        for (const c of this._pendingRemote.splice(0)) await this.pc.addIceCandidate(c).catch(() => { });
    }

    async _mediaFailed(trigger) {
        if (this.state === 'ended' || this.state === 'elsewhere' || this._recovering) return;
        if (this._reconnects >= MAX_RECONNECTS) {
            this.agent._send('call:terminate', { callId: this.id, reason: 'system_failed' });
            this._end('media_failed');
            return;
        }
        this._reconnects++;
        await this._reconnect(trigger).catch((err) => this._end('media_failed', { error: err.message }));
    }

    // A new leg for the same call (network change, page reload, another device).
    // A direct call asks Callio to offer (an offer from here would move the
    // ports the provider sends to); any other call offers itself.
    async _reconnect(trigger, stream) {
        this._recovering = true;
        try {
            this._setState('connecting');
            const pc = this._newPeer();
            await this._attachMicrophone(pc, stream);
            this._awaitingReconnect = true;
            if (this.isDirect) {
                this.agent._send('call:reconnect', { callId: this.id, reconnectTrigger: trigger });
            } else {
                await pc.setLocalDescription(await pc.createOffer());
                this.agent._send('call:reconnect', { callId: this.id, sdpOffer: pc.localDescription.sdp, reconnectTrigger: trigger });
            }
            this._markBound();
        } finally {
            this._recovering = false;
        }
    }

    async _onReconnected({ sdpAnswer, sdpOffer }) {
        if (!this._awaitingReconnect || !this.pc) return;
        this._awaitingReconnect = false;
        if (sdpOffer) {
            await this.pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
            await this._flushRemote();
            await this.pc.setLocalDescription(await this.pc.createAnswer());
            this.agent._send('call:reconnect:answer', { callId: this.id, sdpAnswer: this.pc.localDescription.sdp });
            return;
        }
        await this.pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });
        await this._flushRemote();
    }

    // Outbound: the agent connects its leg first; Callio then dials the customer.
    async _start(stream) {
        const pc = this._newPeer();
        await this._attachMicrophone(pc, stream);
        await pc.setLocalDescription(await pc.createOffer());
        this.agent._send('call:start', { callId: this.id, sdpOffer: pc.localDescription.sdp });
        this._markBound();
    }

    async _onStarted(payload) {
        this._update(payload);
        if (payload.sdpAnswer && this.pc && !this.pc.remoteDescription) {
            await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdpAnswer });
            await this._flushRemote();
        }
    }

    // The customer answered an outbound call.
    _customerAnsweredNow() {
        this._customerAnswered = true;
        if (this.state === 'dialing' && this._mediaConnected) this._setState('active');
    }

    // Another device of ours took the call's media.
    _superseded() {
        this._closePeer();
        this._setState('elsewhere');
    }

    // ── Bookkeeping ───────────────────────────────────────────────────────────

    _update(payload) {
        Object.assign(this.data, Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)));
        this.emit('updated', this.data);
    }

    _setState(next) {
        if (this.state === next || this.state === 'ended') return;
        const previous = this.state;
        this.state = next;
        this.emit('state', next, previous);
        this.agent.emit('callState', this, next, previous);
    }

    _closePeer() {
        clearTimeout(this._connectTimer);
        if (this.pc) {
            const pc = this.pc;
            this.pc = null;
            try { pc.close(); } catch { /* already closed */ }
        }
    }

    _end(reason, details = {}) {
        if (this.state === 'ended') return;
        this._closePeer();
        if (this._ownsLocalStream) for (const t of this.localStream?.getTracks() ?? []) t.stop();
        this.endReason = reason;
        const previous = this.state;
        this.state = 'ended';
        this.emit('state', 'ended', previous);
        this.emit('ended', { reason, ...details });
        this.agent._forget(this, { reason, ...details });
    }
}
