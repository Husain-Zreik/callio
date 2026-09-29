// An agent's connection to Callio's agent gateway (docs/agent-protocol.md).
// Owns the socket, the agent's identity and ICE servers (session:ready),
// availability, queue snapshots and this agent's calls — and keeps them right
// across reconnects: every (re)connect resyncs from calls:list.
//
// Events:
//   'ready'         (session)          connected and identified; also after each reconnect
//   'incoming'      (call)             a call is offered to this agent — ring
//   'elsewhere'     (call)             this agent's call is active on another device
//   'callState'     (call, state, previous)
//   'callEnded'     (call, { reason, ... })
//   'availability'  ({ availability, reason? })
//   'queue'         (snapshot)         one per queue, on change and on sync
//   'error'         ({ callId, code, message } | Error)
//   'disconnected'  (reason)
import { io as defaultIo } from 'socket.io-client';
import { Emitter } from './emitter.js';
import { Call } from './Call.js';

const PROTOCOL = 1;
const TERMINAL = new Set(['TERMINATED', 'FAILED', 'CANCELLED']);
// Call errors after which the call can't go on here.
const ENDING_ERRORS = new Set(['ACCEPT_FAILED', 'CALL_ALREADY_ENDED', 'AGENT_MEDIA_NOT_READY', 'CALL_INITIATION_FAILED', 'PROVIDER_TRIGGER_FAILED']);

