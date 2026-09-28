// src/media/webrtc/PeerConfig.js
import { iceServersFor, isTurnConfigured } from './IceServers.js';

let warned = false;

export class PeerConfig {
    static getICEServers() {
        if (!isTurnConfigured() && !warned) {
            warned = true;
            console.warn('[WebRTC] TURN is not configured. Calls may fail behind restrictive NATs/firewalls.');
        }
        return iceServersFor('callio').iceServers;
    }

    static getDefaultConfig() {
        return {
            iceServers: this.getICEServers(),
            iceCandidatePoolSize: 30,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            sdpSemantics: 'unified-plan',
            iceConnectionReceiveTimeout: 10000,
            iceBackupCandidatePairPingInterval: 5000
        };
    }
}
