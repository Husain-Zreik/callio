// Service initialization sequences run at startup.
// initRedis()           — required services; throws on failure, aborting startup.
// initOptionalServices() — degradable services (object storage); warns on
//                          failure and continues. Add new optional services here.
import { redisBaseService } from '../infra/redis/RedisBaseService.js';
import { redisPubSubService } from '../infra/redis/RedisPubSubService.js';
import { callInbox } from '../infra/cluster/CallInbox.js';
import { deadlines } from '../infra/cluster/Deadlines.js';
import { callAdoption } from '../core/calls/CallAdoption.js';
import { presenceService } from '../core/agents/PresenceService.js';
import { redisCleanupService } from '../infra/cluster/RedisCleanupService.js';
import { storageClient } from '../infra/storage/StorageClient.js';
import { drachtio } from '../infra/sip/Drachtio.js';
import { callMedia } from '../core/media/CallMedia.js';
import { mediaRouter } from '../media/MediaRouter.js';
import { callNotifications } from '../core/calls/CallNotifications.js';
import { callPushNotifier } from '../push/CallPushNotifier.js';
import { customerNetworkLossPolicy } from '../core/calls/CustomerNetworkLossPolicy.js';
import { retentionService } from '../core/calls/RetentionService.js';
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
        callInbox.init(),
        presenceService.init(),
        redisCleanupService.init(),
    ]);
    log.info('Redis services initialized');
    // Runtime log-level overrides (npm run log-level); logging works without them.
    await logLevelControl.start().catch((err) => log.warn({ err }, 'Log-level control unavailable'));
}

// Object storage is optional: failure warns but does not abort startup.
export async function initOptionalServices() {
    const [storageResult] = await Promise.allSettled([storageClient.init()]);
    logOptional('Storage service', storageResult, 'recording');
}

// Core listeners and background loops — after Redis and the socket server
// exist, before the HTTP listener opens. Each registers once per worker.
export async function startCoreServices() {
    // The core's ports to push (the socket port is registered with the socket server).
    callNotifications.register(callPushNotifier);
    consumerEventPublisher.register();
    customerNetworkLossPolicy.register();
    ivrTerminationHandler.register();

    await presenceService.clearOwnStalePresence();
    redisCleanupService.start();
    callCleanupService.start();
    queueTimeoutService.start();
    deadlines.start();
    retentionService.start();
    outboxDispatcher.start();

    // The media plane: drachtio (also the SIP channel's signalling), then the
    // rooms on FreeSWITCH. A media server that isn't up yet doesn't stop the
    // worker: the first call reconnects.
    drachtio.start();
    callMedia.register(mediaRouter);
    await callMedia.start().catch((err) => log.error({ err }, 'Media plane not ready — calls fail until it connects'));
    // Takes over calls whose worker stopped (needs the media plane to drive them).
    callAdoption.start();

    // Channels that hold a connection to their provider (SIP's drachtio) take
    // calls from here on.
    for (const channel of customerChannels.all()) await channel.start?.();
}
