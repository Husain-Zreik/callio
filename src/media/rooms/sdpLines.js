// src/media/rooms/sdpLines.js
// A media server endpoint carries one audio stream. A client may offer more
// m-lines (a supervisor's offer has a second, receive-only audio line from
// when they heard the customer and the agent as separate tracks; they now
// hear the room mixed on the first). The extra lines are taken out of the
// offer and answered as rejected (port 0, inactive, outside BUNDLE), so the
// answer's m-lines still match the offer's.
import transform from 'sdp-transform';

export function primaryAudioOnly(sdp) {
    const parsed = transform.parse(sdp);
    const media = parsed.media ?? [];
    const keep = media.find((m) => m.type === 'audio');
    if (!keep || media.length <= 1) return { sdp, extra: [] };
    if (media.indexOf(keep) !== 0) throw new Error('The first m-line of the offer must be audio');
    const extra = media.slice(1).map((m) => ({
        type: m.type,
        protocol: m.protocol,
        payloads: String(m.payloads ?? '').split(' ')[0],
        rtp: (m.rtp ?? []).slice(0, 1),
        mid: m.mid,
    }));
    parsed.media = [keep];
    if (parsed.groups) {
        parsed.groups = parsed.groups.map((g) => (g.type === 'BUNDLE' ? { ...g, mids: String(keep.mid) } : g));
    }
    return { sdp: transform.write(parsed), extra };
}

export function withRejectedLines(answer, extra) {
    if (!extra?.length) return answer;
    const parsed = transform.parse(answer);
    for (const e of extra) {
        parsed.media.push({
            type: e.type,
            port: 0,
            protocol: e.protocol,
            payloads: e.payloads,
            rtp: e.rtp,
            fmtp: [],
            ...(e.mid != null ? { mid: e.mid } : {}),
            direction: 'inactive',
        });
    }
    return transform.write(parsed);
}
