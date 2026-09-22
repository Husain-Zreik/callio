// services/call/ivr/QueueAudioCoordinator.js
//
// Plays the queue waiting audio (looped) on the caller's audio sender after
// the IVR transfers the call to the agent queue.
//
// Lifecycle:
//   startQueueAudio(callId, businessId, sender, whatsappPc)
//     → immediately replaces the silent IVR track with a placeholder reconnecting tone
//       (covers the async decode gap AND the "no audio configured" fallback)
//     → resolves the configured audio file (business override → platform default → null)
//     → if audio found: decode PCM, replace interim tone with real track, loop via IvrAudioPlayer
//     → if no audio: keeps the placeholder tone running until stopQueueAudio is called
//   stopQueueAudio(callId)
//     → called by AudioCoordinator when the agent bridge starts (call:queue_audio_stop)
//     → also called on call:terminated
//
// Pattern mirrors IvrCoordinator / RecordingCoordinator.
import wrtc from '@roamhq/wrtc';
import EventBus from '../../core/EventBus.js';
import IvrRepository from '../../../repositories/IvrRepository.js';
import { IvrAudioPlayer } from './IvrAudioPlayer.js';
import { placeholderTrackFactory } from '../audio/PlaceholderTrackFactory.js';
import { resolveStoragePath } from '../../storage/StorageResolver.js';
import { leakMetrics } from '../../monitoring/leakMetrics.js';

class QueueAudioCoordinator {
    constructor() {
        // callId → { player, audioSource, track, sender, stopRequested,
        //             terminationHandler, stopHandler }
        this._active = new Map();
    }

    /**
     * Start playing queue waiting audio for a call that was just transferred
     * from IVR to the agent queue.
     *
     * @param {string}               callId
     * @param {number}               businessId
     * @param {RTCRtpSender}         sender              the placeholder sender on whatsappPc
     * @param {RTCPeerConnection}    whatsappPc
     * @param {string|null}          [audioOverridePath]  resolved path/URL to use instead of business/platform audio
     */
    async startQueueAudio(callId, businessId, sender, whatsappPc, audioOverridePath = null) {
        if (this._active.has(callId)) return; // already running

        console.log(`[QueueAudioCoordinator] Starting queue audio for call ${callId}`);

        // Guard against call:terminated firing during the async setup window (DB fetch,
        // storage resolve, ffmpeg decode, replaceTrack). Without this, the session can
        // be added to _active after the termination event already fired — leaving it
        // stuck with no cleanup handler and holding the PCM ArrayBuffer indefinitely.
        let terminated = false;
        const earlyGuard = ({ callId: cid }) => { if (cid === callId) terminated = true; };
        EventBus.on('call:terminated', earlyGuard);

        // Held in outer scope so error-exit paths can release tracks before returning.
        let interimTrack = null;   // placeholder tone — placed immediately to fill the silence
        let queueTrack = null;     // real queue audio track — replaces interimTrack once decoded

        try {
            // ── STEP 1: Immediately replace the silent IVR track with a placeholder tone ──
            //
            // After stopSession('transferred') the IVR engine stops but its RTCAudioSource
            // is still on the sender — producing silence.  The original placeholder tone was
            // displaced when the IVR session started (shiftPlaceholderSender + replaceTrack),
            // so it is NOT restored automatically.  We must put a live tone on the sender
            // RIGHT NOW, before the async DB/decode work below, to avoid any silence gap.
            // This also serves as the fallback when no audio file is configured at all.
            interimTrack = await placeholderTrackFactory.createTrack('reconnecting');
            if (!interimTrack) {
                console.warn(`[QueueAudioCoordinator] Could not create interim tone for call ${callId}`);
                return;
            }

            try {
                await sender.replaceTrack(interimTrack);
            } catch (err) {
                console.warn(`[QueueAudioCoordinator] Interim replaceTrack failed for call ${callId}:`, err.message);
                placeholderTrackFactory.releaseGeneratedTrack(interimTrack);
                interimTrack = null;
                return;
            }

            if (terminated) {
                console.log(`[QueueAudioCoordinator] Call ${callId} terminated during queue audio setup — aborting`);
                placeholderTrackFactory.releaseGeneratedTrack(interimTrack);
                interimTrack = null;
                return;
            }

            // ── STEP 2: Async-resolve the configured audio file ──
            // Caller now hears the interim tone while this work completes.
            let filePath = audioOverridePath ?? null;
            let pcm = null;

            if (!filePath) {
                let audioInfo = null;
                try {
                    audioInfo = await IvrRepository.getQueueAudio(businessId);
                } catch (err) {
                    console.warn(`[QueueAudioCoordinator] getQueueAudio failed for call ${callId}:`, err.message);
                }

                if (!audioInfo) {
                    // No configured audio — interim placeholder tone is already playing.
                    // Fall through to register the session so cleanup handlers fire correctly.
                    console.log(`[QueueAudioCoordinator] No queue audio configured for business ${businessId} — using built-in tone`);
                } else {
                    try {
                        filePath = await resolveStoragePath(audioInfo);
                    } catch (err) {
                        console.warn(`[QueueAudioCoordinator] Failed to resolve queue audio path for call ${callId}:`, err.message, '— keeping built-in tone');
                        // filePath stays null — fall through with interim tone
                    }
                }
            }

            // ── STEP 3: Decode and switch to real queue audio (if a file was found) ──
            if (filePath) {
                console.log(`[QueueAudioCoordinator] Queue audio path for call ${callId}: ${filePath}`);

                try {
                    pcm = await IvrAudioPlayer.decode(filePath);
                    console.log(`[QueueAudioCoordinator] Pre-decoded queue audio for call ${callId}: ${pcm.length} samples`);
                } catch (err) {
                    console.warn(`[QueueAudioCoordinator] Failed to decode queue audio for call ${callId}:`, err.message, '— keeping built-in tone');
                    pcm = null;
                }

                if (pcm) {
                    const { nonstandard } = wrtc;
                    if (!nonstandard?.RTCAudioSource) {
                        console.warn('[QueueAudioCoordinator] RTCAudioSource unavailable — keeping built-in tone');
                        pcm = null; // fall through with interim tone
                    } else {
                        const audioSource = new nonstandard.RTCAudioSource();
                        leakMetrics.audioSourceCreated++;   // DIAGNOSTIC (native): queue-audio source
                        queueTrack = audioSource.createTrack();
                        queueTrack._isGeneratedSource = true;
                        queueTrack._audioSource = audioSource;

                        let replaced = false;
                        try {
                            await sender.replaceTrack(queueTrack);
                            replaced = true;
                        } catch (err) {
                            console.warn(`[QueueAudioCoordinator] Queue audio replaceTrack failed for call ${callId}:`, err.message, '— keeping built-in tone');
                            placeholderTrackFactory.releaseGeneratedTrack(queueTrack);
                            queueTrack = null;
                            pcm = null;
                        }

                        if (replaced) {
                            // Interim tone has been superseded — stop its interval now.
                            placeholderTrackFactory.releaseGeneratedTrack(interimTrack);
                            interimTrack = null;
                        }
                    }
                }
            }

            // Final terminated check — call may have ended during the decode window.
            if (terminated) {
                console.log(`[QueueAudioCoordinator] Call ${callId} terminated during queue audio setup — aborting`);
                // interimTrack and queueTrack are both released by the finally block.
                return;
            }

            // ── STEP 4: Register session ──
            // activeTrack is whichever track is now on the sender:
            //   • queueTrack (real audio) — if decode + replaceTrack succeeded
            //   • interimTrack (reconnecting tone) — fallback for all other paths
            const activeTrack = queueTrack ?? interimTrack;
            const activeAudioSource = queueTrack ? queueTrack._audioSource : null;

            const session = {
                audioSource: activeAudioSource,
                track: activeTrack,
                sender,
                whatsappPc,
                stopRequested: false,
                player: null,
                terminationHandler: null,
                stopHandler: null,
            };

            this._active.set(callId, session);

            const stopHandler = ({ callId: cid }) => {
                if (cid !== callId) return;
                this._cleanup(callId, 'stopped by bridge');
            };
            const terminationHandler = ({ callId: cid }) => {
                if (cid !== callId) return;
                this._cleanup(callId, 'call terminated');
            };

            session.stopHandler = stopHandler;
            session.terminationHandler = terminationHandler;

            EventBus.on('call:queue_audio_stop', stopHandler);
            EventBus.on('call:terminated', terminationHandler);

            // Ownership transferred to session — clear local refs so the finally block
            // does not double-release on a normal exit.
            queueTrack = null;
            interimTrack = null;

            // ── STEP 5: Start audio loop for real queue audio ──
            // Placeholder tones are self-driven by their setInterval; no loop needed.
            if (pcm && activeAudioSource) {
                this._loop(callId, activeAudioSource, pcm);
            }

        } finally {
            EventBus.off('call:terminated', earlyGuard);
            // Release any track that didn't make it into the session (error / terminated paths).
            if (queueTrack) placeholderTrackFactory.releaseGeneratedTrack(queueTrack);
            if (interimTrack) placeholderTrackFactory.releaseGeneratedTrack(interimTrack);
        }
    }

