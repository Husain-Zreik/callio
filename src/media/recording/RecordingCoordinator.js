// src/media/recording/RecordingCoordinator.js
//
// Single responsibility: own the "should I record?" policy and the
// start-vs-replace decision.  RecordingManager handles session lifecycle;
// this class handles when to trigger it and with what context.
//
// All DB access for recording decisions lives here — AudioCoordinator
// stays clean of repository imports.
import { recordingManager } from './RecordingManager.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import { config } from '../../../config/envConfig.js';
import CallRepository from '../../persistence/CallRepository.js';
import RecordingRepository from '../../persistence/RecordingRepository.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.recording.RecordingCoordinator');

class RecordingCoordinator {

    // ─────────────────────────────────────────────────────────────────
    // BRIDGE LIFECYCLE
    // ─────────────────────────────────────────────────────────────────

    /**
     * Called after the audio bridge starts (both AGENT + CUSTOMER connected).
     * Decides whether to start a fresh recording session or replace the agent
     * track on an existing session (reconnect / transfer path).
     *
     * @param {string} callId
     * @param {string|null} tenantId
     * @param {{ getTracks: () => {agentTrack, customerTrack}|null, getAgentTrack: () => MediaStreamTrack|null }} trackAccessors
     */
    async checkAndStartRecording(callId, tenantId, trackAccessors) {
        if (!tenantId) {
            log.warn({ callId }, 'Missing tenantId — skipping recording');
            await this._recordFailedAttempt(callId, null, 'Recording skipped: missing tenant context');
            return;
        }

        if (recordingManager.isRecording(callId)) {
            await this._replaceAgentTrack(callId, trackAccessors.getAgentTrack);
            return;
        }

        await this._startFreshRecording(callId, tenantId, trackAccessors.getTracks, trackAccessors.isBridgeActive);
    }

    // ─────────────────────────────────────────────────────────────────
    // AGENT DISCONNECT / RECONNECT
    // ─────────────────────────────────────────────────────────────────

    /**
     * Called when the AGENT peer connection drops.
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
            log.error({ callId, err: error }, 'Failed to stop recording');
        }
    }

    isRecording(callId) {
        return recordingManager.isRecording(callId);
    }

    // ─────────────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────────────

    async _startFreshRecording(callId, tenantId, getTracks, isBridgeActive) {
        const recordingEnabled = await this._isRecordingEnabled(tenantId, callId);
        if (!recordingEnabled) {
            log.debug({ callId }, 'Recording disabled');
            await this._recordFailedAttempt(callId, tenantId, 'Recording disabled in business number settings');
            return;
        }

        const quotaExceeded = await this._isStorageQuotaExceeded(tenantId);
        if (quotaExceeded) {
            log.warn({ tenantId, callId }, 'Storage quota exceeded for tenant — skipping recording');
            await this._recordFailedAttempt(callId, tenantId, 'Recording skipped: storage quota exceeded');
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
                log.debug({ callId }, 'Call ended before recording could attach — skipping');
                await this._recordFailedAttempt(callId, tenantId, 'Recording skipped: call ended before tracks became live');
                return;
            }
            log.warn({ callId }, 'Tracks not live yet — retrying in 1.5s');
            await new Promise(r => setTimeout(r, 1500));
            tracks = getTracks();
        }

        if (!tracks) {
            log.warn({ callId }, 'No live tracks after retry — recording skipped');
            await this._recordFailedAttempt(callId, tenantId, 'Recording skipped: media tracks were not live');
            return;
        }

        // Log readyState and muted for both tracks before attaching sinks.
        // If customer track is 'ended' or muted=true here, the RTCAudioSink ondata
        // will never fire — conclusive evidence of 138021 "no media from Meta".
        const { agentTrack, customerTrack } = tracks;
        log.debug({ callId }, `Track state: agent=${agentTrack?.readyState}(muted=${agentTrack?.muted},enabled=${agentTrack?.enabled}), customer=${customerTrack?.readyState}(muted=${customerTrack?.muted},enabled=${customerTrack?.enabled})`);

        const result = await recordingManager.startRecording(callId, tenantId, tracks);
        log.info({ callId, result }, 'Recording started');
        if (!result?.success) {
            await this._recordFailedAttempt(
                callId,
                tenantId,
                `Recording failed to start: ${result?.reason || 'unknown reason'}`
            );
        }
    }

    async _replaceAgentTrack(callId, getAgentTrack) {
        const agentTrack = getAgentTrack();
        if (agentTrack) {
            log.debug({ callId, trackId: agentTrack.id }, 'Replacing the agent track');
            recordingManager.replaceAgentTrack(callId, agentTrack);
        } else {
            log.warn({ callId }, 'No agent track available to replace');
        }
    }

    // Recording is a per-line setting (channels.recording_enabled).
    async _isRecordingEnabled(tenantId, callId) {
        try {
            const call = await CallRepository.findById(callId);
            const channel = call?.channel_id ? await ChannelRepository.findById(call.channel_id) : null;
            return Boolean(channel?.recording_enabled);
        } catch (error) {
            log.error({ callId, err: error }, 'Failed to check recording config');
            return false;
        }
    }

    /**
     * Returns true if the tenant has used up its recording storage quota
     * (tenants.settings.recording.storage_limit_bytes, else the platform default).
     * On error, returns false (non-fatal — prefer recording over silent skip).
     */
    async _isStorageQuotaExceeded(tenantId) {
        try {
            const limit = await TenantRepository.getRecordingStorageLimitBytes(tenantId)
                ?? config.call.recordingStorageLimitGb * 1024 ** 3;
            const used = await RecordingRepository.getTenantStorageUsageBytes(tenantId);
            return used >= limit;
        } catch (error) {
            log.warn({ tenantId, err: error }, 'Could not check storage quota — proceeding');
            return false;
        }
    }

    /**
     * Ensure every skipped/failed recording attempt has a DB record with reason.
     * Idempotent per call: do not overwrite terminal statuses that already explain outcome.
     */
    async _recordFailedAttempt(callId, tenantId, reason) {
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

            let resolvedTenantId = tenantId;
            if (!resolvedTenantId) {
                const call = await CallRepository.findById(callId);
                resolvedTenantId = call?.tenant_id ?? null;
            }
            if (!resolvedTenantId) {
                // Still persist the failure so the call history shows the reason.
                log.error({ callId }, 'Cannot resolve tenant — persisting failure anyway');
                try {
                    const { id } = await RecordingRepository.create({ call_id: callId });
                    await RecordingRepository.markFailed(id, reason);
                } catch (persistErr) {
                    log.error({ callId, err: persistErr }, 'Persisting the failure without a tenant failed too');
                }
                return;
            }

            const { id } = await RecordingRepository.create({ call_id: callId });
            await RecordingRepository.markFailed(id, reason);
        } catch (error) {
            log.error({ callId, err: error }, 'Failed to persist recording failure');
        }
    }
}

export const recordingCoordinator = new RecordingCoordinator();
