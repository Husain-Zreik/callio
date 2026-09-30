// An agent's connection to Callio's agent gateway (docs/agent-protocol.md).
// Owns the socket, the agent's identity and ICE servers (session:ready),
// availability, queue snapshots and this agent's calls — and keeps them right
// across reconnects: every (re)connect resyncs from calls:list.
//
// Events:
//   'ready'         (session)          connected and identified; also after each reconnect
//   'sessionRefreshed' (session)       new ICE/TURN credentials, fetched before they expire
//   'incoming'      (call)             a call is offered to this agent — ring
//   'elsewhere'     (call)             this agent's call is active on another device
//   'callState'     (call, state, previous)
//   'callEnded'     (call, { reason, ... })
//   'availability'  ({ availability, reason? })          this agent
//   'team'          ({ agentId, availability, reason? }) any agent of the tenant
//   'queue'         (snapshot)         one per queue, on change and on sync
//   'error'         ({ callId, code, message } | Error)
//   'disconnected'  (reason)
// Supervisors only (agent.board = the tenant's live calls):
//   'board'         (board)            the whole board, after each (re)sync
//   'boardCall'     (view)             a call appeared or changed
//   'boardCallEnded' (view, { terminationReason, terminatedBy })
import { io as defaultIo } from 'socket.io-client';
import { Emitter } from './emitter.js';
import { Call } from './Call.js';
import { Monitor } from './Monitor.js';

