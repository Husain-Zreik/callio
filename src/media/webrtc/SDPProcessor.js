// src/media/webrtc/SDPProcessor.js
// SDP handling per leg. Agent and monitor legs are plain browser WebRTC. The
// customer leg's SDP may need provider-specific rewrites; those come from the
// channel adapter as an `sdpProfile` ({ localOffer, remoteOffer, remoteAnswer },
// see core/channels/CustomerChannels.js) — media knows no provider.
import { ConnectionType } from "../../core/constants/CallConstants.js";
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.webrtc.SDPProcessor');

function applyProfile(profile, hook, sdp, connectionType) {
    if (connectionType !== ConnectionType.CUSTOMER) return sdp;
    const fn = profile?.[hook];
    return typeof fn === 'function' ? fn(sdp) : sdp;
}

export class SDPProcessor {
    async createOffer(peerConnection, connectionType, sdpProfile = null) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        return applyProfile(sdpProfile, 'localOffer', peerConnection.localDescription.sdp, connectionType);
    }

    async createAnswer(peerConnection, sdpOffer, connectionType, sdpProfile = null) {
        const offer = applyProfile(sdpProfile, 'remoteOffer', sdpOffer, connectionType);
        await peerConnection.setRemoteDescription({ type: 'offer', sdp: offer });

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        return answer.sdp;
    }

    async processAnswer(peerConnection, sdpAnswer, connectionType, sdpProfile = null) {
        try {
            const processedSdp = applyProfile(sdpProfile, 'remoteAnswer', sdpAnswer, connectionType);
            await peerConnection.setRemoteDescription({ type: 'answer', sdp: processedSdp });
            return processedSdp;
        } catch (err) {
            log.error({ err }, `Failed to process ${connectionType} SDP answer`);
            throw err;
        }
    }
}

export const sdpProcessor = new SDPProcessor();
