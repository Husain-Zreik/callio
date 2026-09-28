// src/channels/sip/sipSdp.js
// The SIP channel's SDP rules for the customer leg (the channel's sdpProfile,
// see core/channels/CustomerChannels.js). The WebRTC SDP comes from rtpengine,
// which already speaks WebRTC; two rules:
//
// BUNDLE: Callio's peers use bundlePolicy max-bundle, which requires an
// a=group:BUNDLE line; rtpengine writes a=mid but no group, so add it.
//
// DTMF: Callio detects keypad presses in the customer's audio. Carriers send
// DTMF either in-band (as audio) or as RFC 4733 telephone-events, which a
// WebRTC peer consumes as events, not audio — so they'd never reach the
// detector. Leaving telephone-event out of the codecs we accept makes the
// carrier fall back to in-band DTMF, which G.711 carries reliably.

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

function ensureBundle(sdp) {
    const ls = lines(sdp);
    if (ls.some((l) => /^a=group:BUNDLE/i.test(l))) return sdp;
    const mids = ls.map((l) => /^a=mid:(\S+)/i.exec(l)?.[1]).filter(Boolean);
    const at = ls.findIndex((l) => l.startsWith('t='));
    if (!mids.length || at < 0) return sdp;
    ls.splice(at + 1, 0, `a=group:BUNDLE ${mids.join(' ')}`);
    return join(ls);
}

export const sipSdpProfile = Object.freeze({
    remoteOffer: (sdp) => ensureBundle(stripTelephoneEvent(sdp)),   // inbound: the carrier's offer, via rtpengine
    localOffer: stripTelephoneEvent,                                 // outbound: our offer, before rtpengine
    remoteAnswer: ensureBundle,                                      // outbound: the carrier's answer, via rtpengine
});
