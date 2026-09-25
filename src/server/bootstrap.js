// Service initialization sequences run at startup.
// initRedis()           — required services; throws on failure, aborting startup.
// initOptionalServices() — degradable services (storage, worker threads); warns on
//                          failure and continues. Add new optional services here.
import { redisBaseService } from '../infra/redis/RedisBaseService.js';
import { redisPubSubService } from '../infra/redis/RedisPubSubService.js';
import { presenceService } from '../core/agents/PresenceService.js';
import { redisCleanupService } from '../infra/cluster/RedisCleanupService.js';
import { storageClient } from '../infra/storage/StorageClient.js';
import { encodingWorkerBridge } from '../media/recording/encoding/EncodingWorkerBridge.js';
import { dtmfWorkerBridge } from '../media/dtmf/DTMFWorkerBridge.js';
import { callCleanupService } from '../core/calls/CallCleanupService.js';
import { consumerEventPublisher } from '../core/events/ConsumerEventPublisher.js';
import { ivrTerminationHandler } from '../core/ivr/IvrTerminationHandler.js';
import { outboxDispatcher } from '../outbox/OutboxDispatcher.js';

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
    const [storageResult, encodingResult, dtmfResult] = await Promise.allSettled([
        storageClient.init(),
        encodingWorkerBridge.init(),
        dtmfWorkerBridge.init(),
    ]);

    logOptional('Storage service',  storageResult,  'recording');
    logOptional('Encoding worker',  encodingResult, 'recording');
    logOptional('DTMF worker',      dtmfResult,     'IVR digit detection');
}

// Core listeners and background loops — after Redis and the socket server
// exist, before the HTTP listener opens. Each registers once per worker.
export async function startCoreServices() {
    consumerEventPublisher.register();
    ivrTerminationHandler.register();

    await presenceService.clearOwnStalePresence();
    redisCleanupService.start();
    callCleanupService.start();
    outboxDispatcher.start();
}
