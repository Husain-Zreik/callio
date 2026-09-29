// Graceful shutdown sequence — invoked on SIGINT / SIGTERM.
// Steps are strictly ordered (Socket.IO → recordings → worker threads → peers
// → DB updates → S3 drain → Redis teardown). Do not reorder: each step depends
// on the previous one having completed. Adding a new step: read the ordering
// contract in the numbered comments below before choosing where to insert it.
import { redisClient } from '../infra/redis/RedisClient.js';
import { redisPubSubService } from '../infra/redis/RedisPubSubService.js';
import { redisCleanupService } from '../infra/cluster/RedisCleanupService.js';
import { storageClient } from '../infra/storage/StorageClient.js';
import { streamUploader } from '../infra/storage/StreamUploader.js';
import { recordingManager } from '../media/recording/RecordingManager.js';
import { encodingWorkerBridge } from '../media/recording/encoding/EncodingWorkerBridge.js';
import { dtmfWorkerBridge } from '../media/dtmf/DTMFWorkerBridge.js';
import { peerRegistry } from '../media/webrtc/PeerRegistry.js';
import { workerStatsService } from '../infra/monitoring/WorkerStatsService.js';
import { customerChannels } from '../core/channels/CustomerChannels.js';
import { callLifecycleLogger } from '../core/calls/CallLifecycleLogger.js';
import { ivrCoordinator } from '../core/ivr/IvrCoordinator.js';
import CallRepository from '../persistence/CallRepository.js';
import dbPool from '../../config/dbConnection.js';
import { outboxDispatcher } from '../outbox/OutboxDispatcher.js';
import { queueTimeoutService } from '../core/routing/QueueTimeoutService.js';
import { logger } from '../infra/logging/logger.js';

const log = logger('server.shutdown');

