// services/call/ivr/IvrCoordinator.js
//
// Lifecycle coordinator for IVR sessions.  Mirrors DTMFCoordinator /
// RecordingCoordinator in pattern: one singleton, owns state map, clean API.
//
// Called from PeerRegistry.checkAndStartBridging when ivr_menu_id is set.
// On 'call:ivr_complete' with action='transfer', delegates to IvrTransferHandler.
import wrtc from '@roamhq/wrtc';
import EventBus from '../../core/EventBus.js';
import IvrRepository from '../../../repositories/IvrRepository.js';
import { callLifecycleLogger } from '../lifecycle/CallLifecycleLogger.js';
import { IvrEngine } from './IvrEngine.js';
import { IvrAudioPlayer } from './IvrAudioPlayer.js';
import { ivrTransferHandler } from './IvrTransferHandler.js';
import { dtmfCaptureService } from '../audio/dtmf/DTMFCaptureService.js';
import { resolveStoragePath } from '../../storage/StorageResolver.js';
import { storageClient } from '../../storage/StorageClient.js';
import { leakMetrics } from '../../monitoring/leakMetrics.js';
import { placeholderTrackFactory } from '../audio/PlaceholderTrackFactory.js';

class IvrCoordinator {
    constructor() {
        // callId → { engine, audioSource, sender, senderTrack, whatsappPeer, whatsappPc,
        //             sessionId, ivrMenuId, businessId, startedAtMs, completeHandler, terminationHandler }
        this._sessions = new Map();

        // One-way latch: callIds whose IVR session has completed at least once
        // (any outcome). This is the single source of truth for "IVR is over for
        // this call" — set synchronously in stopSession(), before any awaits, so
        // it can never disagree with reality the way calls.state can (that DB
        // write can fail, lag, or race with a concurrent read; this cannot).
        // PeerRegistry.checkAndStartBridging consults this — not just isActive()
        // and calls.state — before ever re-entering the IVR branch, which makes
        // "re-launch IVR on a call that already finished it" structurally
        // impossible rather than merely unlikely. Cleared on call:terminated so
        // this doesn't grow unbounded across the process lifetime.
        this._completedCallIds = new Set();
        EventBus.on('call:terminated', ({ callId }) => this._completedCallIds.delete(callId));
    }

    // ── Public API ────────────────────────────────────────────────────────────

    isActive(callId) {
        return this._sessions.has(callId);
    }

    /**
     * True once an IVR session for this call has completed (any outcome) at
     * least once. Distinct from isActive(): that only reflects whether a
     * session is currently running. This is a permanent (until call:terminated)
     * latch — see the constructor comment for why it exists.
     */
    hasCompleted(callId) {
        return this._completedCallIds.has(callId);
    }

