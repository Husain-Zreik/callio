// src/channels/sip/sipSdp.js
// The SIP channel's SDP rules for the customer leg (the channel's sdpProfile,
// see core/channels/CustomerChannels.js). The carrier speaks plain RTP
// (transport 'rtp'); the media plane anchors it on rtpengine.
//
// DTMF: carriers send DTMF either in-band (as audio) or as RFC 4733
// telephone-events. Leaving telephone-event out of the codecs we accept makes
// the carrier fall back to in-band DTMF, which G.711 carries reliably and the
// media server detects. (It detects RFC 4733 too; accepting it is open in
// docs/sip.md.)

const lines = (sdp) => sdp.split(/\r?\n/).filter((l) => l.length);
const join = (ls) => ls.join('\r\n') + '\r\n';

function stripTelephoneEvent(sdp) {
    const ls = lines(sdp);
    const eventPts = new Set(ls
        .map((l) => /^a=rtpmap:(\d+)\s+telephone-event\//i.exec(l)?.[1])
        .filter(Boolean));
    if (!eventPts.size) return sdp;
    return join(ls
        .filter((l) => {
            const pt = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/i.exec(l)?.[1];
            return !(pt && eventPts.has(pt));
        })
        .map((l) => {
            if (!/^m=audio /i.test(l)) return l;
            const parts = l.split(' ');
            return [...parts.slice(0, 3), ...parts.slice(3).filter((pt) => !eventPts.has(pt))].join(' ');
        }));
}

export const sipSdpProfile = Object.freeze({
    transport: 'rtp',
    remoteOffer: stripTelephoneEvent,   // inbound: the carrier's offer
    localOffer: stripTelephoneEvent,    // outbound: our offer to the carrier
});
