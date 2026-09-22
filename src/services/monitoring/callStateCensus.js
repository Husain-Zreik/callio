// src/services/monitoring/callStateCensus.js
//
// DIAGNOSTIC — counts every piece of per-call state held across the call stack.
// Each entry here is keyed by callId (or callId-connectionType) and MUST be emptied
// when the call ends. After a call finishes (and whenever the worker is idle with
// Calls(0)), EVERY count below — and therefore `total` — must be 0. A non-zero value
// at idle means that registry retained state for an ended call == a leak, and the
// breakdown pinpoints exactly which service failed to clean up.
//
// Pure read-only: only reads `.size` of existing maps. Safe in production.
import { peerRegistry }         from '../call/signaling/webrtc/PeerRegistry.js';
import { recordingManager }     from '../call/audio/recording/RecordingManager.js';
import { audioCoordinator }     from '../call/audio/AudioCoordinator.js';
import { audioCaptureService }  from '../call/audio/recording/AudioCaptureService.js';
import { dtmfCaptureService }   from '../call/audio/dtmf/DTMFCaptureService.js';
import { placeholderTrackFactory } from '../call/audio/PlaceholderTrackFactory.js';
import { peerEventManager }     from '../call/signaling/webrtc/PeerEventManager.js';
import { iceCoordinator }       from '../call/signaling/webrtc/ice/ICECandidateCoordinator.js';
import { ivrCoordinator }       from '../call/ivr/IvrCoordinator.js';
import { queueAudioCoordinator } from '../call/ivr/QueueAudioCoordinator.js';
import { redisPubSubService }   from '../redis/RedisPubSubService.js';

const sz = (m) => { try { return m?.size ?? 0; } catch { return 0; } };

/**
 * Snapshot of all per-call registries. `total` must be 0 when no calls are active.
 */
export function callStateCensus() {
    const ice = iceCoordinator;
    const breakdown = {
        peerConnections:   sz(peerRegistry.peerConnections),
        audioBridges:      sz(audioCoordinator?.bridgeManager?.activeBridges),
        recordingSessions: sz(recordingManager.activeSessions),
        recordingSinks:    sz(audioCaptureService.activeSinks),
        dtmfActiveSinks:   sz(dtmfCaptureService.activeSinks),
        dtmfIdleSinks:     sz(dtmfCaptureService._idleSinks),
        placeholderTracks: sz(placeholderTrackFactory._tracks),
        connectionStates:  sz(peerEventManager.connectionStates),
        icePostBuffer:     sz(ice?.inboundManager?.postConnectionBuffer),
        icePreBuffer:      sz(ice?.preConnectionBuffer?.buffer),
        iceOutBuffer:      sz(ice?.outboundBuffer?.candidateBuffer),
        iceOutReady:       sz(ice?.outboundBuffer?.readyFlags),
        iceOutInfo:        sz(ice?.outboundManager?.connectionInfo),
        ivrSessions:       sz(ivrCoordinator._sessions),
        queueAudio:        sz(queueAudioCoordinator._active),
        redisCallSubs:     sz(redisPubSubService.subscriptions),
    };

    let total = 0;
    for (const v of Object.values(breakdown)) total += v;

    return { total, breakdown };
}
