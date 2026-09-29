// src/channels/whatsapp/whatsappSdp.js
// WhatsApp's SDP rules for the customer leg, handed to the media layer as the
// channel's sdpProfile (see core/channels/CustomerChannels.js):
//   remoteOffer   Meta's offer, sanitized before libwebrtc sees it
//   localOffer    our outbound offer, tuned for Meta (FEC, DTMF payload type)
//   remoteAnswer  Meta's answer to our outbound offer
import { logger } from '../../infra/logging/logger.js';

const log = logger('channels.whatsapp.whatsappSdp');

function audioTelLines(lines) {
    return lines.filter((l) => /telephone-event|^m=audio/i.test(l));
}

function processWhatsAppSDP(sdp, { optimize = false, sanitize = false } = {}) {
    const lines = sdp
        .replace(/\r?\n/g, '\r\n')
        .split('\r\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const fixed = lines.map((line) => {
        if (sanitize) {
            if (/^a=ice-lite\b/i.test(line)) return null;
            if (/^a=rtcp:\d+\s+IN\s+IP4\s+0\.0\.0\.0\b/i.test(line)) return null;

            // Normalize telephone-event to 8000 clock rate (Meta requires 8000 Hz only for DTMF).
            // We keep telephone-event in the SDP so WhatsApp sends RFC 2833 packets.
            // libwebrtc (underlying wrtc) decodes those RFC 2833 events back into PCM audio
            // tones before delivering to RTCAudioSink, making them detectable by Goertzel.
            const telEvt = /^a=rtpmap:(\d+)\s+telephone-event\/(\d+)/i.exec(line);
            if (telEvt && telEvt[2] !== '8000') {
                return `a=rtpmap:${telEvt[1]} telephone-event/8000`;
            }

            if (/^a=candidate:/i.test(line)) {
                return line.replace(/\snetwork-cost\s+\d+\b/ig, '');
            }
        }

        if (optimize && line.includes('a=fmtp:') && line.includes('opus')) {
            let optimized = line;
            if (!line.includes('useinbandfec=1')) optimized += ';useinbandfec=1';
            if (!line.includes('maxplaybackrate')) optimized += ';maxplaybackrate=16000';
            return optimized;
        }

        return line;
    }).filter(Boolean);

    // Outbound offers: ensure telephone-event/8000 is present for DTMF (RFC 4733, PT 126).
    if (optimize) {
        const alreadyPresent = fixed.some((l) => /^a=rtpmap:\d+\s+telephone-event\/8000/i.test(l));
        if (!alreadyPresent) {
            const audioLineIdx = fixed.findIndex((l) => /^m=audio\b/i.test(l));
            if (audioLineIdx !== -1) {
                const parts = fixed[audioLineIdx].split(/\s+/);
                if (!parts.includes('126')) {
                    fixed[audioLineIdx] = [...parts, '126'].join(' ');
                }
                fixed.push('a=rtpmap:126 telephone-event/8000');
                fixed.push('a=fmtp:126 0-16');
                log.debug('Injected telephone-event/8000 (PT 126) into outbound offer');
            }
        }
        log.debug(`Outbound offer audio/tel lines:\n ${audioTelLines(fixed).join('\n  ')}`);
    }

    return fixed.join('\r\n') + '\r\n';
}

export const whatsappSdpProfile = Object.freeze({
    remoteOffer(sdp) {
        log.debug(`Offer audio/tel lines:\n ${audioTelLines(sdp.split(/\r?\n/)).join('\n  ')}`);
        const sanitized = processWhatsAppSDP(sdp, { sanitize: true });
        log.debug(`After sanitizing:\n ${audioTelLines(sanitized.split(/\r?\n/)).join('\n  ')}`);
        return sanitized;
    },
    localOffer(sdp) {
        return processWhatsAppSDP(sdp, { optimize: true });
    },
    remoteAnswer(sdp) {
        return processWhatsAppSDP(sdp);
    },
});