function defaultDeviceId() {
    const KEY = 'callio.deviceId';
    try {
        const stored = globalThis.localStorage?.getItem(KEY);
        if (stored) return stored;
        const id = globalThis.crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        globalThis.localStorage?.setItem(KEY, id);
        return id;
    } catch {
        return `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

export class CallioAgent extends Emitter {
    /**
     * @param {object} opts
     *   url        Callio base URL (https://callio.example.com)
     *   token      an agent JWT, or
     *   getToken   async () => JWT — called on every (re)connect (tokens are short-lived)
     *   deviceId   stable id for this device (default: one kept in localStorage)
     *   webrtc     { RTCPeerConnection, MediaStream } (default: the browser's)
     *   getUserMedia  async () => MediaStream for the microphone (default: navigator.mediaDevices)
     *   io         socket.io-client's io (default: the bundled one)
     */
    constructor({ url, token, getToken, deviceId, webrtc, getUserMedia, io = defaultIo } = {}) {
        super();
        if (!url) throw new Error('url is required');
        if (!token && !getToken) throw new Error('token or getToken is required');
        this.url = url;
        this.deviceId = deviceId ?? defaultDeviceId();
        this.webrtc = {
            RTCPeerConnection: webrtc?.RTCPeerConnection ?? globalThis.RTCPeerConnection,
            MediaStream: webrtc?.MediaStream ?? globalThis.MediaStream,
        };
        if (!this.webrtc.RTCPeerConnection) throw new Error('No RTCPeerConnection: pass webrtc.RTCPeerConnection');
        this._getUserMedia = getUserMedia ?? (() => globalThis.navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }));
        this._getToken = getToken ?? (async () => token);

        this.session = null;
        this.agent = null;
        this.iceServers = [];
        this.availability = null;
        this.calls = new Map();       // callId → Call
        this.queues = new Map();      // queueId → snapshot
        this._resolved = new Set();   // calls already over — redeliveries are ignored

        this.socket = io(url, {
            transports: ['websocket'],
            auth: (cb) => {
                Promise.resolve(this._getToken())
                    .then((t) => cb({ token: t, device_id: this.deviceId, protocol: PROTOCOL }))
                    .catch(() => cb({ token: null, device_id: this.deviceId, protocol: PROTOCOL }));
            },
        });
        this.ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        this.#listen();
    }

    // ── Agent actions ─────────────────────────────────────────────────────────

    /** 'AVAILABLE' or 'OFFLINE' (ON_CALL is Callio's). */
    setAvailability(availability) {
        this._send('agent:availability:set', { availability });
    }

    /** Re-read this agent's calls and the queue snapshots. */
    sync() {
        this._send('calls:sync');
    }

    /**
     * Start an outbound call the consumer created (POST /v1/tenants/{t}/calls):
     * connects this agent's leg; Callio then dials the customer.
     */
    async startOutbound(callId, { stream } = {}) {
        const call = new Call(this, { callId, direction: 'OUTBOUND' }, 'dialing');
        this.calls.set(String(callId), call);
        await call._start(stream);
        return call;
    }

    call(callId) {
        return this.calls.get(String(callId)) ?? null;
    }

    close() {
        for (const call of this.calls.values()) call._closePeer();
        this.socket.close();
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    _send(event, payload) {
        this.socket.emit(event, payload);
    }

    async _getMicrophone() {
        return this._getUserMedia();
    }

    _forget(call, details) {
        this.calls.delete(String(call.id));
        this._resolved.add(String(call.id));
        this.emit('callEnded', call, details);
    }

    #isMine(payload) {
        const me = this.agent?.id;
        if (me == null) return false;
        if (payload.agentId != null) return String(payload.agentId) === String(me);
        return (payload.offeredAgentIds ?? []).some((id) => String(id) === String(me));
    }

    #offer(payload) {
        const id = String(payload.callId);
        if (this._resolved.has(id)) return;
        const existing = this.calls.get(id);
        if (existing) {
            existing._update(payload);   // e.g. the SDP arriving after a resync saw the call
            return;
        }
        const call = new Call(this, payload, 'ringing');
        this.calls.set(id, call);
        this.emit('incoming', call);
    }

    // calls:list is the truth after any (re)connect.
    async #reconcile({ ongoing = [] } = {}) {
        const seen = new Set();
        for (const entry of ongoing) {
            if (!this.#isMine(entry)) continue;
            const id = String(entry.callId);
            seen.add(id);
            const local = this.calls.get(id);
            if (local) { local._update(entry); continue; }
            if (this._resolved.has(id) || TERMINAL.has(entry.status)) continue;

            const onOtherDevice = entry.deviceId && entry.deviceId !== this.deviceId;
            if (entry.status === 'RINGING' && entry.direction === 'INBOUND' && !entry.deviceId && entry.sdpOffer) {
                this.#offer(entry);
            } else if (onOtherDevice) {
                const call = new Call(this, entry, 'elsewhere');
                this.calls.set(id, call);
                this.emit('elsewhere', call);
            } else if (entry.deviceId === this.deviceId) {
                // Ours, on this device, but its media is gone (page reload): reconnect.
                const call = new Call(this, entry, 'connecting');
                this.calls.set(id, call);
                call._reconnect('page_reload').catch((err) => call._end('media_failed', { error: err.message }));
            }
        }
        // Calls we held that Callio no longer lists are over.
        for (const [id, call] of this.calls) {
            if (!seen.has(id) && call.state !== 'dialing') call._end('gone');
        }
    }

    #listen() {
        const s = this.socket;
        const forCall = (payload) => this.calls.get(String(payload?.callId)) ?? null;

        s.on('session:ready', (session) => {
            this.session = session;
            this.agent = session.agent;
            this.iceServers = session.iceServers ?? [];
            this._resolveReady(this);
            this.emit('ready', session);
            this.sync();
        });
        s.on('connect_error', (err) => {
            if (!this.session) this._rejectReady(err);
            this.emit('error', err);
        });
        s.on('disconnect', (reason) => this.emit('disconnected', reason));

        s.on('calls:list', (list) => this.#reconcile(list));
        s.on('call:incoming', (payload) => { if (this.#isMine(payload)) this.#offer(payload); });

        s.on('call:offer_withdrawn', (p) => {
            const call = forCall(p);
            if (call?.state === 'ringing') call._end('withdrawn', { withdrawnReason: p.reason });
        });
        s.on('call:handled', (p) => {
            const call = forCall(p);
            if (!call || call.state !== 'ringing' || p.action !== 'accepted') return;
            const byMeHere = String(p.userId) === String(this.agent?.id) && p.deviceId === this.deviceId;
            if (!byMeHere) call._end('answered_elsewhere', { by: p.userId, agentName: p.agentName });
        });
        s.on('call:terminated', (p) => forCall(p)?._end('terminated', {
            terminationReason: p.terminationReason ?? p.reason, terminatedBy: p.terminatedBy,
        }));
        s.on('call:status', (p) => {
            const call = forCall(p);
            if (!call) return;
            call._update({ status: p.status, ringingAt: p.ringingAt, answeredAt: p.answeredAt });
            if (call.direction === 'OUTBOUND' && ['ACCEPTED', 'IN_PROGRESS'].includes(p.status)) call._customerAnsweredNow();
        });

        s.on('call:started', (p) => forCall(p)?._onStarted(p));
        s.on('call:reconnected', (p) => forCall(p)?._onReconnected(p));
        s.on('call:connection_superseded', (p) => forCall(p)?._superseded());
        s.on('connection:ice-candidate:server', (p) => {
            if (p.connectionType && p.connectionType !== 'AGENT') return;
            forCall(p)?._onServerCandidate(p.candidate);
        });

        s.on('call:customer:media:state', (p) => forCall(p)?.emit('customerMedia', p));
        s.on('call:network:terminating', (p) => forCall(p)?.emit('networkTerminating', p));
        s.on('call:dtmf', (p) => forCall(p)?.emit('dtmf', p));
        s.on('call:supervisor:mode', (p) => forCall(p)?.emit('supervisorMode', p));
        s.on('call:agent:private:changed', (p) => forCall(p)?.emit('privateChanged', p));

        s.on('call:agent_availability', (p) => {
            if (String(p.userId) !== String(this.agent?.id)) return;
            this.availability = p.availability;
            this.emit('availability', p);
        });
        s.on('call:agent_queue', (snapshot) => {
            this.queues.set(String(snapshot.queueId), snapshot);
            this.emit('queue', snapshot);
        });
        s.on('call:error', (p) => {
            this.emit('error', p);
            if (p.callId != null && ENDING_ERRORS.has(p.code)) forCall(p)?._end('error', { code: p.code, message: p.message });
        });
    }
}

/** Connects and resolves once Callio has identified the agent (session:ready). */
export async function connect(opts) {
    const agent = new CallioAgent(opts);
    await agent.ready;
    return agent;
}