// Checked by callWebhookController before processing a new incoming-call webhook.
// Live ES module binding — importers see updates made to this value below, not a
// stale copy taken at import time.
//
// server.close() (which stops the HTTP server from accepting new requests) only
// runs at the very end of this function, after peer connections are closed and
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

    try {
        // 1. Close Socket.IO — stops new events from triggering peer or Redis ops.
        //    Brief settle wait lets async disconnect handlers (presence cleanup) drain.
        if (io) {
            await new Promise((resolve) => io.close(resolve));
            await new Promise((resolve) => setTimeout(resolve, 800));
            log.info('Socket.IO closed');
        }

        // 2. Stop all active recordings — flushes the Opus encoder, finalizes the
        //    OGG stream, and calls uploadStream.end() on each PassThrough.
        //    This MUST happen before streamUploader.cleanup() so the streams are
        //    properly ended (not just destroyed) before we wait for S3 to confirm.
        log.info('Stopping active recordings...');
        await recordingManager.cleanup();

        // 2a. Terminate both worker bridges in parallel — safe because every active
        //     session's stop() has already awaited the encoding worker's 'stopped'
        //     ACK in the step above, and DTMF has no pending state at this point.
        const _workersT0 = Date.now();
        await Promise.all([
            encodingWorkerBridge.terminate(),
            dtmfWorkerBridge.terminate(),
        ]);
        log.info(`Worker threads terminated (${Date.now() - _workersT0}ms)`);

        // 3. Close all WebRTC peer connections — this terminates any active media
        //    bridges and releases native wrtc resources. Calls whose recording was
        //    just stopped will have their S3 uploads still in flight; they complete
        //    in step 5 below.
        const activeCalls = [...peerRegistry.peerConnections.keys()];
        if (activeCalls.length > 0) {
            log.info(`Closing ${activeCalls.length} peer connection(s)...`);
            await Promise.allSettled(activeCalls.map((callId) =>
                peerRegistry.closePeerConnection(callId).catch((err) =>
                    log.warn({ callId, err }, 'closePeerConnection failed')
                )
            ));

            // Fetch call records to categorise active calls before terminating them.
            const callRecords = await CallRepository.findByIds(activeCalls).catch(() => []);
            const inProgressCalls = callRecords.filter(c => c.status === 'IN_PROGRESS');
            // IVR calls: RINGING with an ivr_flow_id — they hold a live CUSTOMER audio
            // connection and must be explicitly terminated with Meta, same as IN_PROGRESS.
            const ivrCalls = callRecords.filter(
                c => c.ivr_flow_id != null && c.status !== 'TERMINATED' && c.status !== 'FAILED'
            );

            // DB updates run FIRST — these are instant (~10ms) and must complete before
            // SIGKILL. customerChannels.terminate is a 400-600ms HTTP call that runs after,
            // as best-effort. If PM2 kill_timeout hits during the API call the DB is
            // already correct and the customer won't see a stuck IN_PROGRESS record.
            await CallRepository.batchTerminateCalls(
                activeCalls,
                'SERVICE_MAINTENANCE',
                'SYSTEM'
            ).catch(err =>
                log.warn({ err }, 'batchTerminateCalls failed')
            );

            // Compute call/ringing durations for answered calls — finalizeFromWebhook
            // won't run because Redis subscriptions are torn down before Meta's webhook
            // arrives. If the webhook does arrive later, finalizeFromWebhook Phase 1
            // (no status guard) overwrites with Meta's authoritative values via COALESCE.
            if (inProgressCalls.length > 0) {
                const shutdownTime = new Date();
                await Promise.allSettled(inProgressCalls.flatMap(c => {
                    const answeredAt = c.answered_at ? new Date(c.answered_at) : null;
                    const ringingAt = c.ringing_at ? new Date(c.ringing_at) : null;
                    const callDuration = answeredAt ? Math.round((shutdownTime - answeredAt) / 1000) : null;
                    const ringingDuration = (ringingAt && answeredAt) ? Math.round((answeredAt - ringingAt) / 1000) : null;
                    return [
                        callDuration !== null
                            ? CallRepository.updateDuration(c.id, 'call_duration', callDuration)
                                .catch(err => log.warn({ callId: c.id, err }, 'Setting call_duration failed'))
                            : null,
                        ringingDuration !== null
                            ? CallRepository.updateDuration(c.id, 'ringing_duration', ringingDuration)
                                .catch(err => log.warn({ callId: c.id, err }, 'Setting ringing_duration failed'))
                            : null,
                    ].filter(Boolean);
                }));
            }

            // Stop IVR sessions cleanly — closes engine timers, DTMF capture, and the
            // IVR DB session record. The CUSTOMER peer is already closed above via
            // closePeerConnection; stopSession handles the remaining IVR resources safely.
            if (ivrCalls.length > 0) {
                await Promise.allSettled(ivrCalls.map(c =>
                    ivrCoordinator.stopSession(c.id, 'hung_up')
                        .catch(err => log.warn({ callId: c.id, err }, 'Stopping the IVR session failed'))
                ));
            }

            // Log service_maintenance lifecycle entry + tell Meta for all calls that
            // had an active WhatsApp audio connection (answered calls + IVR sessions).
            const callsNeedingTermination = [...inProgressCalls, ...ivrCalls];
            if (callsNeedingTermination.length > 0) {
                await Promise.allSettled(callsNeedingTermination.map(c =>
                    callLifecycleLogger.logTerminated(c.id, c.tenant_id, c.agent_id ?? null, {
                        reason: 'service_maintenance',
                        message: 'Call ended due to service maintenance',
                    }).catch(err =>
                        log.warn({ callId: c.id, err }, 'Lifecycle log failed')
                    )
                ));

                // Tell the provider to end each connected call so the customer is not left hanging.
                // Best-effort: if SIGKILL arrives mid-flight the DB is already updated above.
                log.info(`Gracefully terminating ${callsNeedingTermination.length} active call(s)...`);
                await Promise.allSettled(callsNeedingTermination.map(c =>
                    customerChannels.terminate(c.id).catch(err =>
                        log.warn({ callId: c.id, err }, 'Provider terminate failed')
                    )
                ));
            }
        }

        // 4. Stop metrics logging
        workerStatsService.logSnapshot('graceful_shutdown');
        workerStatsService.stop();

        // 5. Wait for S3 uploads to complete (max 45 s). Recordings stopped in step 2
        //    have their streams ended; this gives S3 time to finalize the multipart
        //    upload and write recording_url + status = 'completed' to the DB.
        log.info('Waiting for storage uploads to complete...');
        await streamUploader.cleanup(45_000);

        // 6. Stop background jobs (Redis reaper, outbox dispatcher lease)
        await redisCleanupService.stop();
        queueTimeoutService.stop();
        await outboxDispatcher.stop();
        for (const channel of customerChannels.all()) {
            await Promise.resolve(channel.stop?.()).catch((err) => log.warn({ err }, `${channel.type} channel stop failed`));
        }

        // 7. Close Redis service connections (in reverse order)
        log.info('Closing Redis services...');
        await redisCleanupService.releaseLock();
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

    // Hard kill after 60 s — long enough for S3 multipart finalization on slow links.
    setTimeout(() => {
        log.warn('Force exit after timeout');
        process.exit(1);
    }, 60_000);
}
