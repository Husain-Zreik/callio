// src/media/rooms/RtpLegs.js
// One rtpengine call per leg: the external side (a customer over WhatsApp or
// SIP, an agent's or supervisor's WebRTC) on rtpengine's external interface,
// plain RTP to the leg's FreeSWITCH endpoint on the internal one. The tags
// are 'ext' and 'fs'.
//
//   remote offers   ext offer  → offer(ext→fs)  → FreeSWITCH answers → answer(fs→ext) → ext
//   we offer        FreeSWITCH offers → offer(fs→ext) → ext answers → answer(ext→fs) → FreeSWITCH
import { RtpEngineClient } from '../../infra/media/RtpEngineClient.js';
import { config } from '../../../config/envConfig.js';

// What the external side looks like on the wire. The DTLS role is left to
// rtpengine: forcing 'passive' makes it answer a=setup:passive, which
// libwebrtc (as the offerer) refuses to apply.
const EXTERNAL = Object.freeze({
    webrtc: {
        'transport-protocol': 'UDP/TLS/RTP/SAVPF',
        ICE: 'force',
        'rtcp-mux': ['require'],
        SDES: ['off'],
        flags: ['generate mid'],
    },
    rtp: {
        'transport-protocol': 'RTP/AVP',
        ICE: 'remove',
        'rtcp-mux': ['demux'],
        DTLS: 'off',
        SDES: ['off'],
    },
});
// FreeSWITCH's side: plain RTP.
const INTERNAL = EXTERNAL.rtp;

class RtpLegs {
    constructor() {
        this.client = null;
    }

    _rtp() {
        if (!this.client) this.client = new RtpEngineClient(config.sip.rtpengine);
        return this.client;
    }

    _direction(from, to) {
        const { externalInterface, internalInterface } = config.sip.rtpengine;
        const name = { external: externalInterface, internal: internalInterface };
        return { direction: [name[from], name[to]] };
    }

    // The external side offered: the offer for FreeSWITCH.
    remoteOffer(key, sdp) {
        return this._rtp().offer({ callId: key, fromTag: 'ext', sdp, flags: { ...INTERNAL, ...this._direction('external', 'internal') } });
    }

    // FreeSWITCH's answer to it: the answer for the external side.
    endpointAnswer(key, sdp, transport) {
        return this._rtp().answer({ callId: key, fromTag: 'ext', toTag: 'fs', sdp, flags: EXTERNAL[transport] });
    }

    // FreeSWITCH offered: the offer for the external side.
    endpointOffer(key, sdp, transport) {
        return this._rtp().offer({ callId: key, fromTag: 'fs', sdp, flags: { ...EXTERNAL[transport], ...this._direction('internal', 'external') } });
    }

    // The external side's answer to it: the answer for FreeSWITCH.
    remoteAnswer(key, sdp) {
        return this._rtp().answer({ callId: key, fromTag: 'fs', toTag: 'ext', sdp, flags: INTERNAL });
    }

    // What the external party has sent: { packets, lastPacketAt (ms), quality }.
    // quality is the latest RTCP-derived report rtpengine holds for the leg
    // ({ mos, jitter, packetLoss }) or null.
    async received(key) {
        const q = await this._rtp().query(key);
        const stream = q?.tags?.ext?.medias?.[0]?.streams?.[0] ?? null;
        let quality = null;
        for (const entry of Object.values(q?.SSRC ?? {})) {
            const last = entry?.['MOS progression']?.entries?.at?.(-1) ?? entry?.['average MOS'];
            if (last && typeof last.MOS === 'number') {
                quality = { mos: last.MOS / 10, jitter: last.jitter ?? null, packetLoss: last['packet loss'] ?? null };
            }
        }
        return {
            packets: stream?.stats?.packets ?? 0,
            lastPacketAt: stream?.['last packet'] ? stream['last packet'] * 1000 : null,
            quality,
        };
    }

    delete(key) {
        return this._rtp().delete(key);
    }

    list() {
        return this._rtp().list();
    }

    ping() {
        return this._rtp().ping();
    }

    close() {
        this.client?.close();
        this.client = null;
    }
}

export const rtpLegs = new RtpLegs();
