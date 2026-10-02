// src/infra/media/RtpEngineClient.js
// rtpengine's "ng" control protocol: bencoded dictionaries over UDP, each
// request prefixed with a cookie the reply echoes.
//
// rtpengine is the media edge (docs/media-architecture.md): every external
// leg — a customer over WhatsApp or SIP, an agent's WebRTC — ends on it, and
// it relays plain RTP to the leg's FreeSWITCH endpoint. One rtpengine call per
// leg, keyed by call-id; its two sides by tag (labels only, not SIP tags).
// Cookies must be unique: rtpengine answers a repeated cookie from its reply
// cache, with whatever it answered the first time.
import dgram from 'dgram';
import { logger } from '../logging/logger.js';

const log = logger('infra.media.RtpEngineClient');

function bencode(value) {
    if (typeof value === 'number' && Number.isInteger(value)) return `i${value}e`;
    if (typeof value === 'string') return `${Buffer.byteLength(value, 'utf8')}:${value}`;
    if (Array.isArray(value)) return `l${value.map(bencode).join('')}e`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter((k) => value[k] !== undefined && value[k] !== null).sort();
        return `d${keys.map((k) => bencode(k) + bencode(value[k])).join('')}e`;
    }
    throw new Error(`bencode: unsupported value type ${typeof value}`);
}

function bdecode(buf, pos) {
    const marker = String.fromCharCode(buf[pos.i]);
    if (marker === 'i') {
        pos.i += 1;
        const end = buf.indexOf(0x65, pos.i);
        const num = parseInt(buf.subarray(pos.i, end).toString('ascii'), 10);
        pos.i = end + 1;
        return num;
    }
    if (marker === 'l') {
        pos.i += 1;
        const list = [];
        while (String.fromCharCode(buf[pos.i]) !== 'e') list.push(bdecode(buf, pos));
        pos.i += 1;
        return list;
    }
    if (marker === 'd') {
        pos.i += 1;
        const dict = {};
        while (String.fromCharCode(buf[pos.i]) !== 'e') {
            const key = bdecode(buf, pos);
            dict[key] = bdecode(buf, pos);
        }
        pos.i += 1;
        return dict;
    }
    const colon = buf.indexOf(0x3a, pos.i);
    const len = parseInt(buf.subarray(pos.i, colon).toString('ascii'), 10);
    const start = colon + 1;
    const str = buf.subarray(start, start + len).toString('utf8');
    pos.i = start + len;
    return str;
}

export class RtpEngineClient {
    constructor({ host = '127.0.0.1', port = 22222, timeoutMs = 3000 } = {}) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
        this._counter = 0;
        this._pending = new Map();
        this.socket = null;
    }

    #socket() {
        if (this.socket) return this.socket;
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', (msg) => {
            const space = msg.indexOf(0x20);
            if (space < 0) return;
            const cookie = msg.subarray(0, space).toString('ascii');
            const pending = this._pending.get(cookie);
            if (!pending) return;
            this._pending.delete(cookie);
            clearTimeout(pending.timer);
            try {
                const reply = bdecode(msg, { i: space + 1 });
                if (reply.result === 'error') pending.reject(new Error(`rtpengine ${pending.command}: ${reply['error-reason']}`));
                else pending.resolve(reply);
            } catch (err) {
                pending.reject(err);
            }
        });
        this.socket.on('error', (err) => log.error({ err }, 'Socket error'));
        this.socket.unref();
        return this.socket;
    }

    send(command) {
        return new Promise((resolve, reject) => {
            const cookie = `callio_${process.pid}_${Date.now()}_${this._counter++}`;
            const packet = Buffer.from(`${cookie} ${bencode(command)}`, 'utf8');
            const timer = setTimeout(() => {
                this._pending.delete(cookie);
                reject(new Error(`rtpengine: no reply to '${command.command}' within ${this.timeoutMs}ms`));
            }, this.timeoutMs);
            this._pending.set(cookie, { resolve, reject, timer, command: command.command });
            this.#socket().send(packet, this.port, this.host, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this._pending.delete(cookie);
                    reject(err);
                }
            });
        });
    }

    // offer / answer: the reply's SDP for the other side. `flags` is the ng
    // dictionary describing that side (transport, ICE, DTLS…).
    async offer({ callId, fromTag, sdp, flags = {} }) {
        return (await this.send({ command: 'offer', 'call-id': callId, 'from-tag': fromTag, sdp, ...flags })).sdp;
    }

    async answer({ callId, fromTag, toTag, sdp, flags = {} }) {
        return (await this.send({ command: 'answer', 'call-id': callId, 'from-tag': fromTag, 'to-tag': toTag, sdp, ...flags })).sdp;
    }

    // A call's per-tag media and stats (packets, last packet, RTCP-derived quality).
    async query(callId) {
        return this.send({ command: 'query', 'call-id': callId });
    }

    // Call-ids rtpengine holds (for the orphan sweep).
    async list(limit = 1000) {
        const r = await this.send({ command: 'list', limit });
        return Array.isArray(r.calls) ? r.calls : [];
    }

    // Always on hang-up, or rtpengine keeps the ports allocated.
    // now: skip rtpengine's delete-delay (an orphan needs no grace period for
    // late packets; with the delay a sweep every delete-delay seconds would
    // keep re-deleting it and it would never go).
    async delete(callId, { now = false } = {}) {
        return this.send({ command: 'delete', 'call-id': callId, ...(now ? { 'delete-delay': 0 } : {}) }).catch((err) => {
            log.warn({ callId, err }, 'delete failed');
            return null;
        });
    }

    async ping() {
        return (await this.send({ command: 'ping' })).result === 'pong';
    }

    close() {
        for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(new Error('rtpengine client closed')); }
        this._pending.clear();
        try { this.socket?.close(); } catch { /* already closed */ }
        this.socket = null;
    }
}

export { bencode, bdecode };
