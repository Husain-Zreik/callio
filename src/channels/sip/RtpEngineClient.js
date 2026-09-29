// src/channels/sip/RtpEngineClient.js
// rtpengine's "ng" control protocol: bencoded dictionaries over UDP, each
// request prefixed with a cookie the reply echoes. Promoted from
// deploy/sip-gateway/test/rtpengine-ng-client.js.
//
// rtpengine is the SIP channel's media converter: it relays the carrier's
// plain RTP to and from a WebRTC session (ICE + DTLS-SRTP) that Callio's
// media engine terminates like any other customer leg. A call is keyed by
// call-id; each side by a tag. rtpengine never parses SIP, so the tags are
// just labels for the two sides — not the SIP From/To tags.
import dgram from 'dgram';
import { logger } from '../../infra/logging/logger.js';

const log = logger('channels.sip.RtpEngineClient');

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

// What each side of the conversion looks like on the wire. The DTLS role is
// left to rtpengine: forcing 'passive' makes it answer a=setup:passive, which
// libwebrtc (as the offerer) refuses to apply.
const TO_WEBRTC = {
    'transport-protocol': 'UDP/TLS/RTP/SAVPF',
    ICE: 'force',
    'rtcp-mux': ['require'],
    SDES: ['off'],
    flags: ['generate mid'],
};
const TO_CARRIER = {
    'transport-protocol': 'RTP/AVP',
    ICE: 'remove',
    'rtcp-mux': ['demux'],
    DTLS: 'off',
    SDES: ['off'],
};

export class RtpEngineClient {
    constructor({ host = '127.0.0.1', port = 22222, timeoutMs = 3000, carrierInterface = null, webrtcInterface = null } = {}) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
        // Named rtpengine interfaces for each side (rtpengine.conf
        // `interface = carrier/…;webrtc/…`); unset = rtpengine's only interface.
        this.direction = carrierInterface && webrtcInterface ? { carrier: carrierInterface, webrtc: webrtcInterface } : null;
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

    #dir(from, to) {
        return this.direction ? { direction: [this.direction[from], this.direction[to]] } : {};
    }

    // Inbound: the carrier's offer → the WebRTC offer for Callio's customer peer.
    async carrierOfferToWebrtc({ callId, sdp }) {
        const r = await this.send({ command: 'offer', 'call-id': callId, 'from-tag': 'carrier', sdp, ...TO_WEBRTC, ...this.#dir('carrier', 'webrtc') });
        return r.sdp;
    }

    // Inbound: Callio's WebRTC answer → the answer SDP for the carrier.
    async webrtcAnswerToCarrier({ callId, sdp }) {
        const r = await this.send({ command: 'answer', 'call-id': callId, 'from-tag': 'carrier', 'to-tag': 'callio', sdp, ...TO_CARRIER });
        return r.sdp;
    }

    // Outbound: Callio's WebRTC offer → the offer SDP for the carrier.
    async webrtcOfferToCarrier({ callId, sdp }) {
        const r = await this.send({ command: 'offer', 'call-id': callId, 'from-tag': 'callio', sdp, ...TO_CARRIER, ...this.#dir('webrtc', 'carrier') });
        return r.sdp;
    }

    // Outbound: the carrier's answer → the WebRTC answer for Callio's customer peer.
    async carrierAnswerToWebrtc({ callId, sdp }) {
        const r = await this.send({ command: 'answer', 'call-id': callId, 'from-tag': 'callio', 'to-tag': 'carrier', sdp, ...TO_WEBRTC });
        return r.sdp;
    }

    // Always on hang-up, or rtpengine keeps the ports allocated.
    async delete(callId) {
        return this.send({ command: 'delete', 'call-id': callId }).catch((err) => {
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
