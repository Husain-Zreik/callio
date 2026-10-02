// Graceful shutdown sequence — invoked on SIGINT / SIGTERM.
// Steps are strictly ordered (Socket.IO → call media → DB updates → recording
// uploads → Redis teardown). Do not reorder: each step depends
// on the previous one having completed. Adding a new step: read the ordering
// contract in the numbered comments below before choosing where to insert it.
import { redisClient } from '../infra/redis/RedisClient.js';
import { redisPubSubService } from '../infra/redis/RedisPubSubService.js';
import { callInbox } from '../infra/cluster/CallInbox.js';
import { deadlines } from '../infra/cluster/Deadlines.js';
import { callAdoption } from '../core/calls/CallAdoption.js';
import { redisCleanupService } from '../infra/cluster/RedisCleanupService.js';
import { storageClient } from '../infra/storage/StorageClient.js';
import { drachtio } from '../infra/sip/Drachtio.js';
import { callMedia } from '../core/media/CallMedia.js';
import { workerStatsService } from '../infra/monitoring/WorkerStatsService.js';
import { customerChannels } from '../core/channels/CustomerChannels.js';
import { ivrCoordinator } from '../core/ivr/IvrCoordinator.js';
import dbPool from '../../config/dbConnection.js';
import { outboxDispatcher } from '../outbox/OutboxDispatcher.js';
import { queueTimeoutService } from '../core/routing/QueueTimeoutService.js';
import { callCleanupService } from '../core/calls/CallCleanupService.js';
import { retentionService } from '../core/calls/RetentionService.js';
import { logger } from '../infra/logging/logger.js';

const log = logger('server.shutdown');

// Checked by the WhatsApp webhook route (channels/whatsapp/webhookRoutes.js),
// which answers 503 instead of taking a new incoming-call webhook.
// Live ES module binding — importers see updates made to this value below, not a
// stale copy taken at import time.
//
// server.close() (which stops the HTTP server from accepting new requests) only
// runs at the very end of this function, after the calls' media is closed and
// activeCalls/ivrCalls are already snapshotted for termination (step 3 below). Until
// then the webhook endpoint stays open, so Meta can deliver a brand-new incoming-call
// webhook at any point during this whole sequence. A call created from one of those
// arrives after the snapshot, never gets included in batchTerminateCalls, and is
// abandoned mid-flight when the process exits. Setting this immediately, before any
// other step, closes that window.
export let isShuttingDown = false;

export async function shutdown(server, io) {
    // SIGINT followed by SIGTERM (or PM2 sending both) must not run the
    // sequence twice — the second run would re-terminate calls and close
    // already-closed clients.
    if (isShuttingDown) return;
    log.info('Shutting down server...');
    isShuttingDown = true;

    // Hard kill after 60 s — long enough for S3 multipart finalization on slow
    // links. Armed first, so a step that hangs can't keep the worker alive.
    // PM2's kill_timeout (WORKER_KILL_TIMEOUT) must be above this.
    setTimeout(() => {
        log.warn('Force exit after timeout');
        process.exit(1);
    }, 60_000);

    // 0. Stop the stuck-call / orphan-media sweep — it would race step 3's media
    //    closing and batch terminate, and could tick after Redis or the DB pool
    //    are closed.
    callCleanupService.stop();

    try {
        // 1. Close Socket.IO — stops new events from triggering media or Redis ops.
        //    Brief settle wait lets async disconnect handlers (presence cleanup) drain.
        if (io) {
            await new Promise((resolve) => io.close(resolve));
            await new Promise((resolve) => setTimeout(resolve, 800));
            log.info('Socket.IO closed');
        }

        // 2–3. Hand the calls held here over instead of ending them: their media
        //    keeps going on the media plane, their state is in Redis, and giving
        //    up their leases lets another worker take each over at once
        //    (core/calls/CallAdoption) — or the workers that start next, when
        //    they all restart. Only a SIP call still ringing ends (its pending
        //    INVITE can't move; the SIP channel's stop in step 6).
        const handedOver = callMedia.handOver();
        ivrCoordinator.suspendAll();
        await callInbox.handOver().catch((err) => log.warn({ err }, 'Giving up the call leases failed'));
        if (handedOver) log.info(`Handed ${handedOver} call(s) over to the other workers`);

        // 4. Stop metrics logging
        workerStatsService.logSnapshot('graceful_shutdown');
        workerStatsService.stop();

        // 5. Recording uploads (max 45 s): the media server uploads each call
        //    that ended here; this waits for them to land and completes the rows.
        //    (A handed-over call's recording keeps running.) Then the media plane
        //    disconnects.
        log.info('Waiting for recording uploads to complete...');
        await callMedia.stop().catch((err) => log.warn({ err }, 'Stopping the media plane failed'));

        // 6. Stop background jobs (Redis reaper, outbox dispatcher lease)
        await redisCleanupService.stop();
        queueTimeoutService.stop();
        deadlines.stop();
        callAdoption.stop();
        retentionService.stop();
        await outboxDispatcher.stop();
        for (const channel of customerChannels.all()) {
            await Promise.resolve(channel.stop?.()).catch((err) => log.warn({ err }, `${channel.type} channel stop failed`));
        }
        drachtio.stop();

        // 7. Close Redis service connections (in reverse order)
        log.info('Closing Redis services...');
        await redisCleanupService.releaseLock();
        await callInbox.close();
        await redisPubSubService.close();

        // 8. Close all Redis clients
        await redisClient.closeAll();

        // 9. Close storage client
        await storageClient.close();

        // 10. Close the MySQL pool — last, since every step above may still write.
        await dbPool.end().catch((err) => log.warn({ err }, 'DB pool close failed'));

        log.info('All services closed');
    } catch (err) {
        log.error({ err }, 'Shutdown error');
    }

    server.close(() => {
        log.info('Server closed');
        process.exit(0);
    });
}
