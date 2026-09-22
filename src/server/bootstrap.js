// Service initialization sequences run at startup.
// initRedis()           — required services; throws on failure, aborting startup.
// initOptionalServices() — degradable services (storage, worker threads); warns on
//                          failure and continues. Add new optional services here.
import { redisBaseService } from '../services/redis/RedisBaseService.js';
import { redisPubSubService } from '../services/redis/RedisPubSubService.js';
import { presenceService } from '../services/redis/PresenceService.js';
import { redisCleanupService } from '../services/redis/RedisCleanupService.js';
import { storageClient } from '../services/storage/StorageClient.js';
import { encodingWorkerBridge } from '../services/call/audio/recording/encoding/EncodingWorkerBridge.js';
import { dtmfWorkerBridge } from '../services/call/audio/dtmf/DTMFWorkerBridge.js';
import RecordingRepository from '../repositories/RecordingRepository.js';

function logOptional(label, result, disabledFeature) {
    if (result.status === 'fulfilled')
        console.log(`✅ ${label} initialized`);
    else
        console.warn(`⚠️ ${label} failed — ${disabledFeature} disabled: ${result.reason.message}`);
}

// Base Redis client first — presenceService and redisCleanupService call
// redisBaseService.init() internally, but that call is idempotent (early-return
// if already initialized), so all three can proceed in parallel after base is up.
export async function initRedis() {
    await redisBaseService.init();
    await Promise.all([
        redisPubSubService.init(),
        presenceService.init(),
        redisCleanupService.init(),
    ]);
    console.log("✅ Redis services initialized");
}

// storageClient (S3) and worker bridges (worker_threads) have no dependency on
// Redis or on each other — run together. All are optional: failure warns but
// does not abort startup.
export async function initOptionalServices() {
    const [storageResult, encodingResult, dtmfResult, staleResult] = await Promise.allSettled([
        storageClient.init(),
        encodingWorkerBridge.init(),
        dtmfWorkerBridge.init(),
        RecordingRepository.markStaleRecordingsFailed(),
    ]);

    logOptional('Storage service',  storageResult,  'recording');
    logOptional('Encoding worker',  encodingResult, 'recording');
    logOptional('DTMF worker',      dtmfResult,     'IVR digit detection');

    if (staleResult.status === 'rejected')
        console.warn("⚠️ Stale recording cleanup failed:", staleResult.reason.message);
}
