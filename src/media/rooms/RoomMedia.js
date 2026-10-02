// src/media/rooms/RoomMedia.js
// The media port (core/media/CallMedia.js) on FreeSWITCH rooms. Each call is
// a conference named callio-<callId>; each participant is a FreeSWITCH
// endpoint behind its own rtpengine leg (RtpLegs.js). No audio passes
// through Node: FreeSWITCH mixes, plays, detects DTMF and records.
//
// A call's legs live on the worker that created them (their endpoints'
// events come back to it). Every operation on a call runs one at a time
// (`_serial`), so membership and the audibility rules never interleave.
//
// Who hears whom, as conference rules (applied after every change):
//   listen        supervisors muted
//   whisper       supervisors unmuted, `relate supervisor customer nospeak`
//   barge         supervisors unmuted, no relation
//   agent-private (whisper only) `relate agent customer nospeak`
// The customer stays out of the room while the IVR plays to them alone. Hold
// music puts them in the room alone, played to their member; bridge() stops
// it and adds the agents. With no agent left in the room the customer hears
// the reconnect tone.
import EventBus from '../../core/EventBus.js';
import { freeSwitch, FreeSwitch } from './FreeSwitch.js';
import { rtpLegs } from './RtpLegs.js';
import { mediaAudio } from './MediaAudio.js';
import { roomRecorder } from './RoomRecorder.js';
import { CustomerLegMonitor } from './CustomerLegMonitor.js';
import { primaryAudioOnly, withRejectedLines } from './sdpLines.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.rooms.RoomMedia');

// 600 → 750 → 900 Hz, 0.2 s each, then 1.2 s of silence.
const RECONNECT_TONE = 'tone_stream://%(200,0,600);%(200,0,750);%(200,0,900);%(1200,0,0)';
const AGENT_AUDIO_TIMEOUT_MS = 5000;
const DIGIT_DEBOUNCE_MS = 600;
const ORPHAN_SWEEP_MS = 30_000;

class Room {
    constructor(callId) {
        this.callId = Number(callId);
        // Unique per worker run: call ids are reused when a database is reset.
        this.name = `callio-${freeSwitch.bootId}-${callId}`;
        this.customer = null;          // leg
        this.pendingAgent = null;      // offered, not answered
        this.agents = new Map();       // agentId → leg
        this.supervisors = new Map();  // supervisorId → leg
        this.mode = 'listen';
        this.agentPrivate = false;
        this.bridged = false;
        this.toneOn = false;
        this.holdOn = false;
        this.recording = null;
        this.monitor = null;
        this.chain = Promise.resolve();
        this.legSeq = 0;
    }
}

class RoomMedia {
    constructor() {
        this.rooms = new Map();
        this._sweep = null;
    }

    // ── internals ──────────────────────────────────────────────────────────────

    _room(callId) {
        const key = String(callId);
        let room = this.rooms.get(key);
        if (!room) { room = new Room(callId); this.rooms.set(key, room); }
        return room;
    }

    _get(callId) {
        return this.rooms.get(String(callId)) ?? null;
    }

    // Runs fn(room) after every earlier operation on the call.
    _serial(callId, fn) {
        const room = this._room(callId);
        const run = room.chain.then(() => fn(room));
        room.chain = run.catch(() => { });
        return run;
    }

    _key(room, kind) {
        return `${freeSwitch.tag(room.callId)}.${kind}${++room.legSeq}`;
    }

    // The external side offered (customer inbound, supervisor, agent reconnect).
    async _legFromOffer(room, kind, sdp, transport) {
        const rtpKey = this._key(room, kind);
        try {
            const fsOffer = await rtpLegs.remoteOffer(rtpKey, sdp);
            const ep = await freeSwitch.createEndpoint(room.callId, fsOffer);
            const answer = await rtpLegs.endpointAnswer(rtpKey, ep.local.sdp, transport);
            return { leg: { kind, ep, rtpKey, transport, memberId: null, answered: true }, answer };
        } catch (err) {
            await rtpLegs.delete(rtpKey);
            throw err;
        }
    }

