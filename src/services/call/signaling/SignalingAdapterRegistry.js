// services/call/signaling/SignalingAdapterRegistry.js
//
// Resolves which SignalingAdapter owns a given connection. Today every
// connection type (FRONTEND, WHATSAPP, MONITOR) is WebRTC, so this always
// returns the WebRTC adapter — this class exists as the seam a future
// transport dispatch (e.g. a `transport: 'SIP'` connection) would branch on,
// once ConnectionType gains a non-WebRTC value. Not imported by any existing
// call site yet (see ARCHITECTURE.md "Signaling Adapter Layer").
import { webRTCSignalingAdapter } from './webrtc/WebRTCSignalingAdapter.js';

class SignalingAdapterRegistry {
    /**
     * @param {string} connectionType - a CallConstants.ConnectionType value.
     * @returns {import('./SignalingAdapter.js').SignalingAdapter}
     */
    resolve(connectionType) {
        return webRTCSignalingAdapter;
    }
}

export const signalingAdapterRegistry = new SignalingAdapterRegistry();
