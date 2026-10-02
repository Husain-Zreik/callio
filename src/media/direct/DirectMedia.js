// src/media/direct/DirectMedia.js
// The media port (core/media/CallMedia.js) for DIRECT calls: rtpengine alone
// bridges the customer and the agent — one rtpengine call per Callio call, no
// FreeSWITCH (docs/direct-lines.md, Part B). Its two sides are tagged 'ext'
// (the customer, as on a room's customer leg, so CustomerLegMonitor reads it
// unchanged) and 'agent'. The key is `callio.<bootId>.<callId>.direct`, the
// rooms' tag format, so the orphan sweep and a taking-over worker treat it
// like any leg.
//
//   inbound   the customer's offer → rtpengine → the agent's offer (offerAgent);
//             the agent's answer → rtpengine → the answer the provider gets
//             (agentAccepted, then answerCustomer returns it)
//   outbound  the agent's offer → rtpengine → the offer to dial with; the agent
//             is answered at once against a placeholder customer (answerAgent),
//             and the provider's answer updates rtpengine when it comes
//             (customerAnswered)
//   reconnect a new offer from the agent, answered with the customer's SDP as
//             rtpengine last saw it
//
// Rooms do what this can't: prompts, DTMF, hold music, recording, whisper and
// barge. MediaTopology never makes such a call DIRECT; asking anyway fails.
import EventBus from '../../core/EventBus.js';
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import { customerChannels } from '../../core/channels/CustomerChannels.js';
import { ConnectionType } from '../../core/constants/CallConstants.js';
import { RtpEngineClient } from '../../infra/media/RtpEngineClient.js';
import { callState } from '../../infra/cluster/CallState.js';
import { bootId } from '../../infra/cluster/WorkerBoot.js';
import { EXTERNAL } from '../rooms/RtpLegs.js';
import { CustomerLegMonitor } from '../rooms/CustomerLegMonitor.js';
import { dedupeCodecs } from './directSdp.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.direct.DirectMedia');

const AGENT_AUDIO_TIMEOUT_MS = 5000;
const CUSTOMER = 'ext';
const AGENT = 'agent';

// The customer's side before an outbound call is answered: a real-looking
// address with nothing behind it (TEST-NET-1). c=0.0.0.0 would mean "on hold"
// and stop the agent sending.
const PLACEHOLDER = [
    'v=0', 'o=- 0 0 IN IP4 192.0.2.1', 's=-', 'c=IN IP4 192.0.2.1', 't=0 0',
    'm=audio 9 RTP/AVP 0 8 101', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', 'a=sendrecv', '',
].join('\r\n');

// A SIP carrier is offered G.711 only (the agent's browser speaks it, so
// rtpengine only re-encrypts).
const G711 = { codec: { strip: ['all'], offer: ['PCMU', 'PCMA', 'telephone-event'] } };

class DirectCall {
    constructor(callId) {
        this.callId = Number(callId);
        this.key = `callio.${bootId}.${callId}.direct`;
        this.transport = null;        // the customer's: 'webrtc' | 'rtp'
        this.outbound = false;
        this.customerSdp = null;      // the provider's SDP as rtpengine got it
        this.customerAnswer = null;   // inbound: what the provider is answered with
        this.customerOffer = null;    // outbound: what the provider is dialled with
        this.customerUp = false;      // the provider's side is connected
        this.agentOffered = false;    // inbound: an agent offer waits for an answer
        this.agentId = null;          // the agent on the call
        this.bridged = false;
        this.subscriptions = new Map();   // supervisorId → { toTag, answered }
        this.monitor = null;
        this.chain = Promise.resolve();
    }
}

class DirectMedia {
    constructor() {
        this.calls = new Map();
        this.client = null;
    }

    // ── internals ──────────────────────────────────────────────────────────────

    _rtp() {
        if (!this.client) this.client = new RtpEngineClient(config.sip.rtpengine);
        return this.client;
    }

    _direction() {
        const { externalInterface } = config.sip.rtpengine;
        return { direction: [externalInterface, externalInterface] };
    }

    _get(callId) {
        return this.calls.get(String(callId)) ?? null;
    }

