// services/call/ivr/IvrTransferHandler.js
//
// Handles the post-IVR transfer flow.
//
// Single responsibility: orchestrate everything that happens after the IVR engine
// emits action='transferred' — availability check, offline/busy branching, queue
// audio startup, DB state transition, and agent assignment.
//
// Extracted from IvrCoordinator._onComplete to keep each class focused on one concern.

import EventBus from '../../core/EventBus.js';
import IvrRepository from '../../../repositories/IvrRepository.js';
import CallRepository from '../../../repositories/CallRepository.js';
import AgentRepository from '../../../repositories/AgentRepository.js';
import { callLifecycleLogger } from '../lifecycle/CallLifecycleLogger.js';
import { IvrAudioPlayer } from './IvrAudioPlayer.js';
import { agentAssignmentCoordinator } from '../assignment/AgentAssignmentCoordinator.js';
import { callEventHandler } from '../events/CallEventHandler.js';
import { queueAudioCoordinator } from './QueueAudioCoordinator.js';
import { sdpCoordinator } from '../signaling/webrtc/SDPCoordinator.js';
import { resolveStoragePath } from '../../storage/StorageResolver.js';
import { RoutingStrategy, ConnectionType } from '../constants/CallConstants.js';

class IvrTransferHandler {

    /**
     * Execute the full transfer flow after IVR completes with action='transferred'.
     *
     * @param {string}   callId
     * @param {object}   callMeta       { businessId, businessNumberId }
     * @param {object}   transferData   node data from the ivr_transfer node
     * @param {object}   sessionSnap    { sender, whatsappPc, audioSource }
     * @param {Function} stopSession    (outcome: string) => Promise<void>  bound to the active session
     */
    async handle(callId, callMeta, transferData, sessionSnap, stopSession) {
        const { sender, whatsappPc, audioSource } = sessionSnap;
        const businessId = callMeta.businessId ?? null;
        const targetType = transferData?.targetType ?? 'queue';
        const targetId = transferData?.targetId ? Number(transferData.targetId) : null;

        // ── 1. Availability check ──────────────────────────────────────────────
        let availability = 'available';
        try {
            availability = await AgentRepository.checkTargetAvailability(targetType, targetId, businessId);
        } catch (err) {
            console.error(`[IvrTransferHandler] checkTargetAvailability failed for call ${callId}:`, err.message);
        }
        console.log(`[IvrTransferHandler] Target availability for call ${callId}: ${availability}`);

        // ── 2. Resolve offline / busy config from transfer node data ───────────
        const offlineAction = transferData?.offlineAction ?? 'hangup';
        const offlineAudioFileId = transferData?.offlineAudioFileId ?? null;
        const busyAction = transferData?.busyAction ?? 'wait';
        const busyAudioFileId = transferData?.busyAudioFileId ?? null;

        // ── 3. Handle offline target ───────────────────────────────────────────
        if (availability === 'offline' && offlineAction !== 'queue') {
            await this._playOnceAndAct(callId, offlineAudioFileId, offlineAction, audioSource, stopSession, businessId);
            return;
        }

        // ── 4. Handle busy target with non-queue action ────────────────────────
        if (availability === 'busy' && (busyAction === 'hangup' || busyAction === 'replay')) {
            await this._playOnceAndAct(callId, busyAudioFileId, busyAction, audioSource, stopSession, businessId);
            return;
        }

        // ── 5. Normal transfer / queue path ───────────────────────────────────
        // Stop IVR session — sender is returned to placeholder pool (not removed)
        await stopSession('transferred');

        // Call is already in QUEUE state (status=RINGING) — stopSession('transferred')
        // sets that atomically at IVR-teardown time, before this handler's own awaits
        // could open a window where DB state='IVR' but the session was already gone.
        //
        // That also means this call becomes visible to assignOldestUnassignedCall's
        // queue scan (findOldestUnassignedCalls matches state='QUEUE', user_id IS NULL,
        // ordered by ringing_at) from this point on. Three things it expects to
        // already reflect this transfer if it grabs the call before we assign it
        // ourselves below:
        //   • ringing_at reset to now, so this call isn't mistaken for the oldest
        //     queued call using its pre-IVR ringing timestamp
        //   • the routing scope, so it scopes eligible agents correctly instead of
        //     falling back to whatever stale/default metadata predates this transfer
        //   • the FRONTEND SDP offer, pre-created on THIS worker (the one that owns
        //     the WHATSAPP peer) — assignOldestUnassignedCall reuses local_sdp if
        //     present, but if it doesn't find one it creates its own on whichever
        //     worker it happens to run on, which has no WHATSAPP peer, so
        //     checkAndStartBridging would never find a match to bridge against.
        // So these three run FIRST, immediately, ahead of the audio/logging work below
        // that has no bearing on queue-scan eligibility.
        await CallRepository.updateTimestamp(callId, 'ringing_at').catch((err) =>
            console.error(`[IvrTransferHandler] Failed to reset ringing_at for call ${callId}:`, err.message)
        );
        await this._persistTransferRoutingScope(callId, targetType, targetId).catch((err) =>
            console.warn(`[IvrTransferHandler] Failed to persist transfer routing scope for call ${callId}:`, err.message)
        );
        await sdpCoordinator.createSDPOffer(
            callId,
            ConnectionType.FRONTEND,
            callEventHandler.handleCallEvent,
        ).catch((err) =>
            console.error(`[IvrTransferHandler] FRONTEND SDP pre-creation failed for call ${callId}:`, err.message)
        );

        // For busy+wait: play the node's busyAudio as the queue hold music override
        const busyAudioOverridePath = (availability === 'busy' && busyAudioFileId)
            ? await this._resolveAudioFileId(busyAudioFileId, businessId).catch(() => null)
            : null;

        if (businessId) {
            await callLifecycleLogger.logIvrTransferred(callId, businessId, {
                target_type: targetType,
                target_id: targetId,
                availability,
                offline_action: offlineAction,
                busy_action: busyAction,
            }).catch(() => { });
        }

        if (sender && whatsappPc && businessId) {
            queueAudioCoordinator.startQueueAudio(
                callId, businessId, sender, whatsappPc, busyAudioOverridePath,
            ).catch((err) =>
                console.warn(`[IvrTransferHandler] QueueAudioCoordinator start failed for call ${callId}:`, err.message)
            );
        }

        console.log(`[IvrTransferHandler] Call ${callId} moved to QUEUE (status=RINGING) after IVR transfer`);

        // Notify dashboards
        EventBus.emit('call:ivr_transferred', {
            callId,
            businessId,
            businessNumberId: callMeta.businessNumberId ?? null,
        });

        // Fetch full call record for the agent assignment payload
        const callRecord = await IvrRepository.findCallRecord(callId).catch(() => null);

        if (businessId && callRecord) {
            await agentAssignmentCoordinator.assignTransferredCall(
                callId, callRecord, businessId, targetType, targetId,
            ).catch((err) =>
                console.error(`[IvrTransferHandler] assignTransferredCall error for call ${callId}:`, err.message)
            );
        } else if (businessId) {
            await agentAssignmentCoordinator.emitQueueUpdate(businessId).catch(() => { });
        }
    }

