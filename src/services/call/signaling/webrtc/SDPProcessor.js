// services/call/signaling/webrtc/SDPProcessor.js

export class SDPProcessor {
    async createOffer(peerConnection, connectionType) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        let sdp = peerConnection.localDescription.sdp;
        if (connectionType === 'WHATSAPP') {
            sdp = this.processWhatsAppSDP(sdp, { optimize: true });
        }

        return sdp;
    }

    async createAnswer(peerConnection, sdpOffer, connectionType) {
        if (connectionType === 'WHATSAPP') {
            const telLines = sdpOffer.split(/\r?\n/).filter(l =>
                /telephone-event|^m=audio/i.test(l)
            );
            console.log(`[SDP:sanitize] WhatsApp offer audio/tel lines:\n  ${telLines.join('\n  ')}`);
        }

        const sanitizedOffer = connectionType === 'WHATSAPP'
            ? this.processWhatsAppSDP(sdpOffer, { sanitize: true })
            : sdpOffer;

        if (connectionType === 'WHATSAPP') {
            const telLines = sanitizedOffer.split(/\r?\n/).filter(l =>
                /telephone-event|^m=audio/i.test(l)
            );
            console.log(`[SDP:sanitize] After processing:\n  ${telLines.join('\n  ')}`);
        }

        await peerConnection.setRemoteDescription({ type: 'offer', sdp: sanitizedOffer });

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        return answer.sdp;
    }

    async processAnswer(peerConnection, sdpAnswer, connectionType) {
        try {
            const processedSdp = connectionType === 'WHATSAPP'
                ? this.processWhatsAppSDP(sdpAnswer)
                : sdpAnswer;

            await peerConnection.setRemoteDescription({ type: 'answer', sdp: processedSdp });

            return processedSdp;
        } catch (err) {
            console.error(`Failed to process ${connectionType} SDP answer: ${err.message}`);
            throw err;
        }
    }

    // WhatsApp SDP processing utility
    processWhatsAppSDP(sdp, { optimize = false, sanitize = false } = {}) {
        let lines = sdp
            .replace(/\r?\n/g, '\r\n')
            .split('\r\n')
            .map(l => l.trim())
            .filter(Boolean);

        const removedPTs = new Set();

        const cleaned = lines.map(line => {
            // SANITIZE
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

            // OPTIMIZE
            if (optimize && line.includes('a=fmtp:') && line.includes('opus')) {
                let optimized = line;
                if (!line.includes('useinbandfec=1')) optimized += ';useinbandfec=1';
                if (!line.includes('maxplaybackrate')) optimized += ';maxplaybackrate=16000';
                return optimized;
            }

            return line;
        }).filter(Boolean);

        // FINAL FIXUPS
        let fixed = cleaned;

        if (sanitize && removedPTs.size) {
            fixed = fixed.map(line => {
                if (/^m=audio\b/i.test(line)) {
                    const parts = line.split(/\s+/);
                    const header = parts.slice(0, 3);
                    const payloads = parts.slice(3).filter(pt => !removedPTs.has(pt));
                    return [...header, ...payloads].join(' ');
                }
                return line;
            });

            if (!fixed.some(l => /^a=rtcp-mux\b/i.test(l))) {
                fixed.push('a=rtcp-mux');
            }
        }

        // For outbound WhatsApp offers: ensure telephone-event/8000 is present for DTMF (RFC 4733, PT 126)
        if (optimize) {
            const alreadyPresent = fixed.some(l => /^a=rtpmap:\d+\s+telephone-event\/8000/i.test(l));
            if (!alreadyPresent) {
                const audioLineIdx = fixed.findIndex(l => /^m=audio\b/i.test(l));
                if (audioLineIdx !== -1) {
                    const parts = fixed[audioLineIdx].split(/\s+/);
                    if (!parts.includes('126')) {
                        fixed[audioLineIdx] = [...parts, '126'].join(' ');
                    }
                    fixed.push('a=rtpmap:126 telephone-event/8000');
                    fixed.push('a=fmtp:126 0-16');
                    console.log('[SDP:optimize] Injected telephone-event/8000 (PT 126) into outbound offer');
                }
            } else {
                console.log('[SDP:optimize] telephone-event/8000 already present in outbound offer — no injection needed');
            }

            const telLines = fixed.filter(l => /telephone-event|^m=audio/i.test(l));
            console.log(`[SDP:optimize] Final audio/tel lines:\n  ${telLines.join('\n  ')}`);
        }

        return fixed.join('\r\n') + '\r\n';
    }
}

export const sdpProcessor = new SDPProcessor();