    _call(callId) {
        const key = String(callId);
        let c = this.calls.get(key);
        if (!c) { c = new DirectCall(callId); this.calls.set(key, c); }
        return c;
    }

    // One operation at a time per call; the state is saved after each.
    _serial(callId, fn) {
        const c = this._call(callId);
        const run = c.chain.then(async () => {
            try {
                return await fn(c);
            } finally {
                if (this.calls.get(String(c.callId)) === c) await this._save(c).catch((err) => log.warn({ callId: c.callId, err }, 'Saving the call state failed'));
            }
        });
        c.chain = run.catch(() => { });
        return run;
    }

    async _save(c) {
        await callState.save(c.callId, 'direct', {
            key: c.key, transport: c.transport, outbound: c.outbound, customerSdp: c.customerSdp,
            customerAnswer: c.customerAnswer, customerOffer: c.customerOffer, customerUp: c.customerUp,
            agentOffered: c.agentOffered, agentId: c.agentId, bridged: c.bridged,
            subscriptions: [...c.subscriptions.entries()], savedAt: Date.now(),
        });
    }

    _profile(call) {
        return customerChannels.has(call.channel) ? customerChannels.get(call.channel).sdp : null;
    }

    _customerFlags(c, { offer = false } = {}) {
        const base = EXTERNAL[c.transport] ?? EXTERNAL.webrtc;
        return offer && c.transport === 'rtp' ? { ...base, ...G711 } : base;
    }

    async _offer(c, fromTag, toTag, sdp, flags) {
        const reply = await this._rtp().send({
            command: 'offer', 'call-id': c.key, 'from-tag': fromTag, ...(toTag ? { 'to-tag': toTag } : {}), sdp, ...flags, ...this._direction(),
        });
        return reply.sdp;
    }

    _answer(c, fromTag, toTag, sdp, flags) {
        return this._rtp().answer({ callId: c.key, fromTag, toTag, sdp, flags });
    }

    async _packets(c, tag) {
        const q = await this._rtp().query(c.key).catch(() => null);
        return q?.tags?.[tag]?.medias?.[0]?.streams?.[0]?.stats?.packets ?? 0;
    }

