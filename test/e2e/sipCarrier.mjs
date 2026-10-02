// A fake SIP carrier for the end-to-end suites: a minimal SIP user agent over
// UDP plus G.711 μ-law RTP, playing a tone and measuring what it hears.
// It calls into Callio through the local SIP gateway (drachtio-server +
// rtpengine, deploy/sip-gateway/docker-compose.local.yml) the way a trunk
// would, and answers the calls Callio dials out through the trunk.
//
// The gateway runs in Docker with published ports, so from inside the
// containers this machine is host.docker.internal: that's the address in our
// Via/Contact. Media needs no address translation: rtpengine advertises
// 127.0.0.1 and learns our real return path from the first RTP we send.
import dgram from 'dgram';
import { randomBytes } from 'crypto';

const rand = (n = 8) => randomBytes(n).toString('hex');

// ── G.711 μ-law ─────────────────────────────────────────────────────────────
function muLawEncode(sample) {
    const BIAS = 0x84, CLIP = 32635;
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function muLawDecode(byte) {
    byte = ~byte & 0xff;
    const sign = byte & 0x80, exponent = (byte >> 4) & 0x07, mantissa = byte & 0x0f;
    const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
    return sign ? -sample : sample;
}

// ── Tone analysis (same Goertzel measure as lib.mjs listen()) ───────────────
function listener(freqs = [440, 660, 880]) {
    const stats = { packets: 0, bins: Object.fromEntries(freqs.map((f) => [f, 0])) };
    const goertzel = (samples, freq, rate) => {
        const k = 2 * Math.cos((2 * Math.PI * freq) / rate);
        let s1 = 0, s2 = 0;
        for (const x of samples) { const s0 = x + k * s1 - s2; s2 = s1; s1 = s0; }
        return s1 * s1 + s2 * s2 - k * s1 * s2;
    };
    return {
        stats,
        feed(samples) { stats.packets++; for (const f of freqs) stats.bins[f] += goertzel(samples, f, 8000); },
        reset() { stats.packets = 0; for (const f of freqs) stats.bins[f] = 0; },
        dominant() {
            const sorted = Object.entries(stats.bins).sort((a, b) => b[1] - a[1]);
            return sorted[0][1] > 10 * (sorted[1]?.[1] ?? 0) ? Number(sorted[0][0]) : 0;
        },
        has(freq) { const max = Math.max(...Object.values(stats.bins)); return max > 0 && stats.bins[freq] > max / 20; },
    };
}

// ── RTP ─────────────────────────────────────────────────────────────────────
function rtpSession({ port, freqs }) {
    const socket = dgram.createSocket('udp4');
    const ear = listener();
    let remote = null, seq = Math.floor(Math.random() * 65535), ts = 0, phases = [], timer = null;
    const ssrc = randomBytes(4).readUInt32BE(0);
    const state = { freqs: [].concat(freqs) };

    socket.on('message', (msg) => {
        if (msg.length <= 12 || (msg[0] >> 6) !== 2) return;
        const pt = msg[1] & 0x7f;
        if (pt !== 0) return; // PCMU only; telephone-event etc. ignored
        const cc = msg[0] & 0x0f;
        const payload = msg.subarray(12 + cc * 4);
        const samples = new Int16Array(payload.length);
        for (let i = 0; i < payload.length; i++) samples[i] = muLawDecode(payload[i]);
        ear.feed(samples);
    });

    const sendFrame = () => {
        if (!remote) return;
        const payload = Buffer.alloc(160);
        const amp = 8000 / Math.max(1, state.freqs.length);
        for (let i = 0; i < 160; i++) {
            let v = 0;
            state.freqs.forEach((f, j) => {
                phases[j] = (phases[j] ?? 0) + (2 * Math.PI * f) / 8000;
                v += Math.sin(phases[j]) * amp;
            });
            payload[i] = muLawEncode(Math.round(v));
        }
        const header = Buffer.alloc(12);
        header[0] = 0x80; header[1] = 0; header.writeUInt16BE(seq = (seq + 1) & 0xffff, 2);
        header.writeUInt32BE((ts = (ts + 160) >>> 0), 4); header.writeUInt32BE(ssrc, 8);
        socket.send(Buffer.concat([header, payload]), remote.port, remote.host);
    };

    return {
        ear,
        ready: new Promise((resolve) => socket.bind(port, '0.0.0.0', resolve)),
        port: () => socket.address().port,
        start(host, remotePort) { remote = { host, port: remotePort }; if (!timer) timer = setInterval(sendFrame, 20); },
        tone(next) { state.freqs = [].concat(next); phases = []; },
        close() { clearInterval(timer); timer = null; try { socket.close(); } catch { } },
    };
}

// ── SIP ─────────────────────────────────────────────────────────────────────
function parseSip(raw) {
    const text = raw.toString('utf8');
    const split = text.indexOf('\r\n\r\n');
    const head = text.slice(0, split).split('\r\n');
    const body = text.slice(split + 4);
    const start = head.shift();
    const headers = {};
    for (const line of head) {
        const i = line.indexOf(':');
        const name = line.slice(0, i).trim().toLowerCase();
        (headers[name] ??= []).push(line.slice(i + 1).trim());
    }
    const status = /^SIP\/2\.0 (\d{3})/.exec(start);
    const request = /^([A-Z]+) (\S+) SIP\/2\.0/.exec(start);
    return {
        status: status ? Number(status[1]) : null,
        method: request?.[1] ?? null,
        uri: request?.[2] ?? null,
        header: (n) => headers[n.toLowerCase()]?.[0] ?? null,
        headers,
        body,
    };
}

function sdpMedia(sdp) {
    const host = /c=IN IP4 (\S+)/.exec(sdp)?.[1];
    const port = Number(/m=audio (\d+)/.exec(sdp)?.[1]);
    return { host, port };
}

function offerSdp(rtpPort) {
    return [
        'v=0', `o=carrier ${Date.now()} 1 IN IP4 127.0.0.1`, 's=carrier', 'c=IN IP4 127.0.0.1', 't=0 0',
        `m=audio ${rtpPort} RTP/AVP 0 101`, 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:101 telephone-event/8000',
        'a=fmtp:101 0-16', 'a=ptime:20', 'a=sendrecv', '',
    ].join('\r\n');
}

/**
 * @param {object} opts
 *   gateway   { host, port } where drachtio listens (published port)
 *   sipPort   our SIP port
 *   contactHost  how the gateway reaches us (host.docker.internal)
 */
export function sipCarrier({ gateway = { host: '127.0.0.1', port: 5060 }, sipPort = 5070, contactHost = 'host.docker.internal' } = {}) {
    const socket = dgram.createSocket('udp4');
    const calls = new Map();       // Call-ID -> call
    const waiters = new Set();     // response waiters
    const inbound = [];            // INVITEs Callio sent us (outbound calls)
    let cseq = 1;

    const send = (text) => socket.send(Buffer.from(text), gateway.port, gateway.host);
    const via = () => `SIP/2.0/UDP ${contactHost}:${sipPort};branch=z9hG4bK${rand()};rport`;
    const contact = `<sip:carrier@${contactHost}:${sipPort}>`;

    function build(startLine, headers, body = '') {
        const lines = [startLine, ...headers, `Content-Length: ${Buffer.byteLength(body)}`, '', body];
        return lines.join('\r\n');
    }

    function respond(req, status, reason, { body = '', extra = [], toTag = null } = {}) {
        const to = toTag && !/;tag=/.test(req.header('to')) ? `${req.header('to')};tag=${toTag}` : req.header('to');
        send(build(`SIP/2.0 ${status} ${reason}`, [
            ...req.headers.via.map((v) => `Via: ${v}`),
            `From: ${req.header('from')}`, `To: ${to}`, `Call-ID: ${req.header('call-id')}`,
            `CSeq: ${req.header('cseq')}`, `Contact: ${contact}`, ...extra,
            ...(body ? ['Content-Type: application/sdp'] : []),
        ], body));
    }

    socket.on('message', (raw) => {
        const msg = parseSip(raw);
        const callId = msg.header('call-id');
        if (msg.status) {
            for (const w of waiters) if (w.match(msg)) { waiters.delete(w); w.resolve(msg); }
            const call = calls.get(callId);
            if (call && msg.status >= 100) call.responses.push(msg.status);
            return;
        }
        const call = calls.get(callId);
        switch (msg.method) {
            case 'BYE':
                respond(msg, 200, 'OK');
                if (call) { call.ended = 'remote'; call.rtp.close(); call.endedAt = Date.now(); }
                break;
            case 'CANCEL':
                respond(msg, 200, 'OK');
                if (call?.pendingInvite) { respond(call.pendingInvite, 487, 'Request Terminated', { toTag: call.localTag }); call.ended = 'cancelled'; call.rtp.close(); }
                break;
            case 'ACK':
                if (call) call.acked = true;
                break;
            case 'OPTIONS':
                // In-dialog keep-alive: a dialog we hung up no longer exists.
                if (call?.ended) respond(msg, 481, 'Call/Transaction Does Not Exist');
                else respond(msg, 200, 'OK');
                if (call) call.optionsSeen = (call.optionsSeen ?? 0) + 1;
                break;
            case 'INVITE':
                if (call) { respond(msg, 200, 'OK', { body: call.localSdp, toTag: call.localTag }); break; } // re-INVITE
                inbound.push(msg);
                break;
            default:
                respond(msg, 405, 'Method Not Allowed');
        }
    });

    const waitResponse = (match, timeoutMs = 10000) => new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.add(w);
        setTimeout(() => { if (waiters.delete(w)) reject(new Error('SIP response timeout')); }, timeoutMs);
    });

    function newCall({ callId, from, to, freqs, rtpPort }) {
        const call = {
            callId, from, to, localTag: rand(4), remoteTag: null, remoteContact: null,
            rtp: rtpSession({ port: rtpPort, freqs }), responses: [], acked: false, ended: null,
            answeredAt: null, endedAt: null, pendingInvite: null, inviteCseq: null,
        };
        calls.set(callId, call);
        return call;
    }

    function inDialog(call, method, seq) {
        const target = call.remoteContact ?? `sip:${call.to}@${gateway.host}:${gateway.port}`;
        const fromHeader = call.direction === 'in'
            ? `<sip:${call.from}@carrier.test>;tag=${call.localTag}`
            : `<sip:${call.to}@carrier.test>;tag=${call.localTag}`;
        const toHeader = call.direction === 'in'
            ? `<sip:${call.to}@callio.test>;tag=${call.remoteTag}`
            : `${call.remoteFrom}`;
        return build(`${method} ${target} SIP/2.0`, [
            `Via: ${via()}`, 'Max-Forwards: 70', `From: ${fromHeader}`, `To: ${toHeader}`,
            `Call-ID: ${call.callId}`, `CSeq: ${seq} ${method}`, `Contact: ${contact}`,
        ]);
    }

    return {
        calls,
        inbound,
        listen: () => new Promise((resolve) => socket.bind(sipPort, '0.0.0.0', resolve)),
        close() { for (const c of calls.values()) c.rtp.close(); try { socket.close(); } catch { } },

        /**
         * The carrier delivers a call from `from` to the DID `to`. Resolves once
         * the INVITE is sent; `answered` resolves when Callio answers (200 OK,
         * ACKed, RTP flowing), `failed` with the final error status otherwise.
         */
        async callIn({ from = '+96181030841', to, freqs = [440], rtpPort = 0 } = {}) {
            const callId = `${rand(12)}@carrier.test`;
            const call = newCall({ callId, from, to, freqs, rtpPort });
            call.direction = 'in';
            await call.rtp.ready;
            call.inviteCseq = cseq++;
            const sdp = offerSdp(call.rtp.port());
            const inviteVia = via();
            call.inviteVia = inviteVia;
            send(build(`INVITE sip:${to}@${gateway.host}:${gateway.port} SIP/2.0`, [
                `Via: ${inviteVia}`, 'Max-Forwards: 70',
                `From: <sip:${from}@carrier.test>;tag=${call.localTag}`, `To: <sip:${to}@callio.test>`,
                `Call-ID: ${callId}`, `CSeq: ${call.inviteCseq} INVITE`, `Contact: ${contact}`,
                'Content-Type: application/sdp',
            ], sdp));
            call.answered = waitResponse((m) => m.header('call-id') === callId && /INVITE/.test(m.header('cseq')) && m.status >= 200, 60000)
                .then((res) => {
                    if (res.status !== 200) { call.ended = `failed:${res.status}`; call.rtp.close(); throw Object.assign(new Error(`INVITE ${res.status}`), { status: res.status }); }
                    call.remoteTag = /;tag=([^;>\s]+)/.exec(res.header('to'))?.[1];
                    call.remoteContact = /<([^>]+)>/.exec(res.header('contact') ?? '')?.[1] ?? null;
                    // Our ACK goes to the gateway's published port whatever its Contact says.
                    send(build(`ACK ${call.remoteContact ?? `sip:${to}@${gateway.host}`} SIP/2.0`, [
                        `Via: ${via()}`, 'Max-Forwards: 70', `From: <sip:${from}@carrier.test>;tag=${call.localTag}`,
                        `To: ${res.header('to')}`, `Call-ID: ${callId}`, `CSeq: ${call.inviteCseq} ACK`,
                    ]));
                    const media = sdpMedia(res.body);
                    call.rtp.start(media.host === '0.0.0.0' ? '127.0.0.1' : media.host, media.port);
                    call.answeredAt = Date.now();
                    return call;
                });
            call.answered.catch(() => { });
            return call;
        },

        // The carrier's caller hangs up an answered call (BYE).
        async hangUp(call) {
            const seq = cseq++;
            send(inDialog(call, 'BYE', seq));
            call.ended = 'local'; call.endedAt = Date.now();
            call.rtp.close();
            await waitResponse((m) => m.header('call-id') === call.callId && /BYE/.test(m.header('cseq')), 5000).catch(() => null);
        },

        // The caller gives up before an answer (CANCEL).
        async cancel(call) {
            send(build(`CANCEL sip:${call.to}@${gateway.host}:${gateway.port} SIP/2.0`, [
                `Via: ${call.inviteVia}`, 'Max-Forwards: 70', `From: <sip:${call.from}@carrier.test>;tag=${call.localTag}`,
                `To: <sip:${call.to}@callio.test>`, `Call-ID: ${call.callId}`, `CSeq: ${call.inviteCseq} CANCEL`,
            ]));
            call.ended = 'cancelled'; call.rtp.close();
            await waitResponse((m) => m.header('call-id') === call.callId && /CANCEL/.test(m.header('cseq')), 5000).catch(() => null);
        },

        /**
         * Answers the next INVITE Callio sends through the trunk (an outbound
         * call): 180, then 200 OK after ringMs. decline: a final status instead.
         */
        async answerNext({ ringMs = 500, freqs = [440], rtpPort = 0, decline = null, timeoutMs = 15000 } = {}) {
            const start = Date.now();
            while (!inbound.length) {
                if (Date.now() - start > timeoutMs) throw new Error('no INVITE from Callio');
                await new Promise((r) => setTimeout(r, 50));
            }
            const invite = inbound.shift();
            const callId = invite.header('call-id');
            const user = /sip:([^@;>]+)@/.exec(invite.uri)?.[1];
            const call = newCall({ callId, from: invite.header('from'), to: user, freqs, rtpPort });
            call.direction = 'out';
            call.invite = invite;
            call.pendingInvite = invite;
            call.remoteFrom = invite.header('from');
            call.remoteContact = /<([^>]+)>/.exec(invite.header('contact') ?? '')?.[1] ?? null;
            await call.rtp.ready;
            respond(invite, 100, 'Trying');
            respond(invite, 180, 'Ringing', { toTag: call.localTag });
            await new Promise((r) => setTimeout(r, ringMs));
            if (call.ended) return call;
            call.pendingInvite = null;
            if (decline) {
                respond(invite, decline, decline === 486 ? 'Busy Here' : 'Declined', { toTag: call.localTag });
                call.ended = `declined:${decline}`;
                call.rtp.close();
                return call;
            }
            call.localSdp = offerSdp(call.rtp.port()).replace('s=carrier', 's=carrier-answer');
            respond(invite, 200, 'OK', { body: call.localSdp, toTag: call.localTag });
            const media = sdpMedia(invite.body);
            call.rtp.start(media.host === '0.0.0.0' ? '127.0.0.1' : media.host, media.port);
            call.answeredAt = Date.now();
            return call;
        },
    };
}