    /**
     * Stop queue audio explicitly (called from AudioCoordinator before bridge starts).
     * @param {string} callId
     */
    stopQueueAudio(callId) {
        this._cleanup(callId, 'explicit stop');
    }

    isActive(callId) {
        return this._active.has(callId);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    /**
     * Loop audio by restarting the player each time playback ends.
     * Stops when session.stopRequested is set by _cleanup().
     * @param {Int16Array} pcm  Pre-decoded 48 kHz mono PCM — replayed without ffmpeg.
     */
    async _loop(callId, audioSource, pcm) {
        while (true) {
            const session = this._active.get(callId);
            if (!session || session.stopRequested) break;

            const player = new IvrAudioPlayer(audioSource);
            session.player = player;

            try {
                await player.play(pcm);
            } catch (err) {
                console.warn(`[QueueAudioCoordinator] Playback error for call ${callId}:`, err.message);
                break; // on error, stop looping
            }
        }
    }

    _cleanup(callId, reason) {
        const session = this._active.get(callId);
        if (!session) return;

        console.log(`[QueueAudioCoordinator] Stopping queue audio for call ${callId} (${reason})`);

        session.stopRequested = true;

        // Stop the current player iteration
        if (session.player) {
            try { session.player.stop(); } catch { }
            session.player = null;
        }

        // Release the queue-audio RTCAudioSource native buffer. By now the bridge
        // has already replaced this sender's track with the live agent track, so the
        // queueTrack is detached and safe to stop.
        placeholderTrackFactory.releaseGeneratedTrack(session.track);

        // Remove EventBus listeners
        if (session.stopHandler) EventBus.off('call:queue_audio_stop', session.stopHandler);
        if (session.terminationHandler) EventBus.off('call:terminated', session.terminationHandler);

        this._active.delete(callId);
    }

}

export const queueAudioCoordinator = new QueueAudioCoordinator();