    // ── Internals ──────────────────────────────────────────────────────────────

    /**
     * Play a one-shot audio file through the IVR RTCAudioSource, then either
     * replay the IVR or hang up depending on nextAction.
     *
     * @param {string}   callId
     * @param {number|null} audioFileId
     * @param {'replay'|'hangup'} nextAction
     * @param {object}   audioSource   RTCAudioSource
     * @param {Function} stopSession
     */
    async _playOnceAndAct(callId, audioFileId, nextAction, audioSource, stopSession, businessId = null) {
        if (audioFileId && audioSource) {
            const audioPath = await this._resolveAudioFileId(audioFileId, businessId);
            if (audioPath) {
                try {
                    const player = new IvrAudioPlayer(audioSource);
                    await player.play(audioPath);
                } catch (err) {
                    console.warn(`[IvrTransferHandler] One-shot audio playback failed for call ${callId}:`, err.message);
                }
            }
        }

        if (nextAction === 'replay') {
            EventBus.emit('call:ivr_replay', { callId });
        } else {
            await stopSession('hung_up');
            EventBus.emit('call:ivr_terminated', { callId, action: 'hangup' });
        }
    }

    /**
     * Resolve a media_files.id (audio) to a local file path or URL.
     * @param {number} audioFileId
     * @returns {Promise<string|null>}
     */
    async _resolveAudioFileId(audioFileId, businessId = null) {
        const file = await IvrRepository.findAudioFile(Number(audioFileId), businessId);
        if (!file?.storage_key) return null;
        return resolveStoragePath(file);
    }

    async _persistTransferRoutingScope(callId, targetType, targetId) {
        const call = await CallRepository.findById(callId);
        if (!call) return;

        let metadata = null;
        if (call.metadata && typeof call.metadata === 'object') {
            metadata = call.metadata;
        } else if (typeof call.metadata === 'string') {
            try { metadata = JSON.parse(call.metadata); } catch { metadata = null; }
        }
        if (!metadata || typeof metadata !== 'object') metadata = {};

        const normalizedTargetType = String(targetType || 'queue').toLowerCase();
        const normalizedTargetId = Number.isFinite(Number(targetId)) ? Number(targetId) : null;

        const routing = normalizedTargetType === 'agent' || normalizedTargetType === 'group'
            ? {
                strategy: RoutingStrategy.RECEPTIONIST,
                assignmentStrategy: RoutingStrategy.RECEPTIONIST,
                receptionistTargetType: normalizedTargetType,
                receptionistTargetId: normalizedTargetId,
                receptionistAgentId: normalizedTargetType === 'agent' ? normalizedTargetId : null,
                receptionistGroupId: normalizedTargetType === 'group' ? normalizedTargetId : null,
                priorityMode: null,
                priorityGroupId: null,
                priorityAgentIds: [],
            }
            : {
                strategy: RoutingStrategy.QUEUE,
                assignmentStrategy: RoutingStrategy.QUEUE,
                receptionistTargetType: null,
                receptionistTargetId: null,
                receptionistAgentId: null,
                receptionistGroupId: null,
                priorityMode: null,
                priorityGroupId: null,
                priorityAgentIds: [],
            };

        metadata.routing = routing;
        await CallRepository.updateMetadata(callId, metadata);
    }
}

export const ivrTransferHandler = new IvrTransferHandler();