    // We offer (customer outbound, a ringing agent). A plain-RTP leg (a SIP
    // carrier) is offered G.711 only: offered Opus and answered G.711, a
    // FreeSWITCH endpoint stops sending the room (freeswitch/Dockerfile).
    async _legOffer(room, kind, transport) {
        const rtpKey = this._key(room, kind);
        try {
            const ep = await freeSwitch.createEndpoint(room.callId, null, { g711: transport === 'rtp' });
            const offer = await rtpLegs.endpointOffer(rtpKey, ep.local.sdp, transport);
            return { leg: { kind, ep, rtpKey, transport, memberId: null, answered: false }, offer };
        } catch (err) {
            await rtpLegs.delete(rtpKey);
            throw err;
        }
    }

    async _applyAnswer(leg, sdp) {
        const fsAnswer = await rtpLegs.remoteAnswer(leg.rtpKey, sdp);
        await leg.ep.modify(fsAnswer);
        leg.answered = true;
    }

    async _destroyLeg(leg) {
        if (!leg) return;
        try { await leg.ep.destroy(); } catch (err) { log.debug({ err }, 'Endpoint already gone'); }
        await rtpLegs.delete(leg.rtpKey);
    }

    async _conf(room, args) {
        const res = await freeSwitch.api(`conference ${room.name} ${args}`);
        if (/^-ERR/.test(res)) log.debug({ callId: room.callId }, `conference ${args}: ${res.trim()}`);
        return res;
    }

    async _join(room, leg, flags = {}) {
        if (leg.memberId != null) return;
        const { memberId } = await leg.ep.join(room.name, { profile: config.media.freeswitch.conferenceProfile, flags });
        leg.memberId = memberId;
    }

    // The customer's endpoint: DTMF detection on from the start (in-band and
    // RFC 4733), digits reach the core while an IVR menu listens.
    async _armCustomer(room, leg) {
        room.customer = leg;
        leg.listening = false;
        leg.lastDigit = null;
        await leg.ep.execute('start_dtmf').catch((err) => log.warn({ callId: room.callId, err }, 'start_dtmf failed'));
        leg.ep.on('dtmf', ({ dtmf }) => {
            if (!leg.listening) return;
            const now = Date.now();
            // A long key press is reported more than once.
            if (leg.lastDigit && leg.lastDigit.digit === dtmf && now - leg.lastDigit.at < DIGIT_DEBOUNCE_MS) return;
            leg.lastDigit = { digit: dtmf, at: now };
            log.debug({ callId: room.callId }, `DTMF ${dtmf}`);
            EventBus.emit('call:dtmf', { callId: room.callId, digit: dtmf });
        });
        leg.ep.on('destroy', () => {
            if (room.customer === leg) log.info({ callId: room.callId }, 'Customer endpoint ended');
        });
    }

    _watchCustomer(room) {
        if (room.monitor || !room.customer) return;
        room.monitor = new CustomerLegMonitor(room.callId, room.customer.rtpKey);
        room.monitor.start();
    }

    async _rules(room) {
        const cust = room.customer?.memberId;
        for (const leg of room.supervisors.values()) {
            if (leg.memberId == null) continue;
            await this._conf(room, `${room.mode === 'listen' ? 'mute' : 'unmute'} ${leg.memberId}`);
            if (cust != null) await this._conf(room, `relate ${leg.memberId} ${cust} ${room.mode === 'whisper' ? 'nospeak' : 'clear'}`);
        }
        if (cust == null) return;
        for (const leg of room.agents.values()) {
            if (leg.memberId == null) continue;
            await this._conf(room, `relate ${leg.memberId} ${cust} ${room.agentPrivate ? 'nospeak' : 'clear'}`);
        }
    }

    async _tone(room, on) {
        const cust = room.customer?.memberId;
        if (cust == null || room.toneOn === on) return;
        room.toneOn = on;
        if (on) await this._conf(room, `play {loops=-1}${RECONNECT_TONE} ${cust}`);
        else await this._conf(room, `stop all ${cust}`);
    }

    async _break(leg) {
        if (!leg) return;
        await freeSwitch.api(`uuid_break ${leg.ep.uuid} all`).catch(() => { });
    }

