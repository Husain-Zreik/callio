// services/call/signaling/webrtc/PeerConfig.js
import { config } from '../../../../../config/envConfig.js';

export class PeerConfig {
    static getICEServers() {
        const servers = [
            // Public STUN servers - safe to hardcode
            { urls: "stun:stun.relay.metered.ca:80" },
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
        ];

        // Add TURN servers if credentials are provided
        const turnUrl = config.webrtc.turn.serverUrl;
        const turnUsername = config.webrtc.turn.username;
        const turnCredential = config.webrtc.turn.credential;

        if (turnUrl && turnUsername && turnCredential) {
            servers.push(
                {
                    urls: `turn:${turnUrl}:80?transport=tcp`,
                    username: turnUsername,
                    credential: turnCredential,
                },
                {
                    urls: `turns:${turnUrl}:443?transport=tcp`,
                    username: turnUsername,
                    credential: turnCredential,
                },
                {
                    urls: `turn:${turnUrl}:80?transport=udp`,
                    username: turnUsername,
                    credential: turnCredential,
                },
                {
                    urls: `turns:${turnUrl}:443?transport=udp`,
                    username: turnUsername,
                    credential: turnCredential,
                }
            );
        } else {
            console.warn('[WebRTC] TURN server credentials not configured. Calls may fail behind restrictive NATs/firewalls.');
        }

        return servers;
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
