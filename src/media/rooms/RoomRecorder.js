// src/media/rooms/RoomRecorder.js
// A call's recording, made on the media server: the customer's endpoint
// records in stereo — left what the customer says, right what they hear (the
// room: the agent, and a supervisor when barging) — to a WAV on the media
// server. When the call ends the media server encodes it to Ogg Opus and PUTs
// it to a presigned object-storage URL (callio-recording-upload, in the
// FreeSWITCH image); Callio then checks the object is there and completes the
// row. No audio passes through Callio.
//
// Policy: recording is per line (channels.recording_enabled) and bounded by
// the tenant's storage quota; a skipped or failed recording still leaves a
// call_recordings row saying why.
import CallRepository from '../../persistence/CallRepository.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import RecordingRepository from '../../persistence/RecordingRepository.js';
import { storageClient } from '../../infra/storage/StorageClient.js';
import { freeSwitch } from './FreeSwitch.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.rooms.RoomRecorder');

const UPLOAD_SCRIPT = '/usr/local/bin/callio-recording-upload';
const UPLOAD_WAIT_MS = 120_000;

class RoomRecorder {
    constructor() {
        this._pending = new Set();   // upload checks in flight
    }

    // Resolves once every upload in flight has landed or given up (or after timeoutMs).
    async drain(timeoutMs) {
        if (!this._pending.size) return;
        await Promise.race([
            Promise.allSettled([...this._pending]),
            new Promise((r) => setTimeout(r, timeoutMs).unref()),
        ]);
    }

    async _policy(call) {
        const channel = call.channel_id ? await ChannelRepository.findById(call.channel_id) : null;
        if (!channel?.recording_enabled) return { record: false };
        if (!storageClient.isInitialized) return { record: false, reason: 'Recording skipped: object storage is not configured' };
        try {
            const limit = await TenantRepository.getRecordingStorageLimitBytes(call.tenant_id)
                ?? config.call.recordingStorageLimitGb * 1024 ** 3;
            const used = await RecordingRepository.getTenantStorageUsageBytes(call.tenant_id);
            if (used >= limit) return { record: false, reason: 'Recording skipped: storage quota exceeded' };
        } catch (err) {
            log.warn({ tenantId: call.tenant_id, err }, 'Could not check storage quota — recording anyway');
        }
        return { record: true };
    }

    // Starts recording the customer's endpoint. Returns the recording state
    // for stop(), or null.
    async start(callId, customerEp) {
        try {
            const call = await CallRepository.findById(callId);
            if (!call) return null;
            if (await RecordingRepository.findByCallId(callId)) return null;   // one per call
            const { record, reason } = await this._policy(call);
            if (!record) {
                if (reason) {
                    const { id } = await RecordingRepository.create({ call_id: callId });
                    await RecordingRepository.markFailed(id, reason);
                    log.warn({ callId }, reason);
                }
                return null;
            }
            const { id } = await RecordingRepository.create({ call_id: callId });
            const file = `${config.media.recordingDir}/callio-${callId}-${id}.wav`;
            await customerEp.set('RECORD_STEREO', 'true');
            const res = await freeSwitch.api(`uuid_record ${customerEp.uuid} start ${file}`);
            if (!/^\+OK/.test(res)) {
                await RecordingRepository.markFailed(id, `Recording failed to start: ${res.trim()}`);
                log.error({ callId }, `uuid_record start failed: ${res.trim()}`);
                return null;
            }
            log.info({ callId, recordingId: id }, 'Recording started');
            return { id, file, uuid: customerEp.uuid, callId, tenantId: call.tenant_id, startedAt: Date.now() };
        } catch (err) {
            log.error({ callId, err }, 'Starting the recording failed');
            return null;
        }
    }

    // Stops the recording and has the media server upload it. Resolves once
    // the media server took the job; completing the row happens after.
    async stop(rec) {
        if (!rec || rec.stopped) return;
        rec.stopped = true;
        const durationSeconds = Math.max(0, Math.round((Date.now() - rec.startedAt) / 1000));
        await freeSwitch.api(`uuid_record ${rec.uuid} stop ${rec.file}`).catch(() => { });
        try {
            await RecordingRepository.updateStatus(rec.id, 'processing');
            const key = `${config.storage.s3.prefix}${rec.tenantId}/${rec.callId}/${rec.callId}_${Date.now()}.ogg`;
            const url = await storageClient.getSignedUploadUrl(key, 'audio/ogg', 3600);
            const res = await freeSwitch.api(`bg_system ${UPLOAD_SCRIPT} ${rec.file} '${url}'`);
            if (!/^\+OK/.test(res)) throw new Error(`bg_system: ${res.trim()}`);
            this._awaitUpload(rec, key, durationSeconds);
        } catch (err) {
            log.error({ callId: rec.callId, err }, 'Uploading the recording failed');
            await RecordingRepository.markFailed(rec.id, `Upload failed: ${err.message}`).catch(() => { });
        }
    }

    _awaitUpload(rec, key, durationSeconds) {
        let done;
        const pending = new Promise((r) => { done = r; });
        this._pending.add(pending);
        pending.then(() => this._pending.delete(pending));
        const deadline = Date.now() + UPLOAD_WAIT_MS;
        const tick = async () => {
            try {
                const obj = await storageClient.head(key);
                if (obj) {
                    await RecordingRepository.updateStorageKey(rec.id, key, obj.size);
                    await RecordingRepository.markCompleted(rec.id, durationSeconds);
                    log.info({ callId: rec.callId, recordingId: rec.id }, `Recording uploaded (${obj.size} bytes)`);
                    done();
                    return;
                }
            } catch (err) {
                log.debug({ callId: rec.callId, err }, 'Checking the recording upload failed');
            }
            if (Date.now() > deadline) {
                await RecordingRepository.markFailed(rec.id, 'Upload did not arrive in object storage').catch(() => { });
                log.error({ callId: rec.callId, recordingId: rec.id }, 'Recording upload never arrived');
                done();
                return;
            }
            setTimeout(tick, 1000).unref();
        };
        setTimeout(tick, 1000).unref();
    }
}

export const roomRecorder = new RoomRecorder();
