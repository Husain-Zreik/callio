// Shared pieces of the end-to-end suites (see test/e2e/README.md).
import http from 'http';
import { createRequire } from 'module';
import { createHmac } from 'crypto';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';

const require = createRequire(import.meta.url);
export const wrtc = require('@roamhq/wrtc');
export const mysql = require('mysql2/promise');
const { RTCPeerConnection, nonstandard: { RTCAudioSource, RTCAudioSink } } = wrtc;

// The test database, as set up by run.mjs.
export function testDb() {
    return mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
    });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeChecks() {
    const results = [];
    const check = (name, ok, detail = '') => {
        results.push({ name, ok: Boolean(ok) });
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    };
    const summary = () => {
        const failed = results.filter((r) => !r.ok).length;
        console.log(`\n${results.length - failed}/${results.length} checks passed`);
        return failed;
    };
    return { check, summary };
}

export async function waitFor(fn, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const v = await fn();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

// A source that plays the sum of `freqs` (changeable at runtime, e.g. DTMF).
export function toneTrack(freqs) {
    const source = new RTCAudioSource();
    const track = source.createTrack();
    const state = { freqs: [].concat(freqs), phases: [] };
    const timer = setInterval(() => {
        const samples = new Int16Array(480);
        const amp = 8000 / Math.max(1, state.freqs.length);
        for (let i = 0; i < 480; i++) {
            let v = 0;
            state.freqs.forEach((f, j) => {
                state.phases[j] = (state.phases[j] ?? 0) + (2 * Math.PI * f) / 48000;
                v += Math.sin(state.phases[j]) * amp;
            });
            samples[i] = Math.round(v);
        }
        source.onData({ samples, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
    }, 10);
    return {
        track,
        set(freqs) { state.freqs = [].concat(freqs); state.phases = []; },
        stop() { clearInterval(timer); track.stop(); },
    };
}

// Goertzel energy at each test tone; dominant() names the loudest one when it
// beats every other by 10x, else 0.
export function listen(track, freqs = [440, 660, 880]) {
    const sink = new RTCAudioSink(track);
    const stats = { frames: 0, samples: 0, energy: 0, bins: Object.fromEntries(freqs.map((f) => [f, 0])) };
    const goertzel = (samples, step, freq, rate) => {
        const k = 2 * Math.cos((2 * Math.PI * freq) / rate);
        let s1 = 0, s2 = 0;
        for (let i = 0; i < samples.length; i += step) { const s0 = samples[i] + k * s1 - s2; s2 = s1; s1 = s0; }
        return s1 * s1 + s2 * s2 - k * s1 * s2;
    };
    sink.ondata = ({ samples, sampleRate, channelCount }) => {
        const step = channelCount || 1;
        stats.frames++;
        for (const f of freqs) stats.bins[f] += goertzel(samples, step, f, sampleRate || 48000);
        for (let i = 0; i < samples.length; i += step) { stats.energy += samples[i] * samples[i]; stats.samples++; }
    };
    return {
        stats,
        reset() { stats.frames = 0; stats.samples = 0; stats.energy = 0; for (const f of freqs) stats.bins[f] = 0; },
        dominant() {
            const sorted = Object.entries(stats.bins).sort((a, b) => b[1] - a[1]);
            return sorted[0][1] > 10 * (sorted[1]?.[1] ?? 0) ? Number(sorted[0][0]) : 0;
        },
        has(freq) { const max = Math.max(...Object.values(stats.bins)); return stats.bins[freq] > max / 20 && max > 0; },
        rms() { return stats.samples ? Math.round(Math.sqrt(stats.energy / stats.samples)) : 0; },
        stop() { sink.stop(); },
    };
}

export async function gathered(pc, timeoutMs = 4000) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
        });
    });
}

// audioLines > 1 adds extra audio transceivers (a supervisor receives the
// agent and the customer as separate tracks). tracks collects a listener per
// received track; received resolves with the first.
export function newPeer(freq, { audioLines = 1 } = {}) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const tone = toneTrack(freq);
    pc.addTrack(tone.track);
    for (let i = 1; i < audioLines; i++) pc.addTransceiver("audio", { direction: "recvonly" });
    const tracks = [];
    const received = new Promise((resolve) => { pc.ontrack = (e) => { const l = listen(e.track); tracks.push(l); if (tracks.length === 1) resolve(l); }; });
    return { pc, tone, received, tracks, close() { try { tone.stop(); pc.close(); } catch { } } };
}

