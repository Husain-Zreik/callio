// src/core/ivr/IvrCoordinator.js
//
// Lifecycle coordinator for IVR sessions.  Mirrors DTMFCoordinator /
// RecordingCoordinator in pattern: one singleton, owns state map, clean API.
//
// Started by ChannelIngress once the system answered an IVR call; it plays
// to the caller once their audio arrives. The flow's prompts play and its
// key presses arrive through the media port (core/media/CallMedia.js).
// On 'call:ivr_complete' with action='transfer', delegates to IvrTransferHandler.
import EventBus from '../EventBus.js';
import IvrRepository from '../../persistence/IvrRepository.js';
import { callLifecycleLogger } from '../calls/CallLifecycleLogger.js';
import { IvrEngine } from './IvrEngine.js';
import { ivrTransferHandler } from './IvrTransferHandler.js';
import { callMedia } from '../media/CallMedia.js';
import { logger } from '../../infra/logging/logger.js';
import { callState } from '../../infra/cluster/CallState.js';

const log = logger('core.ivr.IvrCoordinator');

// How long the IVR waits for the caller's audio before playing anyway.
const CUSTOMER_AUDIO_WAIT_MS = 5000;

class IvrCoordinator {
    constructor() {
        // callId → { engine, sessionId, ivrFlowId, tenantId, startedAtMs, completeHandler, terminationHandler }
        this._sessions = new Map();

        // One-way latch: callIds whose IVR session has completed at least once
        // (any outcome). This is the single source of truth for "IVR is over for
        // this call" — set synchronously in stopSession(), before any awaits, so
        // it can never disagree with reality the way calls.state can (that DB
        // write can fail, lag, or race with a concurrent read; this cannot).
        // startSession refuses a call that already finished its IVR. Cleared on
        // call:terminated so this doesn't grow unbounded across the process lifetime.
        this._completedCallIds = new Set();
        EventBus.on('call:terminated', ({ callId }) => this._completedCallIds.delete(callId));
        // IvrTransferHandler emits this when a transfer target was unavailable and
        // the node's action is 'replay': run the flow again on the same session.
        EventBus.on('call:ivr_replay', ({ callId }) => this._replay(callId));
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
     * Start an IVR session for an incoming call the system answered.
     *
     * @param {string}            callId
     * @param {number}            ivrFlowId
     * @param {object}            callMeta       { tenantId, channelId, queueId }
     */
    async startSession(callId, ivrFlowId, callMeta = {}) {
        if (this._sessions.has(callId)) {
            log.warn({ callId }, 'Session already active');
            return;
        }
        if (this._completedCallIds.has(callId)) {
            log.warn({ callId }, 'IVR already completed — refusing to restart');
            return;
        }

        // Reserve the slot synchronously, before any await, so a second start
        // for the same call sees isActive()===true at once instead of building
        // a second engine. stopSession() treats a `_pending` entry the same as
        // no session (see its guard) since setup hasn't allocated anything yet.
        this._sessions.set(callId, { _pending: true });
        let sessionEstablished = false;

        log.info({ callId, ivrFlowId }, 'Starting IVR session');

        // Guard against call:terminated firing during the async setup window
        // (waiting for audio, menu fetch, DB session creation). Without this,
        // _sessions.set() can run after the termination event already fired,
        // leaving the session stuck with no cleanup handler.
        let terminated = false;
        const earlyGuard = ({ callId: cid }) => { if (cid === callId) terminated = true; };
        EventBus.on('call:terminated', earlyGuard);

        try {
            // The first prompt plays once the caller's audio is flowing, so its
            // start isn't lost while the media connects.
            if (!await callMedia.customerAudio(callId, CUSTOMER_AUDIO_WAIT_MS)) {
                log.warn({ callId }, 'No audio from the caller yet — starting the IVR anyway');
            }

            // 1. Fetch menu structure + audio file metadata
            const menu = await IvrRepository.findFlow(ivrFlowId, callMeta.tenantId ?? null);
            if (!menu) {
                log.warn({ callId, ivrFlowId }, 'IVR flow not found');
                return;
            }
            const menuMeta = {
                ivr_flow_id: menu.id,
                ivr_flow_name: menu.name ?? null,
            };
            const lifecycleTenantId = Number(callMeta.tenantId ?? 0);
            const canLogLifecycle = Number.isInteger(lifecycleTenantId) && lifecycleTenantId > 0;

            // 2. Each node's audio, as the media server fetches it
            const audioPathMap = this._resolveAudio(menu);

            // 3. Persist session
            const sessionId = await IvrRepository.createSession({
                callId,
                ivrFlowId,
                tenantId: callMeta.tenantId ?? null,
            });

            const logIvrLifecycle = (methodName, payload = {}) => {
                if (!canLogLifecycle || typeof callLifecycleLogger?.[methodName] !== 'function') return;
                callLifecycleLogger[methodName](callId, lifecycleTenantId, {
                    ...menuMeta,
                    session_id: sessionId,
                    ...payload,
                }).catch(() => { });
            };

            logIvrLifecycle('logIvrStarted');

            // 4. Create and start engine
            const engine = new IvrEngine({
                callId,
                tenantId: callMeta.tenantId ?? null,
                structure: menu.structure,
                defaultTimeout: menu.timeout_seconds,
                createPlayer: () => callMedia.player(callId),
                errorAudio: callMedia.errorAudio(),
                audioPathMap,
                sessionId,
                recordInput: (data) => IvrRepository.recordInput(data),
                onNodeEntered: ({ nodeId, nodeType, nodeLabel }) => {
                    // Key presses count only on ivr_menu nodes — the only
                    // nodes where the caller is expected to press a digit.
                    callMedia.listenForDigits(callId, nodeType === 'ivr_menu');
                    // Where the caller is, for a worker taking the call over.
                    callState.save(callId, 'ivr', { flowId: menu.id, sessionId, nodeId, nodeType })
                        .catch((err) => log.warn({ callId, err }, 'Saving the IVR position failed'));

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

            // 5. Listen for IVR completion
            // terminationHandler stays registered after completion: a transfer to
            // an unavailable target keeps the session alive while it plays the
            // offline/busy message and possibly replays the menu, and a hang-up in
            // that window must still tear the session down. stopSession() removes it.
            const completeHandler = ({ callId: cid, action, transferData }) => {
                if (cid !== callId) return;
                EventBus.off('call:ivr_complete', completeHandler);
                this._onComplete(callId, action, callMeta, transferData ?? {}).catch((err) =>
                    log.error({ callId, err }, 'Completion error')
                );
            };

            // 6. Listen for external termination (provider hang-up, cleanup, etc.)
            const terminationHandler = async ({ callId: cid }) => {
                if (cid !== callId) return;
                EventBus.off('call:terminated', terminationHandler);
                EventBus.off('call:ivr_complete', completeHandler);
                log.info({ callId }, 'Call terminated externally — stopping IVR session');
                // Capture tenantId before stopSession removes the session entry.
                const tenantId = this._sessions.get(callId)?.tenantId ?? null;
                try {
                    await this.stopSession(callId, 'hung_up');
                } catch (err) {
                    log.error({ callId, err }, 'stopSession error');
                }
                EventBus.emit('call:ivr_terminated', { callId, action: 'hung_up', tenantId });
            };

            // Final guard: if the call terminated during setup, abort now.
            if (terminated) {
                log.info({ callId }, 'Call terminated during IVR setup — aborting');
                engine.stop();
                if (sessionId) {
                    IvrRepository.closeSession(sessionId, 'hung_up', new Date(), 0).catch(() => { });
                }
                return;
            }

            this._sessions.set(callId, {
                engine,
                sessionId,
                ivrFlowId,
                tenantId: callMeta.tenantId ?? null,
                startedAtMs: Date.now(),
                completeHandler,
                terminationHandler,
            });
            sessionEstablished = true;

            EventBus.on('call:ivr_complete', completeHandler);
            EventBus.on('call:terminated', terminationHandler);

            engine.start();
            log.info({ callId }, 'Session started');

        } catch (err) {
            log.error({ callId, err }, 'Failed to start session');
        } finally {
            EventBus.off('call:terminated', earlyGuard);
            // Setup aborted or failed before the real session replaced the reservation
            // — release the slot so isActive(callId) doesn't stay stuck true forever.
            if (!sessionEstablished) {
                this._sessions.delete(callId);
                callMedia.listenForDigits(callId, false);
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
        // finished building it yet (no engine exists to stop) — nothing to do.
        // Reachable from shutdown.js, which drives this off a DB query rather than
        // isActive(), so it can legitimately observe the reservation mid-setup.
        if (!session || session._pending) return;

        // Latch BEFORE any of the awaits below (DB writes, track cleanup, etc.).
        // This — not the calls.state flip further down, which can fail silently
        // or lag — is what prevents a late customer-media event from re-launching
        // IVR on this call while the rest of this function is still unwinding.
        this._completedCallIds.add(callId);

        const {
            engine,
            sessionId,
            ivrFlowId,
            tenantId,
            startedAtMs,
            completeHandler,
            terminationHandler,
        } = session;

        if (completeHandler) EventBus.off('call:ivr_complete', completeHandler);
        if (terminationHandler) EventBus.off('call:terminated', terminationHandler);

        engine.stop();

        callMedia.listenForDigits(callId, false);

        const endedAt = timing.endedAt instanceof Date ? timing.endedAt : new Date();
        const durationSeconds = Number.isFinite(Number(timing.durationSeconds))
            ? Math.max(0, Math.floor(Number(timing.durationSeconds)))
            : (Number.isFinite(Number(startedAtMs))
                ? Math.max(0, Math.floor((endedAt.getTime() - Number(startedAtMs)) / 1000))
                : null);

        if (sessionId) {
            await IvrRepository.closeSession(sessionId, outcome, endedAt, durationSeconds).catch(() => { });
            if (outcome !== 'transferred' && tenantId) {
                await callLifecycleLogger.logIvrTerminated(callId, tenantId, {
                    ivr_flow_id: ivrFlowId,
                    session_id: sessionId,
                    outcome,
                }).catch(() => { });
            }
            // Clear the IVR call state for non-transfer outcomes so the dashboard
            // does not keep showing "IVR Processing" after the session ends.
            //
            // For 'transferred', flip state straight to 'QUEUE' here, before the
            // transfer handler's own awaits, so the queue scan sees the call as
            // waiting the moment the IVR lets go of it.
            if (outcome === 'transferred') {
                await IvrRepository.updateCallState(callId, 'QUEUE', 'RINGING').catch(() => { });
            } else {
                await IvrRepository.updateCallState(callId, null).catch(() => { });
            }
        }

        EventBus.emit('call:ivr_session_closed', {
            callId,
            tenantId,
            ivrFlowId,
            sessionId,
            outcome,
            endedAt: endedAt.toISOString(),
            durationSeconds,
        });

        this._sessions.delete(callId);
        await callState.drop(callId, 'ivr').catch(() => { });
        log.info({ callId }, `Session stopped (outcome: ${outcome}, duration=${durationSeconds ?? 'n/a'}s)`);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    _replay(callId) {
        const session = this._sessions.get(callId);
        if (!session || session._pending) return;

        EventBus.on('call:ivr_complete', session.completeHandler);
        session.engine.restart();
        log.info({ callId }, 'Replaying IVR');
    }

    /**
     * nodeId → the node's audio as the media server fetches it, for every node
     * that references an audio file.
     *
     * @param {object} menu   result of IvrRepository.findFlow
     * @returns {Map<string, object>}
     */
    _resolveAudio(menu) {
        const map = new Map();
        const audioFilesById = menu.audioFilesById ?? {};

        for (const node of (menu.structure?.nodes ?? [])) {
            const audioFileId = node.data?.audioFileId;
            if (audioFileId == null) continue;

            const audioFile = audioFilesById[audioFileId];
            if (!audioFile?.storage_key) {
                log.warn({ audioFileId, nodeId: node.id }, 'No storage record for the node audio');
                continue;
            }
            try {
                map.set(node.id, callMedia.audioUrl(audioFile));
            } catch (err) {
                log.warn({ nodeId: node.id, err }, 'Could not resolve the node audio');
            }
        }

        return map;
    }

    async _onComplete(callId, action, callMeta, transferData = {}) {
        log.info({ callId }, `Call IVR complete — action=${action}`);
        const endedAt = new Date();
        const startedAtMs = this._sessions.get(callId)?.startedAtMs;
        const durationSeconds = Number.isFinite(Number(startedAtMs))
            ? Math.max(0, Math.floor((endedAt.getTime() - Number(startedAtMs)) / 1000))
            : null;
        const timing = { endedAt, durationSeconds };

        if (action === 'transferred') {
            await ivrTransferHandler.handle(
                callId,
                callMeta,
                transferData,
                (outcome) => this.stopSession(callId, outcome, timing),
            );
        } else {
            const outcomeMap = { hung_up: 'hung_up', timeout: 'timeout', error: 'error' };
            await this.stopSession(callId, outcomeMap[action] ?? 'hung_up', timing);
            // serverListeners' 'call:ivr_terminated' handler runs the full teardown
            // (customerChannels.terminate + terminateCallIfNotTerminated + closePeerConnection).
            EventBus.emit('call:ivr_terminated', { callId, action, tenantId: callMeta.tenantId ?? null });
        }
    }
}

export const ivrCoordinator = new IvrCoordinator();
