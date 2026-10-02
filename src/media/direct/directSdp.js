// src/media/direct/directSdp.js
// SDP adjustments for a direct call, where rtpengine relays the customer's
// codecs straight to the agent's browser.

const lines = (sdp) => sdp.split(/\r?\n/).filter((l) => l.length);
const join = (ls) => ls.join('\r\n') + '\r\n';

// One payload type per codec: keeps the first of several identical rtpmaps
// (same encoding and clock rate) and drops the rest from the m= line and their
// attributes. WhatsApp's offer, once normalized (whatsappSdp: every
// telephone-event rewritten to /8000), lists four identical telephone-events;
// relayed as they are, the browser's answer and the provider's stream stop
// matching and no audio flows either way.
export function dedupeCodecs(sdp) {
    const ls = lines(sdp);
    const seen = new Map();   // "name/rate" → first pt
    const drop = new Set();
    for (const l of ls) {
        const m = /^a=rtpmap:(\d+)\s+([^/\s]+\/\d+)/i.exec(l);
        if (!m) continue;
        const codec = m[2].toLowerCase();
        if (seen.has(codec)) drop.add(m[1]);
        else seen.set(codec, m[1]);
    }
    if (!drop.size) return sdp;
    return join(ls
        .filter((l) => {
            const pt = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/i.exec(l)?.[1];
            return !(pt && drop.has(pt));
        })
        .map((l) => {
            if (!/^m=audio /i.test(l)) return l;
            const parts = l.split(' ');
            return [...parts.slice(0, 3), ...parts.slice(3).filter((pt) => !drop.has(pt))].join(' ');
        }));
}
