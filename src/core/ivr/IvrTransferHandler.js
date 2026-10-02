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
import { agentAssignmentCoordinator } from '../routing/AgentAssignmentCoordinator.js';
import { callEventHandler } from '../events/CallEventHandler.js';
import { callInbox } from '../../infra/cluster/CallInbox.js';
import { callMedia } from '../media/CallMedia.js';
import { mediaLegs } from '../media/MediaLegs.js';
import { AgentAvailability } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.ivr.IvrTransferHandler');

class IvrTransferHandler {

    /**
     * Execute the full transfer flow after IVR completes with action='transferred'.
     *
     * @param {string}   callId
     * @param {object}   callMeta       { tenantId, channelId, queueId }
     * @param {object}   transferData   node data from the ivr_transfer node
     * @param {Function} stopSession    (outcome: string) => Promise<void>  bound to the active session
     */
    async handle(callId, callMeta, transferData, stopSession) {
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
            log.error({ callId, err }, 'Target availability check failed');
        }
        log.info({ callId }, `Target availability: ${availability}`);

        // ── 2. Resolve offline / busy config from transfer node data ───────────
        const offlineAction = transferData?.offlineAction ?? 'hangup';
        const offlineAudioFileId = transferData?.offlineAudioFileId ?? null;
        const busyAction = transferData?.busyAction ?? 'wait';
        const busyAudioFileId = transferData?.busyAudioFileId ?? null;

        // ── 3. Handle offline target ───────────────────────────────────────────
        if (availability === 'offline' && offlineAction !== 'queue') {
            await this._playOnceAndAct(callId, offlineAudioFileId, offlineAction, stopSession, tenantId);
            return;
        }

        // ── 4. Handle busy target with non-queue action ────────────────────────
        if (availability === 'busy' && (busyAction === 'hangup' || busyAction === 'replay')) {
            await this._playOnceAndAct(callId, busyAudioFileId, busyAction, stopSession, tenantId);
            return;
        }

        // ── 5. Normal transfer / queue path ───────────────────────────────────
        // Stop the IVR session; the caller stays on their leg, out of the room
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
        //   • the agent leg's offer, pre-created on THIS worker (the one holding
        //     the customer's leg) — assignOldestUnassignedCall reuses the stored
        //     offer if present, but if it doesn't find one it creates its own on
        //     whichever worker it happens to run on, which doesn't hold the
        //     customer, so the two would never be bridged.
        // So these three run FIRST, immediately, ahead of the audio/logging work below
        // that has no bearing on queue-scan eligibility.
        await CallRepository.updateTimestamp(callId, 'ringing_at').catch((err) =>
            log.error({ callId, err }, 'Failed to reset ringing_at')
        );
        // queued_at starts the queue's max wait; the queue changes if the node names another.
        const enteringQueueId = targetType === 'queue' && targetId && String(targetId) !== String(callMeta.queueId) ? targetId : null;
        await CallRepository.enterQueue(callId, enteringQueueId).catch((err) =>
            log.warn({ callId, err }, 'Failed to put call in its queue')
        );
        await callInbox.own(callId, callEventHandler.handleCallEvent);
        const queuedCall = await CallRepository.findById(callId);
        if (queuedCall) {
            await mediaLegs.offerAgent(queuedCall).catch((err) =>
                log.error({ callId, err }, 'Agent leg pre-creation failed')
            );
        }

        // For busy+wait: play the node's busyAudio as the queue hold music override
        const busyAudioOverride = (availability === 'busy' && busyAudioFileId)
            ? await this._resolveAudio(busyAudioFileId, tenantId).catch(() => null)
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

        // Hold music while the call waits: the node's busy audio, else the
        // queue's hold audio, else the built-in tone. Stops when it's bridged.
        if (tenantId) {
            const holdQueueId = targetType === 'queue' ? targetId : (callMeta.queueId ?? null);
            const holdAudio = busyAudioOverride ?? await this._queueHoldAudio(holdQueueId, tenantId);
            callMedia.startHold(callId, holdAudio).catch((err) =>
                log.warn({ callId, err }, 'Starting hold music failed')
            );
        }

        log.info({ callId }, 'Call moved to QUEUE (status=RINGING) after IVR transfer');

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
                log.error({ callId, err }, 'assignTransferredCall error')
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
        const stats = await queueRouter.availabilityStats(queue);
        if (stats.available > 0) return 'available';
        return stats.on_call > 0 ? 'busy' : 'offline';
    }

    // ── Internals ──────────────────────────────────────────────────────────────

    /**
     * Play a one-shot audio file to the caller, then either replay the IVR or
     * hang up depending on nextAction.
     *
     * @param {string}   callId
     * @param {number|null} audioFileId
     * @param {'replay'|'hangup'} nextAction
     * @param {Function} stopSession
     */
    async _playOnceAndAct(callId, audioFileId, nextAction, stopSession, tenantId = null) {
        if (audioFileId) {
            const audio = await this._resolveAudio(audioFileId, tenantId);
            if (audio) {
                try {
                    await callMedia.player(callId).play(audio);
                } catch (err) {
                    log.warn({ callId, err }, 'One-shot audio playback failed');
                }
            }
        }

        if (nextAction === 'replay') {
            EventBus.emit('call:ivr_replay', { callId });
        } else {
            await stopSession('hung_up');
            EventBus.emit('call:ivr_terminated', { callId, action: 'hangup', tenantId });
        }
    }

    // An audio asset id → what the media server plays, or null.
    async _resolveAudio(audioFileId, tenantId = null) {
        const file = await IvrRepository.findAudioFile(Number(audioFileId), tenantId);
        if (!file?.storage_key) return null;
        return callMedia.audioUrl(file);
    }

    // The queue's hold audio (queues.hold_audio_asset_id), or null.
    async _queueHoldAudio(queueId, tenantId) {
        if (!queueId) return null;
        try {
            const record = await IvrRepository.getQueueAudio(queueId, tenantId);
            return record ? callMedia.audioUrl(record) : null;
        } catch (err) {
            log.warn({ queueId, err }, 'Looking up the hold audio failed');
            return null;
        }
    }
}

export const ivrTransferHandler = new IvrTransferHandler();
