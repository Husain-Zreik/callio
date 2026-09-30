// src/core/calls/RetentionService.js
// How long call data is kept (config.retention, docs/data-model.md#retention):
//   call detail     lifecycle events, legs, transfers, IVR sessions of calls that
//                   ended more than CALL_DETAIL_RETENTION_DAYS ago (180). The calls
//                   row itself — the call record — is kept.
//   SDP / ICE       the session descriptions and candidates on call legs, cleared
//                   CALL_SDP_RETENTION_HOURS (24) after the call ended.
//   deliveries      delivered or given-up webhook deliveries older than
//                   WEBHOOK_DELIVERY_RETENTION_DAYS (30); pending ones never.
//   recordings      RECORDING_RETENTION_DAYS (0 = keep), or the tenant's
//                   settings.recording.retention_days: the object is deleted from
//                   storage and the row marked purged.
// Runs on every worker; one sweep per RETENTION_SWEEP_SECONDS across the fleet
// (a Redis key with that TTL is claimed by whichever worker gets there first).
// Each part deletes in bounded batches and stops after a time budget, so a
// large backlog is worked off over several sweeps.
import RetentionRepository from '../../persistence/RetentionRepository.js';
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { storageClient } from '../../infra/storage/StorageClient.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.calls.RetentionService');

const CHECK_MS = 60_000;
const RAN_KEY = 'callio:retention:swept';
const BATCH = 1000;
const BUDGET_MS = 60_000;
const DAY_MS = 86_400_000;

class RetentionService {
    constructor() {
        this._timer = null;
        this._running = false;
    }

    start() {
        if (this._timer) return;
        const every = Math.min(CHECK_MS, config.retention.sweepSeconds * 1000);
        this._timer = setInterval(() => this.tick(), every);
        this._timer.unref();
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    async tick() {
        if (this._running) return;
        this._running = true;
        try {
            const claimed = await redisBaseService.setnx(RAN_KEY, `${config.runtime.workerId}:${Date.now()}`, config.retention.sweepSeconds);
            if (claimed) await this.sweep();
        } catch (err) {
            log.error({ err }, 'Retention sweep failed');
        } finally {
            this._running = false;
        }
    }

    async sweep() {
        const r = config.retention;
        const deadline = Date.now() + BUDGET_MS;
        const ago = (ms) => new Date(Date.now() - ms);
        const counts = {   // a part set to 0 keeps its data
            sdpCleared: r.sdpHours ? await this.#loop(deadline, () => RetentionRepository.scrubConnectionSdp(ago(r.sdpHours * 3_600_000), BATCH)) : 0,
            detailRows: r.callDetailDays ? await this.#callDetail(deadline, ago(r.callDetailDays * DAY_MS)) : 0,
            deliveries: r.webhookDeliveryDays ? await this.#loop(deadline, () => RetentionRepository.deleteFinishedDeliveries(ago(r.webhookDeliveryDays * DAY_MS), BATCH)) : 0,
            recordings: await this.#purgeRecordings(deadline),
        };
        if (Object.values(counts).some((n) => n > 0)) log.info(counts, 'Retention sweep');
        else log.debug('Retention sweep: nothing to remove');
        return counts;
    }

    // Timeline, legs, transfers, IVR sessions (their inputs cascade).
    async #callDetail(deadline, cutoff) {
        let total = 0;
        for (const table of ['call_lifecycle_events', 'call_connections', 'call_transfer_logs', 'ivr_sessions']) {
            total += await this.#loop(deadline, () => RetentionRepository.deleteCallDetail(table, cutoff, 200));
        }
        return total;
    }

    // Repeat a bounded step until it has nothing left or the budget runs out.
    async #loop(deadline, step) {
        let total = 0;
        while (Date.now() < deadline) {
            const n = await step();
            total += n;
            if (!n) break;
        }
        return total;
    }

    async #purgeRecordings(deadline) {
        let purged = 0;
        for (const tenant of await RetentionRepository.tenantsWithSettings()) {
            const own = Number(tenant.settings?.recording?.retention_days);
            const days = Number.isFinite(own) && own >= 0 ? own : config.retention.recordingDays;
            if (!days) continue;   // 0: keep
            const cutoff = new Date(Date.now() - days * DAY_MS);
            while (Date.now() < deadline) {
                const batch = await RetentionRepository.expiredRecordings(tenant.id, cutoff, 100);
                let progress = 0;
                for (const rec of batch) {
                    // The row is only marked purged once its object is gone (or it has none here).
                    if (rec.storage_key && rec.storage_provider === 's3') {
                        if (!storageClient.isInitialized) {
                            log.warn({ tenantId: tenant.id }, 'Recordings due for removal, but object storage is not configured');
                            return purged;
                        }
                        // deleteFile logs its own failure; the row waits for the next sweep.
                        if (!(await storageClient.deleteFile(rec.storage_key))) continue;
                    }
                    await RetentionRepository.markRecordingPurged(rec.id);
                    purged++; progress++;
                }
                if (!progress) break;   // nothing removable left in this tenant (or storage failing)
            }
        }
        return purged;
    }
}

export const retentionService = new RetentionService();
