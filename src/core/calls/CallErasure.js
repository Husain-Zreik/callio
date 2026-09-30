// src/core/calls/CallErasure.js
// Deleting data on a consumer's request (docs/management-api.md#deleting-data):
//   deleteCall     — one ended call and everything about it;
//   eraseCustomer  — one customer's personal data from all of a tenant's ended
//                    calls: the calls stay (history, reports), anonymised.
// Either way the recording files are deleted from storage first, and the
// events sent about those calls leave the outbox.
import CallErasureRepository from '../../persistence/CallErasureRepository.js';
import { storageClient } from '../../infra/storage/StorageClient.js';
import { CallStatus } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.calls.CallErasure');

const ENDED = new Set([CallStatus.TERMINATED, CallStatus.FAILED]);
// A recording in these states may still be written or uploaded.
const UNSETTLED = new Set(['recording', 'processing']);
const BATCH = 100;

export class ErasureError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;   // call_active | recording_in_progress | storage_unavailable
    }
}

class CallErasure {
    // Deletes recording files; throws before touching anything if one can't go.
    async #deleteRecordingFiles(recordings) {
        if (recordings.some((r) => UNSETTLED.has(r.status))) {
            throw new ErasureError('recording_in_progress', 'A recording is still being saved — try again in a minute');
        }
        const files = recordings.filter((r) => r.storage_key && r.storage_provider === 's3');
        if (files.length && !storageClient.isInitialized) {
            throw new ErasureError('storage_unavailable', 'Object storage is not configured, so the recording can\'t be deleted');
        }
        for (const rec of files) {
            if (!(await storageClient.deleteFile(rec.storage_key))) {
                throw new ErasureError('storage_unavailable', 'Deleting the recording from storage failed — try again');
            }
        }
    }

    // Returns false when the call doesn't exist in the tenant.
    async deleteCall(tenantId, callId) {
        const call = await CallErasureRepository.findCall(tenantId, callId);
        if (!call) return false;
        if (!ENDED.has(call.status)) throw new ErasureError('call_active', 'The call has not ended');

        await this.#deleteRecordingFiles(await CallErasureRepository.recordingsOf([callId]));
        await CallErasureRepository.deleteDeliveries([callId]);
        await CallErasureRepository.deleteEndedCall(tenantId, callId);
        log.info({ callId, tenantId }, 'Call deleted on request');
        return true;
    }

    async eraseCustomer(tenantId, address) {
        let callsErased = 0;
        let recordingsDeleted = 0;
        for (;;) {
            const callIds = await CallErasureRepository.endedCallsOfCustomer(tenantId, address, BATCH);
            if (!callIds.length) break;
            const recordings = await CallErasureRepository.recordingsOf(callIds);
            await this.#deleteRecordingFiles(recordings);
            recordingsDeleted += await CallErasureRepository.deleteRecordingRows(recordings.map((r) => r.id));
            await CallErasureRepository.deleteDeliveries(callIds);
            const erased = await CallErasureRepository.anonymise(tenantId, callIds);
            callsErased += erased;
            if (!erased) break;   // nothing changed: don't loop on the same batch
        }
        const activeCallsSkipped = await CallErasureRepository.countActiveCallsOfCustomer(tenantId, address);
        log.info({ tenantId, callsErased, recordingsDeleted, activeCallsSkipped }, 'Customer data erased on request');
        return { callsErased, recordingsDeleted, activeCallsSkipped };
    }
}

export const callErasure = new CallErasure();