// Measures what `listener` hears over `ms`, after a settle period.
export async function hear(listener, ms = 3000, settleMs = 2000) {
    await sleep(settleMs);
    listener.reset();
    await sleep(ms);
    return listener;
}

// ── Fake Meta Graph API + customer simulation ─────────────────────────────────

// Outbound calls to this number fail at the Graph API.
export const UNREACHABLE_NUMBER = '96181030899';

export function fakeMeta({ callioUrl, apiKey, phoneNumberId, port = 3990 }) {
    const customers = new Map();
    const calls = [];
    let outbound = 0;
    const metadata = { display_phone_number: '96170000000', phone_number_id: phoneNumberId };
    const ts = () => String(Math.floor(Date.now() / 1000));

    async function post(value) {
        const res = await fetch(`${callioUrl}/v1/webhooks/whatsapp/forward`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata, ...value } }] }] }),
        });
        return res.status;
    }

    function terminateWebhook(id, customer) {
        const now = Math.floor(Date.now() / 1000);
        const start = customer?.answeredAt ?? null;
        return post({ calls: [{ id, event: 'terminate', status: 'COMPLETED', timestamp: String(now),
            ...(start ? { start_time: String(start), end_time: String(now), duration: String(now - start) } : {}) }] });
    }

    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path: req.url, auth: req.headers.authorization, body });
        const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (!req.url.replace(/\/+/g, '/').endsWith(`/${phoneNumberId}/calls`)) return reply(404, { error: { message: 'unknown path' } });

        if (body.action === 'accept') {
            const customer = customers.get(body.call_id);
            if (!customer) return reply(400, { error: { message: 'unknown call' } });
            await customer.pc.setRemoteDescription({ type: 'answer', sdp: body.session.sdp });
            customer.answeredAt = Math.floor(Date.now() / 1000);
            reply(200, { success: true });
            setTimeout(() => post({ statuses: [{ id: body.call_id, type: 'call', status: 'ACCEPTED', timestamp: ts() }] }), 200);
            return;
        }
        if (body.action === 'terminate' || body.action === 'reject') {
            reply(200, { success: true });
            const customer = customers.get(body.call_id);
            if (customer?.ended) return;
            if (customer) customer.ended = true;
            setTimeout(() => { terminateWebhook(body.call_id, customer); customer?.close(); }, 300);
            return;
        }
        if (body.action === 'connect') {
            // A number Meta refuses to call (e.g. not on WhatsApp).
            if (String(body.to).replace(/\D/g, '') === UNREACHABLE_NUMBER) {
                return reply(400, { error: { message: 'Recipient is not a valid WhatsApp user', code: 138006 } });
            }
            const id = `wacid.out.${++outbound}`;
            reply(200, { messaging_product: 'whatsapp', calls: [{ id }] });
            const customer = newPeer(440);
            customers.set(id, customer);
            await customer.pc.setRemoteDescription({ type: 'offer', sdp: body.session.sdp });
            await customer.pc.setLocalDescription(await customer.pc.createAnswer());
            await gathered(customer.pc);
            await post({ statuses: [{ id, type: 'call', status: 'RINGING', timestamp: ts() }] });
            await sleep(300);
            await post({ calls: [{ id, to: body.to, from: '96170000000', event: 'connect', direction: 'BUSINESS_INITIATED', timestamp: ts(),
                session: { sdp_type: 'answer', sdp: customer.pc.localDescription.sdp } }] });
            customer.answeredAt = Math.floor(Date.now() / 1000);
            await post({ statuses: [{ id, type: 'call', status: 'ACCEPTED', timestamp: ts() }] });
            return;
        }
        reply(400, { error: { message: `unsupported action ${body.action}` } });
    });

    return {
        customers,
        calls,
        post,
        listen: () => new Promise((r) => server.listen(port, '127.0.0.1', r)),
        close: () => { for (const c of customers.values()) c.close(); server.close(); },
        // A customer calls in; resolves with { id, customer } once the webhook is accepted.
        async callIn(id, { from = '96181030841', name = 'Test Customer', freq = 440 } = {}) {
            const customer = newPeer(freq);
            customers.set(id, customer);
            await customer.pc.setLocalDescription(await customer.pc.createOffer());
            await gathered(customer.pc);
            const status = await post({
                contacts: [{ profile: { name }, wa_id: from }],
                calls: [{ id, from, to: '96170000000', event: 'connect', direction: 'USER_INITIATED', timestamp: ts(),
                    session: { sdp_type: 'offer', sdp: customer.pc.localDescription.sdp } }],
            });
            return { id, customer, status };
        },
        // The customer hangs up (Meta sends terminate).
        async hangUp(id) {
            const customer = customers.get(id);
            if (customer) customer.ended = true;
            const status = await terminateWebhook(id, customer);
            customer?.close();
            return status;
        },
    };
}

