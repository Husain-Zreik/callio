// src/core/ivr/IvrTransferHandler.js
//
// Handles the post-IVR transfer flow.
//
// Single responsibility: orchestrate everything that happens after the IVR engine
// emits action='transferred' — availability check, offline/busy branching, queue
// audio startup, DB state transition, and agent assignment.
//
// Extracted from IvrCoordinator._onComplete to keep each class focused on one concern.

import EventBus from '../EventBus.js';
import IvrRepository from '../../persistence/IvrRepository.js';
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import QueueRepository from '../../persistence/QueueRepository.js';
import { queueRouter } from '../routing/QueueRouter.js';
import { callLifecycleLogger } from '../calls/CallLifecycleLogger.js';
import { IvrAudioPlayer } from '../../media/playback/IvrAudioPlayer.js';
import { agentAssignmentCoordinator } from '../routing/AgentAssignmentCoordinator.js';
import { callEventHandler } from '../events/CallEventHandler.js';
import { queueAudioCoordinator } from '../../media/playback/QueueAudioCoordinator.js';
import { sdpCoordinator } from '../../media/webrtc/SDPCoordinator.js';
import { resolveStoragePath } from '../../infra/storage/StorageResolver.js';
import { ConnectionType, AgentAvailability } from '../constants/CallConstants.js';

class IvrTransferHandler {

    /**
     * Execute the full transfer flow after IVR completes with action='transferred'.
     *
     * @param {string}   callId
     * @param {object}   callMeta       { tenantId, channelId, queueId }
     * @param {object}   transferData   node data from the ivr_transfer node
     * @param {object}   sessionSnap    { sender, whatsappPc, audioSource }
     * @param {Function} stopSession    (outcome: string) => Promise<void>  bound to the active session
     */
    async handle(callId, callMeta, transferData, sessionSnap, stopSession) {
        const { sender, whatsappPc, audioSource } = sessionSnap;
        const tenantId = callMeta.tenantId ?? null;
        // Transfer targets are an agent or a queue ('group' is accepted as a queue
        // for flows authored before queues existed). A queue node with no target
        // means the channel's inbound queue.
        const rawTargetType = String(transferData?.targetType ?? 'queue').toLowerCase();
        const targetType = rawTargetType === 'agent' ? 'agent' : 'queue';
        const rawTargetId = transferData?.targetId ? Number(transferData.targetId) : null;
        const targetId = targetType === 'queue' ? (rawTargetId ?? callMeta.queueId ?? null) : rawTargetId;

        // ── 1. Availability check ──────────────────────────────────────────────
        let availability = 'available';
        try {
            availability = await this._targetAvailability(targetType, targetId, tenantId);
        } catch (err) {
            console.error(`[IvrTransferHandler] Target availability check failed for call ${callId}:`, err);
        }
        console.log(`[IvrTransferHandler] Target availability for call ${callId}: ${availability}`);

        // ── 2. Resolve offline / busy config from transfer node data ───────────
        const offlineAction = transferData?.offlineAction ?? 'hangup';
        const offlineAudioFileId = transferData?.offlineAudioFileId ?? null;
        const busyAction = transferData?.busyAction ?? 'wait';
        const busyAudioFileId = transferData?.busyAudioFileId ?? null;

        // ── 3. Handle offline target ───────────────────────────────────────────
        if (availability === 'offline' && offlineAction !== 'queue') {
            await this._playOnceAndAct(callId, offlineAudioFileId, offlineAction, audioSource, stopSession, tenantId);
            return;
        }

        // ── 4. Handle busy target with non-queue action ────────────────────────
        if (availability === 'busy' && (busyAction === 'hangup' || busyAction === 'replay')) {
            await this._playOnceAndAct(callId, busyAudioFileId, busyAction, audioSource, stopSession, tenantId);
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
        // queue scan (findOldestUnassignedCalls matches state='QUEUE', agent_id IS NULL,
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
        if (targetType === 'queue' && targetId && String(targetId) !== String(callMeta.queueId)) {
            await CallRepository.updateQueue(callId, targetId).catch((err) =>
                console.warn(`[IvrTransferHandler] Failed to move call ${callId} to queue ${targetId}:`, err)
            );
        }
        await sdpCoordinator.createSDPOffer(
            callId,
            ConnectionType.AGENT,
            callEventHandler.handleCallEvent,
        ).catch((err) =>
            console.error(`[IvrTransferHandler] FRONTEND SDP pre-creation failed for call ${callId}:`, err.message)
        );

        // For busy+wait: play the node's busyAudio as the queue hold music override
        const busyAudioOverridePath = (availability === 'busy' && busyAudioFileId)
            ? await this._resolveAudioFileId(busyAudioFileId, tenantId).catch(() => null)
            : null;

        if (tenantId) {
            await callLifecycleLogger.logIvrTransferred(callId, tenantId, {
                target_type: targetType,
                target_id: targetId,
                availability,
                offline_action: offlineAction,
                busy_action: busyAction,
            }).catch(() => { });
        }

        if (sender && whatsappPc && tenantId) {
            queueAudioCoordinator.startQueueAudio(
                callId, tenantId, sender, whatsappPc, busyAudioOverridePath,
                targetType === 'queue' ? targetId : (callMeta.queueId ?? null),
            ).catch((err) =>
                console.warn(`[IvrTransferHandler] QueueAudioCoordinator start failed for call ${callId}:`, err.message)
            );
        }

        console.log(`[IvrTransferHandler] Call ${callId} moved to QUEUE (status=RINGING) after IVR transfer`);

        // Notify dashboards
        EventBus.emit('call:ivr_transferred', {
            callId,
            tenantId,
            channelId: callMeta.channelId ?? null,
        });

        // Fetch full call record for the agent assignment payload
        const callRecord = await IvrRepository.findCallRecord(callId).catch(() => null);

        if (tenantId && callRecord) {
            await agentAssignmentCoordinator.assignTransferredCall(
                callId, callRecord, tenantId, targetType, targetId,
            ).catch((err) =>
                console.error(`[IvrTransferHandler] assignTransferredCall error for call ${callId}:`, err.message)
            );
        } else if (tenantId) {
            await agentAssignmentCoordinator.emitQueueUpdate(tenantId).catch(() => { });
        }
    }

    // 'available' (someone can take it now), 'busy' (members exist but all
    // ON_CALL) or 'offline'.
    async _targetAvailability(targetType, targetId, tenantId) {
        if (targetType === 'agent') {
            const agent = targetId ? await AgentRepository.findById(targetId) : null;
            if (!agent || String(agent.tenant_id) !== String(tenantId)) return 'offline';
            if (agent.availability === AgentAvailability.AVAILABLE) return 'available';
            return agent.availability === AgentAvailability.ON_CALL ? 'busy' : 'offline';
        }
        const queue = targetId ? await QueueRepository.findForTenant(targetId, tenantId) : null;
        const stats = await queueRouter.availabilityStats(queue, tenantId);
        if (stats.available > 0) return 'available';
        return stats.on_call > 0 ? 'busy' : 'offline';
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
    async _playOnceAndAct(callId, audioFileId, nextAction, audioSource, stopSession, tenantId = null) {
        if (audioFileId && audioSource) {
            const audioPath = await this._resolveAudioFileId(audioFileId, tenantId);
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
    async _resolveAudioFileId(audioFileId, tenantId = null) {
        const file = await IvrRepository.findAudioFile(Number(audioFileId), tenantId);
        if (!file?.storage_key) return null;
        return resolveStoragePath(file);
    }
}

export const ivrTransferHandler = new IvrTransferHandler();