    // ── customer leg ───────────────────────────────────────────────────────────

    answerCustomer(call, sdpOffer, profile) {
        return this._serial(call.id, async (room) => {
            await this._destroyLeg(room.customer);
            const sdp = profile?.remoteOffer ? profile.remoteOffer(sdpOffer) : sdpOffer;
            const { leg, answer } = await this._legFromOffer(room, 'customer', sdp, profile?.transport ?? 'webrtc');
            await this._armCustomer(room, leg);
            this._watchCustomer(room);
            log.debug({ callId: room.callId }, 'Customer leg answered');
            return answer;
        });
    }

    offerCustomer(call, profile) {
        return this._serial(call.id, async (room) => {
            await this._destroyLeg(room.customer);
            const { leg, offer } = await this._legOffer(room, 'customer', profile?.transport ?? 'webrtc');
            await this._armCustomer(room, leg);
            return profile?.localOffer ? profile.localOffer(offer) : offer;
        });
    }

    customerAnswered(call, sdpAnswer, profile) {
        return this._serial(call.id, async (room) => {
            if (!room.customer) throw new Error('No customer leg offered on this worker');
            const sdp = profile?.remoteAnswer ? profile.remoteAnswer(sdpAnswer) : sdpAnswer;
            await this._applyAnswer(room.customer, sdp);
            this._watchCustomer(room);
        });
    }