    /**
     * Start an IVR session for an incoming call.
     *
     * @param {string}            callId
     * @param {number}            ivrMenuId
     * @param {RTCPeerConnection} whatsappPc     the WhatsApp peer connection
     * @param {MediaStreamTrack}  customerTrack  the caller's audio track (for DTMF)
     * @param {object}            callMeta       { businessId, businessNumberId, ... }
     * @param {Peer|null}         whatsappPeer
     */
    async startSession(callId, ivrMenuId, whatsappPc, customerTrack, callMeta = {}, whatsappPeer = null) {
        if (this._sessions.has(callId)) {
            console.warn(`[IvrCoordinator] Session already active for call ${callId}`);
            return;
        }
        if (this._completedCallIds.has(callId)) {
            console.warn(`[IvrCoordinator] IVR already completed for call ${callId} — refusing to restart`);
            return;
        }

        // Reserve the slot synchronously, before any await. checkAndStartBridging can
        // invoke startSession twice in quick succession for the same call (e.g. a
        // WHATSAPP connectionReady event and a trackReceived event landing close
        // together) — the has()-check above and the real _sessions.set() further down
        // used to be separated by a long async gap (menu fetch, audio decode, DB
        // insert), during which a second call would ALSO pass the check and both would
        // build a full IVR engine/RTCAudioSource/DTMF capture for one call, with the
        // second _sessions.set() silently clobbering the first and leaking its
        // resources forever. Reserving here — with zero awaits between the check above
        // and this line — closes that window: a concurrent second call now sees
        // isActive()===true immediately. stopSession() treats a `_pending` entry the
        // same as no session (see its guard) since setup hasn't allocated anything yet.
        this._sessions.set(callId, { _pending: true });
        let sessionEstablished = false;

        console.log(`[IvrCoordinator] Starting session for call ${callId}, menu ${ivrMenuId}`);

        // Guard against call:terminated firing during the async setup window (menu fetch,
        // audio path resolution / S3 downloads / ffmpeg decode, DB session creation).
        // Without this, _sessions.set() can run after the termination event already fired,
        // leaving the session stuck with no cleanup handler.
        let terminated = false;
        const earlyGuard = ({ callId: cid }) => { if (cid === callId) terminated = true; };
        EventBus.on('call:terminated', earlyGuard);

        // Held in outer scope so the catch block can release the native source if setup
        // throws before _sessions.set() transfers ownership to the session.
        let ivrTrack = null;
        let dtmfStarted = false;

        try {
            // 1. Fetch menu structure + audio file metadata
            const menu = await IvrRepository.findMenu(ivrMenuId, callMeta.businessId ?? null);
            if (!menu) {
                console.error(`[IvrCoordinator] IVR menu ${ivrMenuId} not found for call ${callId}`);
                return;
            }
            const menuMeta = {
                ivr_menu_id: menu.id,
                ivr_menu_name: menu.name ?? null,
            };
            const lifecycleBusinessId = Number(callMeta.businessId ?? 0);
            const canLogLifecycle = Number.isInteger(lifecycleBusinessId) && lifecycleBusinessId > 0;

            // 2. Resolve audio paths for all nodes that reference an audio file
            const audioPathMap = await this._resolveAudioPaths(menu);

            // 3. Create RTCAudioSource → track
            const { nonstandard } = wrtc;
            if (!nonstandard?.RTCAudioSource) {
                console.error('[IvrCoordinator] RTCAudioSource unavailable');
                return;
            }

            const audioSource = new nonstandard.RTCAudioSource();
            leakMetrics.audioSourceCreated++;   // DIAGNOSTIC (native): IVR source
            ivrTrack = audioSource.createTrack();
            ivrTrack._isGeneratedSource = true;   // releaseGeneratedTrack() frees the native source on teardown
            const ivrStream = new wrtc.MediaStream([ivrTrack]);

            // Replace the placeholder track on the WhatsApp PC so the caller only
            // hears the IVR audio (not the placeholder tone).
            let sender;
            if (whatsappPeer) {
                const placeholderSender = whatsappPeer.shiftPlaceholderSender();
                if (placeholderSender) {
                    await placeholderSender.replaceTrack(ivrTrack);
                    sender = placeholderSender;
                    console.log(`[IvrCoordinator] Replaced placeholder track with IVR track for call ${callId}`);
                }
            }
            if (!sender) {
                sender = whatsappPc.addTrack(ivrTrack, ivrStream);
            }

            // 4. Create the DTMF sink now (paused) so it's ready when the first
            //    ivr_menu node is entered. Goertzel only runs on ivr_menu nodes —
            //    onNodeEntered toggles pause/resume as the engine navigates.
            if (customerTrack) {
                dtmfCaptureService.startCapture(callId, customerTrack);
                dtmfCaptureService.pauseCapture(callId);
                dtmfStarted = true;
            } else {
                console.error(`[IvrCoordinator] No customer track for call ${callId} — DTMF detection disabled`);
            }

            // 5. Persist session
            const sessionId = await IvrRepository.createSession({
                callId,
                ivrMenuId,
                businessId: callMeta.businessId ?? null,
            });

            const logIvrLifecycle = (methodName, payload = {}) => {
                if (!canLogLifecycle || typeof callLifecycleLogger?.[methodName] !== 'function') return;
                callLifecycleLogger[methodName](callId, lifecycleBusinessId, {
                    ...menuMeta,
                    session_id: sessionId,
                    ...payload,
                }).catch(() => { });
            };

            logIvrLifecycle('logIvrStarted');

            // 6. Create and start engine — pass only the function it actually needs
            const engine = new IvrEngine({
                callId,
                businessId: callMeta.businessId ?? null,
                structure: menu.structure,
                defaultTimeout: menu.timeout_seconds,
                audioSource,
                audioPathMap,
                sessionId,
                recordInput: (data) => IvrRepository.recordInput(data),
                onNodeEntered: ({ nodeId, nodeType, nodeLabel }) => {
                    // Run Goertzel only on ivr_menu nodes — the only nodes
                    // where the caller is expected to press a digit.
                    if (nodeType === 'ivr_menu') {
                        dtmfCaptureService.resumeCapture(callId);
                    } else {
                        dtmfCaptureService.pauseCapture(callId);
                    }

                    logIvrLifecycle('logIvrNodeEntered', {
                        node_id: nodeId,
                        node_type: nodeType,
                        node_label: nodeLabel ?? null,
                    });
                },
                onDtmfReceived: ({ digit, nodeId, nodeType, nodeLabel }) => {
                    logIvrLifecycle('logIvrDtmfReceived', {
                        digit,
                        node_id: nodeId,
                        node_type: nodeType,
                        node_label: nodeLabel ?? null,
                    });
                },
                onRouteSelected: ({
                    digit,
                    routeMethod,
                    status,
                    sourceNodeId,
                    sourceNodeType,
                    sourceNodeLabel,
                    targetNodeId,
                    targetNodeType,
                    targetNodeLabel,
                }) => {
                    logIvrLifecycle('logIvrRouteSelected', {
                        digit,
                        route_method: routeMethod ?? null,
                        route_status: status,
                        source_node_id: sourceNodeId ?? null,
                        source_node_type: sourceNodeType ?? null,
                        source_node_label: sourceNodeLabel ?? null,
                        target_node_id: targetNodeId ?? null,
                        target_node_type: targetNodeType ?? null,
                        target_node_label: targetNodeLabel ?? null,
                    });
                },
            });

            // 7. Listen for IVR completion
            const completeHandler = ({ callId: cid, action, transferData }) => {
                if (cid !== callId) return;
                EventBus.off('call:ivr_complete', completeHandler);
                EventBus.off('call:terminated', terminationHandler);
                this._onComplete(callId, action, callMeta, transferData ?? {}).catch((err) =>
                    console.error(`[IvrCoordinator] Completion error for call ${callId}:`, err.message)
                );
            };

            // 8. Listen for external termination (WhatsApp hang-up, cleanup, etc.)
            const terminationHandler = async ({ callId: cid }) => {
                if (cid !== callId) return;
                EventBus.off('call:terminated', terminationHandler);
                EventBus.off('call:ivr_complete', completeHandler);
                console.log(`[IvrCoordinator] Call ${callId} terminated externally — stopping IVR session`);
                // Capture businessId before stopSession removes the session entry.
                const businessId = this._sessions.get(callId)?.businessId ?? null;
                try {
                    await this.stopSession(callId, 'hung_up');
                } catch (err) {
                    console.error(`[IvrCoordinator] stopSession error for call ${callId}:`, err.message);
                }
                // Trigger peer connection cleanup. The call:ivr_terminated handler in
                // serverListeners calls peerRegistry.closePeerConnection(callId), which
                // removes the call from activeCalls and logs "Peer cleanup done".
                // Without this, IVR calls that end via caller hang-up never get cleaned up
                // because there is no Redis subscription and no FRONTEND peer connection
                // to route the webhook call_terminated event to the cleanup path.
                EventBus.emit('call:ivr_terminated', { callId, action: 'hung_up', businessId });
            };

            // Final guard: if the call terminated during the async menu fetch / audio
            // decode / DB session creation, abort now and release allocated resources.
            if (terminated) {
                console.log(`[IvrCoordinator] Call ${callId} terminated during IVR setup — aborting`);
                engine.stop();
                if (sessionId) {
                    IvrRepository.closeSession(sessionId, 'hung_up', new Date(), 0).catch(() => { });
                }
                return;
            }

            this._sessions.set(callId, {
                engine,
                audioSource,
                senderTrack: ivrTrack,
                sender,
                whatsappPeer,
                whatsappPc,
                sessionId,
                ivrMenuId,
                businessId: callMeta.businessId ?? null,
                startedAtMs: Date.now(),
                completeHandler,
                terminationHandler,
            });
            sessionEstablished = true;

            // Ownership of ivrTrack transferred to the session — clear the local ref
            // so the finally block does not double-release on a normal exit.
            ivrTrack = null;

            EventBus.on('call:ivr_complete', completeHandler);
            EventBus.on('call:terminated', terminationHandler);

            engine.start();
            console.log(`[IvrCoordinator] Session started for call ${callId}`);

        } catch (err) {
            console.error(`[IvrCoordinator] Failed to start session for call ${callId}:`, err.message);
        } finally {
            EventBus.off('call:terminated', earlyGuard);
            // Setup aborted or failed before the real session replaced the reservation
            // — release the slot so isActive(callId) doesn't stay stuck true forever.
            if (!sessionEstablished) {
                this._sessions.delete(callId);
            }
            // Release the native RTCAudioSource if setup failed or was aborted before
            // ownership transferred to the session.
            if (ivrTrack) {
                placeholderTrackFactory.releaseGeneratedTrack(ivrTrack);
            }
            if (dtmfStarted && !this._sessions.has(callId)) {
                dtmfCaptureService.stopCapture(callId);
            }
        }
    }