    async _awaitAgentAudio(c) {
        const deadline = Date.now() + AGENT_AUDIO_TIMEOUT_MS;
        while (await this._packets(c, AGENT) === 0) {
            if (Date.now() > deadline) throw new Error(`Microphone audio did not reach the server within ${AGENT_AUDIO_TIMEOUT_MS / 1000}s`);
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    _watchCustomer(c) {
        if (c.monitor) return;
        c.monitor = new CustomerLegMonitor(c.callId, c.key);
        c.monitor.start();
    }

    _unsupported(what) {
        return new Error(`${what} is not available on a direct call`);
    }

    // ── customer ───────────────────────────────────────────────────────────────

    // Inbound: the answer rtpengine made for the provider when the agent answered.
    answerCustomer(call) {
        return this._serial(call.id, async (c) => {
            if (!c.customerAnswer) throw new Error('No agent has answered this direct call yet');
            c.customerUp = true;
            return c.customerAnswer;
        });
    }

    // Outbound: the offer rtpengine made from the agent's (answerAgent).
    offerCustomer(call, profile) {
        return this._serial(call.id, async (c) => {
            if (!c.customerOffer) throw new Error('The agent has not started this direct call');
            return profile?.localOffer ? profile.localOffer(c.customerOffer) : c.customerOffer;
        });
    }

    customerAnswered(call, sdpAnswer, profile) {
        return this._serial(call.id, async (c) => {
            const sdp = dedupeCodecs(profile?.remoteAnswer ? profile.remoteAnswer(sdpAnswer) : sdpAnswer);
            await this._answer(c, AGENT, CUSTOMER, sdp, EXTERNAL.webrtc);
            c.customerSdp = sdp;
            c.customerUp = true;
            this._watchCustomer(c);
        });
    }

    async customerAudio(callId, timeoutMs) {
        const c = this._get(callId);
        if (!c) return false;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await this._packets(c, CUSTOMER) > 0) return true;
            if (Date.now() > deadline) return false;
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    // ── agent ──────────────────────────────────────────────────────────────────

    // Inbound: the customer's offer through rtpengine, for the agent's devices.
    // Offering again (a redelivery, the next agent) re-offers the same.
    offerAgent(call) {
        return this._serial(call.id, async (c) => {
            if (!c.customerSdp) {
                const conn = await CallConnectionRepository.findByCallAndType(call.id, ConnectionType.CUSTOMER);
                if (!conn?.remote_sdp) throw new Error('Customer offer not found');
                const profile = this._profile(call);
                c.transport = profile?.transport ?? 'webrtc';
                c.customerSdp = dedupeCodecs(profile?.remoteOffer ? profile.remoteOffer(conn.remote_sdp) : conn.remote_sdp);
            }
            const offer = await this._offer(c, CUSTOMER, null, c.customerSdp, EXTERNAL.webrtc);
            c.agentOffered = true;
            log.debug({ callId: c.callId }, 'Direct agent offer made');
            return offer;
        });
    }

    agentAccepted(call, agentId, sdpAnswer) {
        return this._serial(call.id, async (c) => {
            if (!c.agentOffered) throw new Error('No agent leg offered on this worker');
            c.agentOffered = false;
            c.customerAnswer = await this._answer(c, CUSTOMER, AGENT, sdpAnswer, this._customerFlags(c));
            await this._awaitAgentAudio(c);
            c.agentId = String(agentId);
            this._watchCustomer(c);
        });
    }

    // The agent offers: outbound call:start, or a reconnect.
    answerAgent(call, agentId, sdpOffer) {
        return this._serial(call.id, async (c) => {
            let answer;
            if (!c.customerSdp && !c.customerOffer) {
                // Outbound: the agent's offer becomes the offer to dial with, and the
                // agent is answered at once against a placeholder customer.
                c.outbound = true;
                c.transport = this._profile(call)?.transport ?? 'rtp';
                c.customerOffer = await this._offer(c, AGENT, null, sdpOffer, this._customerFlags(c, { offer: true }));
                answer = await this._answer(c, AGENT, CUSTOMER, PLACEHOLDER, EXTERNAL.webrtc);
            } else {
                // Reconnect: the agent's new offer, answered with the customer as
                // rtpengine knows it (or the placeholder while they're not up yet).
                await this._offer(c, AGENT, CUSTOMER, sdpOffer, this._customerFlags(c));
                answer = await this._answer(c, AGENT, CUSTOMER, c.customerSdp ?? PLACEHOLDER, EXTERNAL.webrtc);
            }
            c.agentId = String(agentId);
            return answer;
        });
    }

    // The agent's leg is gone (reconnect pending, transfer): nothing plays on a
    // direct call, so the customer hears silence until an agent is back.
    dropAgent(callId, agentId = null) {
        if (!this._get(callId)) return Promise.resolve();
        return this._serial(callId, async (c) => {
            if (agentId == null || String(c.agentId) === String(agentId)) c.agentId = null;
        });
    }

    hasAgentOffer(callId) {
        return Boolean(this._get(callId)?.agentOffered);
    }

    // Both sides are already joined in rtpengine.
    bridge(call) {
        return this._serial(call.id, async (c) => {
            if (!c.customerUp || !c.agentId) return false;
            if (!c.bridged) {
                c.bridged = true;
                EventBus.emit('call:queue_audio_stop', { callId: c.callId });
                log.info({ callId: c.callId }, 'Direct call bridged');
            }
            return true;
        });
    }

    // ── supervisors ────────────────────────────────────────────────────────────

    // A supervisor listens through an rtpengine subscription to both sides:
    // rtpengine offers (one audio line per side), the supervisor answers.
    // Nothing flows back into the call — a direct call is listen-only.
    async addSupervisor() {
        throw this._unsupported('Listening with the supervisor\'s own offer (monitor without an offer)');
    }

    offerSupervisor(call, supervisorId) {
        return this._serial(call.id, async (c) => {
            const previous = c.subscriptions.get(String(supervisorId));
            if (previous) await this._unsubscribe(c, previous.toTag);
            const reply = await this._rtp().send({
                command: 'subscribe request', 'call-id': c.key, 'from-tags': [CUSTOMER, AGENT], ...EXTERNAL.webrtc, ...this._direction(),
            });
            c.subscriptions.set(String(supervisorId), { toTag: reply['to-tag'], answered: false });
            return reply.sdp;
        });
    }

    supervisorAnswered(call, supervisorId, sdpAnswer) {
        return this._serial(call.id, async (c) => {
            const sub = c.subscriptions.get(String(supervisorId));
            if (!sub) throw new Error('No supervisor leg offered on this worker');
            await this._rtp().send({ command: 'subscribe answer', 'call-id': c.key, 'to-tag': sub.toTag, sdp: sdpAnswer, ...EXTERNAL.webrtc });
            sub.answered = true;
        });
    }

    async _unsubscribe(c, toTag) {
        await this._rtp().send({ command: 'unsubscribe', 'call-id': c.key, 'to-tag': toTag })
            .catch((err) => log.debug({ callId: c.callId, err }, 'Unsubscribe failed'));
    }

    async setSupervisorMode(callId, mode) {
        if (mode !== 'listen') throw this._unsupported(`'${mode}'`);
        return false;
    }

    async setAgentPrivate() {
        return false;
    }

    removeSupervisor(callId, supervisorId) {
        if (!this._get(callId)) return Promise.resolve(false);
        return this._serial(callId, async (c) => {
            const ids = supervisorId != null ? [String(supervisorId)] : [...c.subscriptions.keys()];
            for (const id of ids) {
                const sub = c.subscriptions.get(id);
                if (!sub) continue;
                c.subscriptions.delete(id);
                await this._unsubscribe(c, sub.toTag);
            }
            return false;
        });
    }

    hasSupervisor(callId) {
        return [...(this._get(callId)?.subscriptions.values() ?? [])].some((s) => s.answered);
    }

    monitorState(callId) {
        return this.hasSupervisor(callId) ? { mode: 'listen', agentPrivate: false } : null;
    }

    // ── customer audio (rooms only) ────────────────────────────────────────────

    player() {
        return {
            play: async () => { throw this._unsupported('Playing audio'); },
            stop: () => { },
        };
    }

    listenForDigits() { }

    async startHold() { }

    async stopHold() { }

    audioUrl() {
        return null;
    }

    errorAudio() {
        return null;
    }

    // ── lifecycle ──────────────────────────────────────────────────────────────

    close(callId) {
        if (!this._get(callId)) return Promise.resolve();
        return this._serial(callId, async (c) => {
            if (this.calls.get(String(callId)) !== c) return;
            this.calls.delete(String(callId));
            c.monitor?.stop();
            await this._rtp().delete(c.key, { now: true });
            await callState.drop(callId, 'direct').catch(() => { });
            log.debug({ callId }, 'Direct call closed');
        });
    }

    owns(callId) {
        return this.calls.has(String(callId));
    }

    activeCallIds() {
        return [...this.calls.keys()].map(Number);
    }

    // Takes over a direct call whose worker stopped: the rtpengine call never
    // stopped either, so this is just its state back from Redis.
    adopt(call) {
        return this._serial(call.id, async (c) => {
            if (c.customerSdp || c.customerOffer) return true;
            const snap = await callState.load(call.id, 'direct');
            if (!snap) {
                this.calls.delete(String(call.id));
                return false;
            }
            Object.assign(c, {
                key: snap.key, transport: snap.transport, outbound: snap.outbound, customerSdp: snap.customerSdp,
                customerAnswer: snap.customerAnswer, customerOffer: snap.customerOffer, customerUp: snap.customerUp,
                agentOffered: snap.agentOffered, agentId: snap.agentId, bridged: snap.bridged,
                subscriptions: new Map(snap.subscriptions ?? []),
            });
            if (c.customerUp) this._watchCustomer(c);
            log.info({ callId: c.callId }, 'Direct call adopted');
            return true;
        });
    }

    // Shutdown: let go of every call without ending it (another worker adopts).
    handOver() {
        for (const c of this.calls.values()) c.monitor?.stop();
        const count = this.calls.size;
        this.calls.clear();
        return count;
    }

    stats() {
        return { direct: this.calls.size };
    }

    async start() { }

    async stop() {
        await Promise.all(this.activeCallIds().map((id) => this.close(id).catch(() => { })));
        this.client?.close();
        this.client = null;
    }
}

export const directMedia = new DirectMedia();