    async customerAudio(callId, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const leg = this._get(callId)?.customer;
            if (!leg) return false;
            const { packets } = await rtpLegs.received(leg.rtpKey).catch(() => ({ packets: 0 }));
            if (packets > 0) return true;
            if (Date.now() > deadline) return false;
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    // ── agent legs ─────────────────────────────────────────────────────────────

    offerAgent(call) {
        return this._serial(call.id, async (room) => {
            await this._destroyLeg(room.pendingAgent);
            room.pendingAgent = null;
            const { leg, offer } = await this._legOffer(room, 'agent', 'webrtc');
            room.pendingAgent = leg;
            return offer;
        });
    }

    agentAccepted(call, agentId, sdpAnswer) {
        return this._serial(call.id, async (room) => {
            const leg = room.pendingAgent;
            if (!leg) throw new Error('No agent leg offered on this worker');
            room.pendingAgent = null;
            try {
                await this._applyAnswer(leg, sdpAnswer);
                await this._awaitAudio(leg, AGENT_AUDIO_TIMEOUT_MS);
            } catch (err) {
                await this._destroyLeg(leg);
                throw err;
            }
            const previous = room.agents.get(String(agentId));
            if (previous) await this._destroyLeg(previous);
            leg.agentId = String(agentId);
            room.agents.set(String(agentId), leg);
        });
    }

    answerAgent(call, agentId, sdpOffer) {
        return this._serial(call.id, async (room) => {
            const previous = room.agents.get(String(agentId));
            if (previous) {
                room.agents.delete(String(agentId));
                await this._destroyLeg(previous);
            }
            const { leg, answer } = await this._legFromOffer(room, 'agent', sdpOffer, 'webrtc');
            leg.agentId = String(agentId);
            room.agents.set(String(agentId), leg);
            return answer;
        });
    }

    dropAgent(callId, agentId = null) {
        if (!this._get(callId)) return Promise.resolve();
        return this._serial(callId, async (room) => {
            const ids = agentId != null ? [String(agentId)] : [...room.agents.keys()];
            for (const id of ids) {
                const leg = room.agents.get(id);
                if (!leg) continue;
                room.agents.delete(id);
                await this._destroyLeg(leg);
            }
            if (room.agents.size === 0) {
                if (room.agentPrivate) room.agentPrivate = false;
                await this._tone(room, true);
            }
        });
    }

    hasAgentOffer(callId) {
        return Boolean(this._get(callId)?.pendingAgent);
    }

    // The agent's audio has reached rtpengine (their microphone works).
    async _awaitAudio(leg, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const { packets } = await rtpLegs.received(leg.rtpKey).catch(() => ({ packets: 0 }));
            if (packets > 0) return;
            if (Date.now() > deadline) throw new Error(`Microphone audio did not reach the server within ${Math.round(timeoutMs / 1000)}s`);
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    // ── the room ───────────────────────────────────────────────────────────────

    bridge(call) {
        return this._serial(call.id, async (room) => {
            if (!room.customer?.answered || room.agents.size === 0) {
                log.debug({ callId: room.callId }, `Not bridging yet — customer=${Boolean(room.customer?.answered)} agents=${room.agents.size}`);
                return false;
            }
            const first = !room.bridged;
            if (room.customer.memberId == null) {
                await this._break(room.customer);   // an IVR prompt still playing
                await this._join(room, room.customer);
            }
            await this._hold(room, false);
            for (const leg of room.agents.values()) await this._join(room, leg);
            await this._tone(room, false);
            await this._rules(room);
            room.bridged = true;
            if (first) {
                EventBus.emit('call:queue_audio_stop', { callId: room.callId });
                room.recording = await roomRecorder.start(room.callId, room.customer.ep);
                log.info({ callId: room.callId }, 'Room bridged');
            }
            return true;
        });
    }

    // ── supervisors ────────────────────────────────────────────────────────────

    addSupervisor(call, supervisorId, sdpOffer) {
        return this._serial(call.id, async (room) => {
            const { sdp, extra } = primaryAudioOnly(sdpOffer);
            const previous = room.supervisors.get(String(supervisorId));
            if (previous) { room.supervisors.delete(String(supervisorId)); await this._destroyLeg(previous); }
            const { leg, answer } = await this._legFromOffer(room, 'supervisor', sdp, 'webrtc');
            if (room.supervisors.size === 0) room.mode = 'listen';
            await this._join(room, leg, { mute: true });
            room.supervisors.set(String(supervisorId), leg);
            await this._rules(room);
            return withRejectedLines(answer, extra);
        });
    }

    setSupervisorMode(callId, mode) {
        if (!this._get(callId)) throw new Error('This call has no media here');
        return this._serial(callId, async (room) => {
            room.mode = mode;
            const endedPrivate = room.agentPrivate && mode !== 'whisper';
            if (endedPrivate) room.agentPrivate = false;
            await this._rules(room);
            return endedPrivate;
        });
    }

    setAgentPrivate(callId, active) {
        if (!this._get(callId)) throw new Error('This call has no media here');
        return this._serial(callId, async (room) => {
            const allowed = room.mode === 'whisper' && room.supervisors.size > 0;
            room.agentPrivate = Boolean(active) && allowed;
            await this._rules(room);
            return room.agentPrivate;
        });
    }

    removeSupervisor(callId, supervisorId) {
        if (!this._get(callId)) return Promise.resolve(false);
        return this._serial(callId, async (room) => {
            const ids = supervisorId != null ? [String(supervisorId)] : [...room.supervisors.keys()];
            for (const id of ids) {
                const leg = room.supervisors.get(id);
                if (!leg) continue;
                room.supervisors.delete(id);
                await this._destroyLeg(leg);
            }
            const wasPrivate = room.agentPrivate;
            if (room.supervisors.size === 0) { room.agentPrivate = false; room.mode = 'listen'; }
            await this._rules(room);
            return wasPrivate && !room.agentPrivate;
        });
    }

    hasSupervisor(callId) {
        return (this._get(callId)?.supervisors.size ?? 0) > 0;
    }

    monitorState(callId) {
        const room = this._get(callId);
        if (!room?.supervisors.size) return null;
        return { mode: room.mode, agentPrivate: room.agentPrivate };
    }

    // ── customer audio ─────────────────────────────────────────────────────────

    player(callId) {
        const leg = () => this._get(callId)?.customer ?? null;
        return {
            play: async (audio) => {
                const l = leg();
                if (!l) throw new Error('No customer leg to play to');
                if (!audio?.url) throw new Error('No audio to play');
                await l.ep.play(audio.url);
            },
            stop: () => { this._break(leg()); },
        };
    }

    listenForDigits(callId, on) {
        const leg = this._get(callId)?.customer;
        if (leg) leg.listening = Boolean(on);
    }

    startHold(callId, audio) {
        return this._serial(callId, async (room) => {
            if (!room.customer || room.agents.size > 0) return;
            await this._break(room.customer);   // an IVR prompt still playing
            await this._join(room, room.customer);
            await this._hold(room, true, audio?.url ? audio.url : RECONNECT_TONE);
        });
    }

    stopHold(callId) {
        if (!this._get(callId)) return Promise.resolve();
        return this._serial(callId, (room) => this._hold(room, false));
    }

    // Hold music on a loop to the customer's member, or off.
    async _hold(room, on, url = null) {
        const cust = room.customer?.memberId;
        if (cust == null || Boolean(room.holdOn) === on) return;
        room.holdOn = on;
        if (on) await this._conf(room, `play {loops=-1}${url} ${cust}`);
        else await this._conf(room, `stop all ${cust}`);
    }

    audioUrl(record) {
        return mediaAudio.forRecord(record);
    }

    errorAudio() {
        return mediaAudio.errorAudio();
    }

    // ── lifecycle ──────────────────────────────────────────────────────────────

    close(callId) {
        const room = this._get(callId);
        if (!room) return Promise.resolve();
        return this._serial(callId, async () => {
            if (!this.rooms.has(String(callId))) return;
            this.rooms.delete(String(callId));
            room.monitor?.stop();
            if (room.recording) await roomRecorder.stop(room.recording);
            const legs = [room.customer, room.pendingAgent, ...room.agents.values(), ...room.supervisors.values()].filter(Boolean);
            await Promise.all(legs.map((leg) => this._destroyLeg(leg)));
            log.debug({ callId }, `Room closed (${legs.length} legs)`);
        });
    }

    owns(callId) {
        return this.rooms.has(String(callId));
    }

    activeCallIds() {
        return [...this.rooms.keys()].map(Number);
    }

    stats() {
        let legs = 0;
        for (const r of this.rooms.values()) {
            legs += (r.customer ? 1 : 0) + (r.pendingAgent ? 1 : 0) + r.agents.size + r.supervisors.size;
        }
        return { rooms: this.rooms.size, legs, connected: freeSwitch.connected };
    }

    async start() {
        await freeSwitch.start();
        if (!freeSwitch.enabled) return;
        await this.sweepOrphans().catch((err) => log.warn({ err }, 'Orphan sweep failed'));
        this._sweep = setInterval(() => this.sweepOrphans().catch((err) =>
            log.warn({ err }, 'Orphan sweep failed')), ORPHAN_SWEEP_MS);
        this._sweep.unref();
    }

    async stop() {
        clearInterval(this._sweep);
        this._sweep = null;
        await Promise.all(this.activeCallIds().map((id) => this.close(id).catch(() => { })));
        await roomRecorder.drain(45_000);
        await freeSwitch.stop();
        rtpLegs.close();
    }

    // Legs whose worker is gone (its boot id no longer in Redis), and this
    // worker's own legs for calls it no longer holds: hang up / delete.
    async sweepOrphans() {
        if (!freeSwitch.connected) return;
        const dead = async (tag) => {
            const t = FreeSwitch.parseTag(tag);
            if (!t) return false;
            if (t.bootId === freeSwitch.bootId) return !this.rooms.has(String(t.callId));
            return !await freeSwitch.isBootAlive(t.bootId);
        };
        let killed = 0;
        for (const ch of await freeSwitch.channels()) {
            const tag = ch.cid_num ?? ch.cid_name ?? '';
            if (await dead(tag)) {
                await freeSwitch.api(`uuid_kill ${ch.uuid}`).catch(() => { });
                killed++;
            }
        }
        let deleted = 0;
        for (const id of await rtpLegs.list().catch(() => [])) {
            if (await dead(id)) { await rtpLegs.delete(id); deleted++; }
        }
        if (killed || deleted) log.info(`Orphan sweep: ${killed} media endpoints hung up, ${deleted} rtpengine legs deleted`);
    }
}

export const roomMedia = new RoomMedia();