const PROTOCOL = 1;
const TERMINAL = new Set(['TERMINATED', 'FAILED', 'CANCELLED']);
// Call errors after which the call can't go on here.
const ENDING_ERRORS = new Set(['ACCEPT_FAILED', 'CALL_ALREADY_ENDED', 'AGENT_MEDIA_NOT_READY', 'CALL_INITIATION_FAILED', 'PROVIDER_TRIGGER_FAILED']);
// ICE/TURN credentials are refreshed at this share of their lifetime, never sooner than MIN_REFRESH_MS.
const REFRESH_AT = 0.8;
const MIN_REFRESH_MS = 60_000;

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
        this.team = new Map();        // agentId → { agentId, availability, reason?, updatedAt? }
        this.board = new Map();       // supervisors: callId → the tenant's live calls
        this.monitors = new Map();    // supervisors: callId → Monitor
        this._resolved = new Set();   // calls already over — redeliveries are ignored
        this._refreshTimer = null;
        this._refreshing = false;

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

    /** 'AVAILABLE' or 'OFFLINE' (ON_CALL is Callio's). Supervisors may pass another agent's id. */
    setAvailability(availability, { agentId } = {}) {
        this._send('agent:availability:set', agentId != null ? { availability, agentId } : { availability });
    }

    /** Re-read this agent's calls (supervisors: the tenant's) and the queue snapshots. */
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

    get isSupervisor() {
        return this.agent?.role === 'SUPERVISOR';
    }

    /**
     * Supervisors: listen to a call, then setMode('whisper' | 'barge').
     * stream: the supervisor's microphone (default: getUserMedia).
     */
    async monitor(callId, { stream } = {}) {
        if (!this.isSupervisor) throw new Error('Only supervisors can monitor calls');
        const id = String(callId);
        const existing = this.monitors.get(id);
        if (existing && existing.state !== 'ended') return existing;
        const monitor = new Monitor(this, callId);
        this.monitors.set(id, monitor);
        try {
            await monitor._start(stream);
        } catch (err) {
            monitor._end('failed');
            throw err;
        }
        return monitor;
    }

    /** Supervisors: move a call to an agent ({ agentId }) or into a queue ({ queueId }). */
    transferCall(callId, target) {
        if (!target?.agentId && !target?.queueId) throw new Error('transfer needs { agentId } or { queueId }');
        this._send('call:transfer', { callId, ...target });
    }

    /** New ICE/TURN credentials now (also done automatically before they expire). */
    refreshSession() {
        this._refreshing = true;
        this._send('session:refresh');
    }

    close() {
        clearTimeout(this._refreshTimer);
        for (const call of this.calls.values()) call._closePeer();
        for (const monitor of [...this.monitors.values()]) monitor._end('closed');
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

    _forgetMonitor(monitor) {
        if (this.monitors.get(String(monitor.callId)) === monitor) this.monitors.delete(String(monitor.callId));
    }

    #scheduleRefresh() {
        clearTimeout(this._refreshTimer);
        const expiresAt = Date.parse(this.session?.iceServersExpireAt ?? '');
        if (!Number.isFinite(expiresAt)) return;   // static credentials: nothing to refresh
        const delay = Math.max(MIN_REFRESH_MS, (expiresAt - Date.now()) * REFRESH_AT);
        this._refreshTimer = setTimeout(() => this.refreshSession(), Math.min(delay, 2 ** 31 - 1));
        this._refreshTimer.unref?.();
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

    // ── Supervisor board ──────────────────────────────────────────────────────

    #boardUpsert(payload) {
        if (!this.isSupervisor || payload?.callId == null) return;
        const id = String(payload.callId);
        const { sdpOffer, sdpAnswer, ...fields } = payload;
        const known = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        const view = { ...(this.board.get(id) ?? {}), ...known };
        this.board.set(id, view);
        this.emit('boardCall', view);
    }

    #boardEnd(payload) {
        const id = String(payload.callId);
        this.monitors.get(id)?._end('call_ended');
        const view = this.board.get(id);
        if (!view) return;
        this.board.delete(id);
        this.emit('boardCallEnded', view, { terminationReason: payload.terminationReason ?? payload.reason, terminatedBy: payload.terminatedBy });
    }

    // calls:list is the truth after any (re)connect.
    async #reconcile({ ongoing = [] } = {}) {
        if (this.isSupervisor) {
            this.board.clear();
            for (const entry of ongoing) {
                if (TERMINAL.has(entry.status)) continue;
                const { sdpOffer, ...view } = entry;
                this.board.set(String(entry.callId), view);
            }
            this.emit('board', this.board);
        }
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
        const forMonitor = (payload) => this.monitors.get(String(payload?.callId)) ?? null;
        const onBoard = (payload) => this.board.has(String(payload?.callId));

        s.on('session:ready', (session) => {
            this.session = session;
            this.agent = session.agent;
            this.iceServers = session.iceServers ?? [];
            this.#scheduleRefresh();
            if (this._refreshing) {
                // A credentials refresh on the same connection: nothing else changed.
                this._refreshing = false;
                this.emit('sessionRefreshed', session);
                return;
            }
            // A (re)connect: monitoring doesn't survive the old socket.
            for (const monitor of [...this.monitors.values()]) monitor._end('disconnected');
            this._resolveReady(this);
            this.emit('ready', session);
            this.sync();
        });
        s.on('connect_error', (err) => {
            if (!this.session) this._rejectReady(err);
            this.emit('error', err);
        });
        s.on('disconnect', (reason) => {
            this._refreshing = false;
            this.emit('disconnected', reason);
        });

        s.on('calls:list', (list) => this.#reconcile(list));
        s.on('call:incoming', (payload) => { if (this.#isMine(payload)) this.#offer(payload); });

        s.on('call:offer_withdrawn', (p) => {
            const call = forCall(p);
            if (call?.state === 'ringing') call._end('withdrawn', { withdrawnReason: p.reason });
        });
        s.on('call:handled', (p) => {
            if (p.action === 'accepted' && onBoard(p)) this.#boardUpsert({ callId: p.callId, agentId: p.userId, agentName: p.agentName });
            const call = forCall(p);
            if (!call || call.state !== 'ringing' || p.action !== 'accepted') return;
            const byMeHere = String(p.userId) === String(this.agent?.id) && p.deviceId === this.deviceId;
            if (!byMeHere) call._end('answered_elsewhere', { by: p.userId, agentName: p.agentName });
        });
        s.on('call:terminated', (p) => {
            forCall(p)?._end('terminated', { terminationReason: p.terminationReason ?? p.reason, terminatedBy: p.terminatedBy });
            // 'transferred' ends the previous agent's leg, not the call.
            if (p.reason !== 'transferred') this.#boardEnd(p);
        });
        s.on('call:status', (p) => {
            // The board speaks Callio's statuses: a provider's ACCEPTED is IN_PROGRESS.
            if (onBoard(p)) this.#boardUpsert({ callId: p.callId, status: p.status === 'ACCEPTED' ? 'IN_PROGRESS' : p.status, ringingAt: p.ringingAt, answeredAt: p.answeredAt });
            const call = forCall(p);
            if (!call) return;
            call._update({ status: p.status, ringingAt: p.ringingAt, answeredAt: p.answeredAt });
            if (call.direction === 'OUTBOUND' && ['ACCEPTED', 'IN_PROGRESS'].includes(p.status)) call._customerAnsweredNow();
        });

        s.on('call:started', (p) => forCall(p)?._onStarted(p));
        s.on('call:reconnected', (p) => forCall(p)?._onReconnected(p));
        s.on('call:connection_superseded', (p) => forCall(p)?._superseded());
        s.on('connection:ice-candidate:server', (p) => {
            if (p.connectionType === 'MONITOR') { forMonitor(p)?._onServerCandidate(p.candidate); return; }
            if (p.connectionType && p.connectionType !== 'AGENT') return;
            forCall(p)?._onServerCandidate(p.candidate);
        });

        s.on('call:customer:media:state', (p) => forCall(p)?.emit('customerMedia', p));
        s.on('call:network:terminating', (p) => forCall(p)?.emit('networkTerminating', p));
        s.on('call:dtmf', (p) => forCall(p)?.emit('dtmf', p));
        s.on('call:supervisor:mode', (p) => {
            forCall(p)?.emit('supervisorMode', p);
            forMonitor(p)?._onMode(p.mode);
        });
        s.on('call:agent:private:changed', (p) => {
            forCall(p)?.emit('privateChanged', p);
            forMonitor(p)?.emit('agentPrivate', p);
        });

        // Supervisors: the board and monitoring.
        s.on('call:incoming:supervisor', (p) => this.#boardUpsert(p));
        s.on('call:initiated', (p) => this.#boardUpsert(p));
        s.on('call:transferred', (p) => this.#boardUpsert({
            callId: p.callId, agentId: p.agentId ?? p.userId, agentName: p.agentName, queueId: p.targetQueueId ?? p.queueId,
        }));
        s.on('call:ivr_state', (p) => this.#boardUpsert({ callId: p.callId, ivr: { nodeType: p.nodeType, nodeId: p.nodeId } }));
        for (const done of ['call:ivr_transferred', 'call:ivr_terminated', 'call:ivr_session_closed']) {
            s.on(done, (p) => { if (onBoard(p)) this.#boardUpsert({ callId: p.callId, ivr: null }); });
        }
        s.on('call:monitor:started', (p) => forMonitor(p)?._onStarted(p));
        s.on('call:monitor:mode:changed', (p) => forMonitor(p)?._onMode(p.mode));
        s.on('call:monitor:ended', (p) => forMonitor(p)?._end('ended'));
        s.on('call:monitor:agent:reconnected', (p) => forMonitor(p)?.emit('agentReconnected', p));

        s.on('call:agent_availability', (p) => {
            const entry = { agentId: p.userId, availability: p.availability, reason: p.reason, updatedAt: p.updatedAt };
            this.team.set(String(p.userId), entry);
            this.emit('team', entry);
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
            if (p.code === 'MONITOR_FAILED') forMonitor(p)?._end('failed');
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
