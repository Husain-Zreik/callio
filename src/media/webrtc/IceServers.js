// src/media/webrtc/IceServers.js
// The ICE servers for a peer connection: Callio's own peers and every agent
// client (sent in session:ready, so no client ships TURN credentials).
//
// TURN credentials, in order of preference:
//   TURN_SECRET    short-lived credentials per identity, the TURN REST API
//                  scheme coturn verifies with `use-auth-secret`:
//                    username   = "<unix expiry>:<identity>"
//                    credential = base64(HMAC-SHA1(secret, username))
//   TURN_USERNAME / TURN_CREDENTIAL   one static pair (e.g. a hosted TURN service)
// TURN_SERVER_URL is a host name (turn:<host>:80 udp/tcp and turns:<host>:443
// are derived) or a comma-separated list of full turn:/turns: URLs.
import { createHmac } from 'crypto';
import { config } from '../../../config/envConfig.js';

function turnUrls(serverUrl) {
    const parts = String(serverUrl).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.every((p) => /^turns?:/i.test(p))) return parts;
    const host = parts[0];
    return [`turn:${host}:80?transport=udp`, `turn:${host}:80?transport=tcp`, `turns:${host}:443?transport=tcp`];
}

/**
 * @param {string} identity   who the credentials are for (an agent id), or 'callio'
 * @returns {{ iceServers: RTCIceServer[], expiresAt: string|null }}
 */
export function iceServersFor(identity = 'callio') {
    const { stunUrls, turn } = config.webrtc;
    const iceServers = stunUrls.map((urls) => ({ urls }));
    if (!turn.serverUrl) return { iceServers, expiresAt: null };

    let username = turn.username;
    let credential = turn.credential;
    let expiresAt = null;
    if (turn.secret) {
        const expiry = Math.floor(Date.now() / 1000) + turn.ttlSeconds;
        username = `${expiry}:${identity}`;
        credential = createHmac('sha1', turn.secret).update(username).digest('base64');
        expiresAt = new Date(expiry * 1000).toISOString();
    }
    if (!username || !credential) return { iceServers, expiresAt: null };

    iceServers.push({ urls: turnUrls(turn.serverUrl), username, credential });
    return { iceServers, expiresAt };
}

export function isTurnConfigured() {
    const { turn } = config.webrtc;
    return Boolean(turn.serverUrl && (turn.secret || (turn.username && turn.credential)));
}
