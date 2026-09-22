// services/call/audio/recording/RecordingCoordinator.js
//
// Single responsibility: own the "should I record?" policy and the
// start-vs-replace decision.  RecordingManager handles session lifecycle;
// this class handles when to trigger it and with what context.
//
// All DB access for recording decisions lives here — AudioCoordinator
// stays clean of repository imports.
import { recordingManager } from './RecordingManager.js';
import BusinessRepository from '../../../../repositories/BusinessRepository.js';
import CallRepository from '../../../../repositories/CallRepository.js';
import RecordingRepository from '../../../../repositories/RecordingRepository.js';

class RecordingCoordinator {

    // ─────────────────────────────────────────────────────────────────
    // BRIDGE LIFECYCLE
    // ─────────────────────────────────────────────────────────────────

    /**
     * Called after the audio bridge starts (both FRONTEND + WHATSAPP connected).
     * Decides whether to start a fresh recording session or replace the agent
     * track on an existing session (reconnect / transfer path).
     *
     * @param {string} callId
     * @param {string|null} businessId
     * @param {{ getTracks: () => {agentTrack, customerTrack}|null, getAgentTrack: () => MediaStreamTrack|null }} trackAccessors
     */
    async checkAndStartRecording(callId, businessId, trackAccessors) {
        if (!businessId) {
            console.error(`[RecordingCoordinator] Missing businessId for call ${callId} — skipping recording`);
            await this._recordFailedAttempt(callId, null, 'Recording skipped: missing business context');
            return;
        }

        let isCallCenter;
        try {
            isCallCenter = await BusinessRepository.isCallCentered(businessId);
        } catch (err) {
            console.error(`[RecordingCoordinator] isCallCentered() failed for call ${callId}: ${err.message}`);
            await this._recordFailedAttempt(callId, businessId, `Recording skipped: failed to check call-center status — ${err.message}`);
            return;
        }
        if (!isCallCenter) {
            await this._recordFailedAttempt(callId, businessId, 'Recording skipped: business is not call-center');
            return;
        }

        if (recordingManager.isRecording(callId)) {
            await this._replaceAgentTrack(callId, trackAccessors.getAgentTrack);
            return;
        }

        await this._startFreshRecording(callId, businessId, trackAccessors.getTracks, trackAccessors.isBridgeActive);
    }

    // ─────────────────────────────────────────────────────────────────
    // FRONTEND DISCONNECT / RECONNECT
    // ─────────────────────────────────────────────────────────────────

    /**
     * Called when the FRONTEND peer connection drops.
     * Pauses agent capture and returns a PCM callback for wiring the
     * reconnecting-tone placeholder into the active recording session.
     * Returns null if no recording is active.
     *
     * @param {string} callId
     * @returns {((pcmBuffer: Buffer) => void)|null}
     */
    pauseAgentCapture(callId) {
        if (!recordingManager.isRecording(callId)) return null;

        recordingManager.pauseAgentCapture(callId);

        const session = recordingManager.getSession(callId);
        if (!session) return null;

        return (pcmBuffer) => session.writeAudioData(pcmBuffer, 'agent');
    }

    // ─────────────────────────────────────────────────────────────────
    // TEARDOWN
    // ─────────────────────────────────────────────────────────────────

    async stopRecording(callId) {
        try {
            await recordingManager.stopRecording(callId);
        } catch (error) {
            console.error(`[RecordingCoordinator] Failed to stop recording for call ${callId}:`, error.message);
        }
    }

    isRecording(callId) {
        return recordingManager.isRecording(callId);
    }

    // ─────────────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────────────