// ── Consumer event receiver ───────────────────────────────────────────────────

export function eventReceiver({ secret, port = 3999 }) {
    const events = [];
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const [, t, v1] = /t=(\d+),v1=([a-f0-9]+)/.exec(String(req.headers['x-callio-signature'] || '')) || [];
        const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
        const body = JSON.parse(raw);
        events.push({ type: body.event_type, eventId: body.event_id, callId: body.data?.call?.callId, validSignature: v1 === expected, body });
        res.writeHead(200); res.end('ok');
    });
    return { events, listen: () => new Promise((r) => server.listen(port, '127.0.0.1', r)), close: () => server.close() };
}

// ── Agents ────────────────────────────────────────────────────────────────────

export function agentToken(seed, ref, role = 'AGENT') {
    return jwt.sign({ iss: 'dev', sub: ref, tnt: 'demo', name: ref, role }, seed.signing_key.secret,
        { algorithm: 'HS256', keyid: seed.signing_key.kid, expiresIn: '10m' });
}

export function connectAgent(callioUrl, seed, ref, role = 'AGENT', deviceId = `${ref}-device`) {
    return new Promise((resolve, reject) => {
        const socket = io(callioUrl, { transports: ['websocket'], auth: { token: agentToken(seed, ref, role), device_id: deviceId, protocol: 1 }, reconnection: false });
        const agent = { ref, socket, incoming: [], events: [], errors: [], pendingCandidates: [], peer: null };
        socket.on('connect', () => resolve(agent));
        socket.on('connect_error', reject);
        socket.onAny((event, payload) => agent.events.push({ event, payload }));
        socket.on('call:incoming', (p) => agent.incoming.push(p));
        socket.on('call:error', (e) => agent.errors.push(e));
        socket.on('connection:ice-candidate:server', async ({ candidate }) => {
            if (!candidate) return;
            if (agent.peer?.pc?.remoteDescription) await agent.peer.pc.addIceCandidate(candidate).catch(() => { });
            else agent.pendingCandidates.push(candidate);
        });
    });
}

// Answers an offered/assigned call from `payload` with a tone at `freq`.
export async function accept(agent, payload, freq) {
    agent.peer?.close();
    agent.peer = newPeer(freq);
    await agent.peer.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdpOffer });
    for (const c of agent.pendingCandidates.splice(0)) await agent.peer.pc.addIceCandidate(c).catch(() => { });
    await agent.peer.pc.setLocalDescription(await agent.peer.pc.createAnswer());
    await gathered(agent.peer.pc);
    agent.socket.emit('call:accept', { callId: payload.callId, sdpAnswer: agent.peer.pc.localDescription.sdp });
    return agent.peer;
}

export async function nextIncoming(agent, callId, timeoutMs = 10000, predicate = () => true) {
    return waitFor(() => agent.incoming.find((p) => String(p.callId) === String(callId) && predicate(p)), timeoutMs, `${agent.ref} call:incoming for ${callId}`);
}

export function api(callioUrl, apiKey) {
    return async (method, path, body, headers = {}) => {
        const res = await fetch(`${callioUrl}${path}`, {
            method,
            headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    };
}

// A mono 16-bit PCM WAV of `seconds` of `freq` Hz.
export function wav(freq, seconds, rate = 16000) {
    const n = Math.round(rate * seconds);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000), 44 + i * 2);
    return buf;
}