    /**
     * Stop an IVR session (called on call teardown or after transfer).
     *
     * @param {string} callId
     * @param {'transferred'|'hung_up'|'timeout'|'error'} outcome
     */
    async stopSession(callId, outcome = 'hung_up', timing = {}) {
        const session = this._sessions.get(callId);
        // No session, or startSession() has only reserved the slot and hasn't
        // finished building it yet (no engine/sender exist to stop) — nothing to do.
        // Reachable from shutdown.js, which drives this off a DB query rather than
        // isActive(), so it can legitimately observe the reservation mid-setup.
        if (!session || session._pending) return;

        // Latch BEFORE any of the awaits below (DB writes, track cleanup, etc.).
        // This — not the calls.state flip further down, which can fail silently
        // or lag — is what actually prevents PeerRegistry.checkAndStartBridging
        // from re-launching IVR on this call if a WHATSAPP ICE/track event fires
        // while the rest of this function is still unwinding.
        this._completedCallIds.add(callId);

        const {
            engine,
            sender,
            whatsappPeer,
            whatsappPc,
            sessionId,
            ivrMenuId,
            businessId,
            startedAtMs,
            completeHandler,
            terminationHandler,
        } = session;

        if (completeHandler) EventBus.off('call:ivr_complete', completeHandler);
        if (terminationHandler) EventBus.off('call:terminated', terminationHandler);

        engine.stop();

        // For transfers: return the sender to the placeholder pool so the agent bridge
        // can re-use it via replaceTrack (avoids removeTrack → WebRTC teardown).
        if (outcome === 'transferred' && whatsappPeer && sender) {
            try {
                whatsappPeer.addPlaceholderSender(sender);
                // The IVR track stays on the sender until the agent bridge replaces it.
                // Stash a stable reference so that replaceTrack (Peer.deliverTrack) or
                // final teardown (clearPlaceholderSenders) releases its RTCAudioSource.
                sender._placeholderTrack = session.senderTrack ?? null;
                console.log(`[IvrCoordinator] IVR sender returned to placeholder pool for call ${callId}`);
            } catch (err) {
                console.warn(`[IvrCoordinator] addPlaceholderSender failed for call ${callId}:`, err.message);
            }
        } else {
            try {
                if (whatsappPc && sender && whatsappPc.signalingState !== 'closed') {
                    whatsappPc.removeTrack(sender);
                }
            } catch (err) {
                console.warn(`[IvrCoordinator] removeTrack failed for call ${callId}:`, err.message);
            }
            // Not reused — release the IVR RTCAudioSource native buffer now.
            placeholderTrackFactory.releaseGeneratedTrack(session.senderTrack);
        }

        dtmfCaptureService.stopCapture(callId);

        const endedAt = timing.endedAt instanceof Date ? timing.endedAt : new Date();
        const durationSeconds = Number.isFinite(Number(timing.durationSeconds))
            ? Math.max(0, Math.floor(Number(timing.durationSeconds)))
            : (Number.isFinite(Number(startedAtMs))
                ? Math.max(0, Math.floor((endedAt.getTime() - Number(startedAtMs)) / 1000))
                : null);

        if (sessionId) {
            await IvrRepository.closeSession(sessionId, outcome, endedAt, durationSeconds).catch(() => { });
            if (outcome !== 'transferred' && businessId) {
                await callLifecycleLogger.logIvrTerminated(callId, businessId, {
                    ivr_menu_id: ivrMenuId,
                    session_id: sessionId,
                    outcome,
                }).catch(() => { });
            }
            // Clear the IVR call state for non-transfer outcomes so the dashboard
            // does not keep showing "IVR Processing" after the session ends.
            //
            // For 'transferred', flip state straight to 'QUEUE' here — atomically
            // with this._sessions.delete() below, no await in between. This used to
            // happen later, in IvrTransferHandler, after a couple of its own awaits
            // (logIvrTransferred, audio file resolution). That left a window where
            // the DB still showed state='IVR' while isActive(callId) was already
            // false; if checkAndStartBridging fired in that window (a WHATSAPP
            // track/ICE event landing at just the wrong moment) it matched the
            // IVR-start condition again and re-launched IVR on a call that had
            // already been handed off to the queue.
            if (outcome === 'transferred') {
                await IvrRepository.updateCallState(callId, 'QUEUE', 'RINGING').catch(() => { });
            } else {
                await IvrRepository.updateCallState(callId, null).catch(() => { });
            }
        }

        EventBus.emit('call:ivr_session_closed', {
            callId,
            businessId,
            ivrMenuId,
            sessionId,
            outcome,
            endedAt: endedAt.toISOString(),
            durationSeconds,
        });

        this._sessions.delete(callId);
        console.log(
            `[IvrCoordinator] Session stopped for call ${callId} (outcome: ${outcome}, duration=${durationSeconds ?? 'n/a'}s)`
        );
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    /**
     * Build a Map from nodeId → resolved audio for every node that references
     * an audio file.  S3-stored files are downloaded as Buffer objects so the
     * IvrAudioPlayer can decode them without needing to re-fetch presigned URLs
     * (which fail when fetched from within the Node.js process due to HTTPS
     * signing issues).  Local files stay as absolute path strings.
     *
     * @param {object} menu   result of IvrRepository.findMenu
     * @returns {Promise<Map<string, string|Buffer>>}
     */
    async _resolveAudioPaths(menu) {
        const map = new Map();
        const audioFilesById = menu.audioFilesById ?? {};

        for (const node of (menu.structure?.nodes ?? [])) {
            const audioFileId = node.data?.audioFileId;
            if (audioFileId == null) continue;

            const audioFile = audioFilesById[audioFileId];
            if (!audioFile?.storage_key) {
                console.warn(`[IvrCoordinator] No storage record for audioFileId=${audioFileId} on node ${node.id}`);
                continue;
            }

            try {
                // Fetch raw input (Buffer for S3, local path string for disk)
                let rawInput;
                if (audioFile.storage_disk === 's3') {
                    rawInput = await storageClient.downloadBuffer(audioFile.storage_key);
                } else {
                    rawInput = await resolveStoragePath(audioFile);
                }
                // Decode to PCM once at IVR session start — IvrEngine calls player.play(pcm)
                // which hits the Int16Array fast-path and skips all per-play ffmpeg spawns.
                const pcm = await IvrAudioPlayer.decode(rawInput);
                console.log(`[IvrCoordinator] Pre-decoded audio for node ${node.id}: ${pcm.length} samples`);
                map.set(node.id, pcm);
            } catch (err) {
                console.warn(`[IvrCoordinator] Could not resolve/decode audio for node ${node.id}:`, err.message);
            }
        }

        return map;
    }

    async _onComplete(callId, action, callMeta, transferData = {}) {
        console.log(`[IvrCoordinator] Call ${callId} IVR complete — action=${action}`);
        const endedAt = new Date();
        const startedAtMs = this._sessions.get(callId)?.startedAtMs;
        const durationSeconds = Number.isFinite(Number(startedAtMs))
            ? Math.max(0, Math.floor((endedAt.getTime() - Number(startedAtMs)) / 1000))
            : null;
        const timing = { endedAt, durationSeconds };

        if (action === 'transferred') {
            const session = this._sessions.get(callId);
            const sessionSnap = {
                sender: session?.sender ?? null,
                whatsappPc: session?.whatsappPc ?? null,
                audioSource: session?.audioSource ?? null,
            };

            await ivrTransferHandler.handle(
                callId,
                callMeta,
                transferData,
                sessionSnap,
                (outcome) => this.stopSession(callId, outcome, timing),
            );
        } else {
            const outcomeMap = { hung_up: 'hung_up', timeout: 'timeout', error: 'error' };
            await this.stopSession(callId, outcomeMap[action] ?? 'hung_up', timing);
            // serverListeners' 'call:ivr_terminated' handler runs the full teardown
            // (terminateWhatsAppCall + terminateCallIfNotTerminated + closePeerConnection).
            EventBus.emit('call:ivr_terminated', { callId, action });
        }
    }
}

export const ivrCoordinator = new IvrCoordinator();