    async _startFreshRecording(callId, businessId, getTracks, isBridgeActive) {
        const recordingEnabled = await this._isRecordingEnabled(businessId, callId);
        if (!recordingEnabled) {
            console.log(`[RecordingCoordinator] Recording disabled for call ${callId}`);
            await this._recordFailedAttempt(callId, businessId, 'Recording disabled in business number settings');
            return;
        }

        const quotaExceeded = await this._isStorageQuotaExceeded(businessId);
        if (quotaExceeded) {
            console.warn(`[RecordingCoordinator] Storage quota exceeded for business ${businessId} — skipping recording for call ${callId}`);
            await this._recordFailedAttempt(callId, businessId, 'Recording skipped: storage quota exceeded');
            return;
        }

        // Tracks become 'live' slightly after connectionState reaches 'connected'.
        // Retry once after a short wait rather than silently skipping.
        let tracks = getTracks();
        if (!tracks) {
            // A very short call (near-instant hangup right as the bridge starts) tears
            // the bridge down before tracks ever go live — retrying against a bridge
            // that's already gone just wastes 1.5s and logs a second, misleading error.
            // Bail immediately in that case; this is expected behavior, not a failure.
            if (!isBridgeActive()) {
                console.log(`[RecordingCoordinator] Call ${callId} ended before recording could attach — skipping`);
                await this._recordFailedAttempt(callId, businessId, 'Recording skipped: call ended before tracks became live');
                return;
            }
            console.warn(`[RecordingCoordinator] Tracks not live yet for call ${callId} — retrying in 1.5s`);
            await new Promise(r => setTimeout(r, 1500));
            tracks = getTracks();
        }

        if (!tracks) {
            console.error(`[RecordingCoordinator] No live tracks after retry for call ${callId} — recording skipped`);
            await this._recordFailedAttempt(callId, businessId, 'Recording skipped: media tracks were not live');
            return;
        }

        // Log readyState and muted for both tracks before attaching sinks.
        // If customer track is 'ended' or muted=true here, the RTCAudioSink ondata
        // will never fire — conclusive evidence of 138021 "no media from Meta".
        const { agentTrack, customerTrack } = tracks;
        console.log(
            `[RecordingCoordinator] Track state for call ${callId}: ` +
            `agent=${agentTrack?.readyState}(muted=${agentTrack?.muted},enabled=${agentTrack?.enabled}), ` +
            `customer=${customerTrack?.readyState}(muted=${customerTrack?.muted},enabled=${customerTrack?.enabled})`
        );

        const result = await recordingManager.startRecording(callId, businessId, tracks);
        console.log(`[RecordingCoordinator] Recording started for call ${callId}:`, result);
        if (!result?.success) {
            await this._recordFailedAttempt(
                callId,
                businessId,
                `Recording failed to start: ${result?.reason || 'unknown reason'}`
            );
        }
    }

    async _replaceAgentTrack(callId, getAgentTrack) {
        const agentTrack = getAgentTrack();
        if (agentTrack) {
            console.log(`[RecordingCoordinator] Replacing agent track for call ${callId}: ${agentTrack.id}`);
            recordingManager.replaceAgentTrack(callId, agentTrack);
        } else {
            console.warn(`[RecordingCoordinator] No agent track available to replace for call ${callId}`);
        }
    }

    async _isRecordingEnabled(businessId, callId) {
        try {
            const call = await CallRepository.findById(callId);
            const businessNumberId = call?.business_number_id;

            return businessNumberId
                ? BusinessRepository.isRecordingEnabledForBusinessNumber(businessNumberId)
                : BusinessRepository.isRecordingEnabledForBusiness(businessId);
        } catch (error) {
            console.error(`[RecordingCoordinator] Failed to check recording config for call ${callId}:`, error.message);
            return false;
        }
    }

    /**
     * Returns true if the business has exceeded its recording storage quota.
     * On error, returns false (non-fatal — prefer recording over silent skip).
     */
    async _isStorageQuotaExceeded(businessId) {
        try {
            const quota = await BusinessRepository.getRecordingStorageUsage(businessId);
            return quota.exceeded === true;
        } catch (error) {
            console.warn(`[RecordingCoordinator] Could not check storage quota for business ${businessId} — proceeding:`, error.message);
            return false;
        }
    }

    /**
     * Ensure every skipped/failed recording attempt has a DB record with reason.
     * Idempotent per call: do not overwrite terminal statuses that already explain outcome.
     */
    async _recordFailedAttempt(callId, businessId, reason) {
        try {
            let existing = await RecordingRepository.findByCallId(callId);
            if (existing) {
                // Keep existing terminal outcomes untouched.
                if (existing.status === 'completed' || existing.status === 'failed') {
                    return;
                }
                await RecordingRepository.markFailed(existing.id, reason);
                return;
            }

            let resolvedBusinessId = businessId;
            if (!resolvedBusinessId) {
                const call = await CallRepository.findById(callId);
                resolvedBusinessId = call?.business_id ?? null;
            }
            if (!resolvedBusinessId) {
                // Last resort: create the record with business_id = null so the call
                // history can still show the failure reason. The FK constraint is
                // nullable, so this is safe and keeps every attempted recording visible.
                console.error(`[RecordingCoordinator] Cannot resolve business id for call ${callId} — persisting failure without business context`);
                try {
                    const { id } = await RecordingRepository.create({ call_id: callId, business_id: null });
                    await RecordingRepository.markFailed(id, reason);
                } catch (persistErr) {
                    console.error(`[RecordingCoordinator] Even null-business persist failed for call ${callId}:`, persistErr.message);
                }
                return;
            }

            const { id } = await RecordingRepository.create({
                call_id: callId,
                business_id: resolvedBusinessId,
            });
            await RecordingRepository.markFailed(id, reason);
        } catch (error) {
            console.error(`[RecordingCoordinator] Failed to persist recording failure for call ${callId}:`, error.message);
        }
    }
}

export const recordingCoordinator = new RecordingCoordinator();
