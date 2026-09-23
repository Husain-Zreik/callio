// Minimal client for rtpengine's "ng" control protocol: bencoded dictionaries
// over UDP, request prefixed with an arbitrary cookie string that the reply
// echoes back so requests/replies can be matched.
//
// This is the least-verified file in this deployment — bencode itself is a
// simple, stable, well-specified format (same one BitTorrent uses) and this
// encoder/decoder should be solid, but the exact ng-protocol field names
// (command/call-id/from-tag/etc.) were written from documented rtpengine
// conventions without a live instance to confirm against. Cross-check
// against rtpengine's own ng protocol docs (in its GitHub repo, commonly
// docs/ng_protocol.md / docs/ng_dictionary.md) if `offer`/`delete` don't
// behave as expected.
'use strict';

const dgram = require('node:dgram');

function bencode(value) {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return `i${value}e`;
    }
    if (typeof value === 'string') {
        return `${Buffer.byteLength(value, 'utf8')}:${value}`;
    }
    if (Array.isArray(value)) {
        return `l${value.map(bencode).join('')}e`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `d${keys.map(k => bencode(k) + bencode(value[k])).join('')}e`;
    }
    throw new Error(`bencode: unsupported value type ${typeof value}`);
}

function bdecode(buf, pos) {
    const marker = String.fromCharCode(buf[pos.i]);

    if (marker === 'i') {
        pos.i += 1;
        const end = buf.indexOf(0x65, pos.i); // 'e'
        const num = parseInt(buf.slice(pos.i, end).toString('ascii'), 10);
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

    // byte string: <len>:<bytes>
    const colon = buf.indexOf(0x3a, pos.i); // ':'
    const len = parseInt(buf.slice(pos.i, colon).toString('ascii'), 10);
    const start = colon + 1;
    const str = buf.slice(start, start + len).toString('utf8');
    pos.i = start + len;
    return str;
}

class RtpEngineClient {
    constructor({ host = '127.0.0.1', port = 22222, timeoutMs = 2000 } = {}) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
        this._counter = 0;
        this._pending = new Map();

        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', (msg) => {
            const spaceIdx = msg.indexOf(0x20); // ' '
            if (spaceIdx < 0) return;
            const cookie = msg.slice(0, spaceIdx).toString('ascii');
            const pending = this._pending.get(cookie);
            if (!pending) return;
            this._pending.delete(cookie);
            clearTimeout(pending.timer);
            try {
                pending.resolve(bdecode(msg, { i: spaceIdx + 1 }));
            } catch (err) {
                pending.reject(err);
            }
        });
    }

    _send(command) {
        return new Promise((resolve, reject) => {
            const cookie = `callio_${Date.now()}_${this._counter++}`;
            const packet = Buffer.from(`${cookie} ${bencode(command)}`, 'utf8');

            const timer = setTimeout(() => {
                this._pending.delete(cookie);
                reject(new Error(`rtpengine: no response for '${command.command}' within ${this.timeoutMs}ms`));
            }, this.timeoutMs);

            this._pending.set(cookie, { resolve, reject, timer });
            this.socket.send(packet, this.port, this.host, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this._pending.delete(cookie);
                    reject(err);
                }
            });
        });
    }

    /** Registers a new call leg's SDP offer with rtpengine, gets back the rewritten SDP to send onward. */
    offer({ callId, fromTag, sdp }) {
        return this._send({
            command: 'offer',
            'call-id': callId,
            'from-tag': fromTag,
            sdp,
            replace: ['origin', 'session-connection'],
        });
    }

    /** Tears down rtpengine's media session for a call. Always attempt this on hangup to avoid leaking allocated ports. */
    delete({ callId, fromTag }) {
        return this._send({ command: 'delete', 'call-id': callId, 'from-tag': fromTag });
    }

    close() {
        this.socket.close();
    }
}

module.exports = { RtpEngineClient, bencode, bdecode };
