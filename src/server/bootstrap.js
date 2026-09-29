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
import { queueTimeoutService } from '../core/routing/QueueTimeoutService.js';
import { customerChannels } from '../core/channels/CustomerChannels.js';
import { logger } from '../infra/logging/logger.js';
import { logLevelControl } from '../infra/logging/LogLevelControl.js';

const log = logger('server.bootstrap');

function logOptional(label, result, disabledFeature) {
    if (result.status === 'fulfilled')
        log.info(`${label} initialized`);
    else
        log.warn({ err: result.reason }, `${label} failed — ${disabledFeature} disabled`);
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
    log.info('Redis services initialized');
    // Runtime log-level overrides (npm run log-level); logging works without them.
    await logLevelControl.start().catch((err) => log.warn({ err }, 'Log-level control unavailable'));
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
    queueTimeoutService.start();
    outboxDispatcher.start();

    // Channels that hold a connection to their provider (SIP's drachtio) take
    // calls from here on.
    for (const channel of customerChannels.all()) await channel.start?.();
}
