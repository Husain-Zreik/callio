// Graceful shutdown sequence — invoked on SIGINT / SIGTERM.
// Steps are strictly ordered (Socket.IO → recordings → worker threads → peers
// → DB updates → S3 drain → Redis teardown). Do not reorder: each step depends
// on the previous one having completed. Adding a new step: read the ordering
// contract in the numbered comments below before choosing where to insert it.
import { redisClient } from '../services/redis/RedisClient.js';
import { redisPubSubService } from '../services/redis/RedisPubSubService.js';
import { redisCleanupService } from '../services/redis/RedisCleanupService.js';
import { storageClient } from '../services/storage/StorageClient.js';
import { streamUploader } from '../services/storage/StreamUploader.js';
import { recordingManager } from '../services/call/audio/recording/RecordingManager.js';
import { encodingWorkerBridge } from '../services/call/audio/recording/encoding/EncodingWorkerBridge.js';
import { dtmfWorkerBridge } from '../services/call/audio/dtmf/DTMFWorkerBridge.js';
import { peerRegistry } from '../services/call/signaling/webrtc/PeerRegistry.js';
import { workerStatsService } from '../services/monitoring/WorkerStatsService.js';
import { terminateWhatsAppCall } from '../services/call/signaling/webrtc/WhatsAppCallApi.js';
import { callLifecycleLogger } from '../services/call/lifecycle/CallLifecycleLogger.js';
import { ivrCoordinator } from '../services/call/ivr/IvrCoordinator.js';
import CallRepository from '../repositories/CallRepository.js';

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
    console.log("🛑 Shutting down server...");
    isShuttingDown = true;

    try {
        // 1. Close Socket.IO — stops new events from triggering peer or Redis ops.
        //    Brief settle wait lets async disconnect handlers (presence cleanup) drain.
        if (io) {
            await new Promise((resolve) => io.close(resolve));
            await new Promise((resolve) => setTimeout(resolve, 800));
            console.log("✅ Socket.IO closed");
        }

        // 2. Stop all active recordings — flushes the Opus encoder, finalizes the
        //    OGG stream, and calls uploadStream.end() on each PassThrough.
        //    This MUST happen before streamUploader.cleanup() so the streams are
        //    properly ended (not just destroyed) before we wait for S3 to confirm.
        console.log("🎙️ Stopping active recordings...");
        await recordingManager.cleanup();

        // 2a. Terminate both worker bridges in parallel — safe because every active
        //     session's stop() has already awaited the encoding worker's 'stopped'
        //     ACK in the step above, and DTMF has no pending state at this point.
        const _workersT0 = Date.now();
        await Promise.all([
            encodingWorkerBridge.terminate(),
            dtmfWorkerBridge.terminate(),
        ]);
        console.log(`✅ Worker threads terminated (${Date.now() - _workersT0}ms)`);

        // 3. Close all WebRTC peer connections — this terminates any active media
        //    bridges and releases native wrtc resources. Calls whose recording was
        //    just stopped will have their S3 uploads still in flight; they complete
        //    in step 5 below.
        const activeCalls = [...peerRegistry.peerConnections.keys()];
        if (activeCalls.length > 0) {
            console.log(`📡 Closing ${activeCalls.length} peer connection(s)...`);
            await Promise.allSettled(activeCalls.map((callId) =>
                peerRegistry.closePeerConnection(callId).catch((err) =>
                    console.warn(`[Shutdown] closePeerConnection failed for call ${callId}:`, err.message)
                )
            ));

            // Fetch call records to categorise active calls before terminating them.
            const callRecords = await CallRepository.findByIds(activeCalls).catch(() => []);
            const inProgressCalls = callRecords.filter(c => c.status === 'IN_PROGRESS');
            // IVR calls: RINGING with an ivr_menu_id — they hold a live WHATSAPP audio
            // connection and must be explicitly terminated with Meta, same as IN_PROGRESS.
            const ivrCalls = callRecords.filter(
                c => c.ivr_menu_id != null && c.status !== 'TERMINATED' && c.status !== 'FAILED'
            );

            // DB updates run FIRST — these are instant (~10ms) and must complete before
            // SIGKILL. terminateWhatsAppCall is a 400-600ms HTTP call that runs after,
            // as best-effort. If PM2 kill_timeout hits during the API call the DB is
            // already correct and the customer won't see a stuck IN_PROGRESS record.
            await CallRepository.batchTerminateCalls(
                activeCalls,
                'SERVICE_MAINTENANCE',
                'SYSTEM'
            ).catch(err =>
                console.warn('[Shutdown] batchTerminateCalls failed:', err.message)
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
                                .catch(err => console.warn(`[Shutdown] call_duration failed for call ${c.id}:`, err.message))
                            : null,
                        ringingDuration !== null
                            ? CallRepository.updateDuration(c.id, 'ringing_duration', ringingDuration)
                                .catch(err => console.warn(`[Shutdown] ringing_duration failed for call ${c.id}:`, err.message))
                            : null,
                    ].filter(Boolean);
                }));
            }

            // Stop IVR sessions cleanly — closes engine timers, DTMF capture, and the
            // IVR DB session record. The WHATSAPP peer is already closed above via
            // closePeerConnection; stopSession handles the remaining IVR resources safely.
            if (ivrCalls.length > 0) {
                await Promise.allSettled(ivrCalls.map(c =>
                    ivrCoordinator.stopSession(c.id, 'hung_up')
                        .catch(err => console.warn(`[Shutdown] ivrCoordinator.stopSession failed for call ${c.id}:`, err.message))
                ));
            }

            // Log service_maintenance lifecycle entry + tell Meta for all calls that
            // had an active WhatsApp audio connection (answered calls + IVR sessions).
            const callsNeedingTermination = [...inProgressCalls, ...ivrCalls];
            if (callsNeedingTermination.length > 0) {
                await Promise.allSettled(callsNeedingTermination.map(c =>
                    callLifecycleLogger.logTerminated(c.id, c.business_id, c.user_id ?? null, {
                        reason: 'service_maintenance',
                        message: 'Call ended due to service maintenance',
                    }).catch(err =>
                        console.warn(`[Shutdown] lifecycle log failed for call ${c.id}:`, err.message)
                    )
                ));

                // Tell Meta to end each connected call so the customer is not left hanging.
                // Best-effort: if SIGKILL arrives mid-flight the DB is already updated above.
                console.log(`[Shutdown] Gracefully terminating ${callsNeedingTermination.length} active call(s)...`);
                await Promise.allSettled(callsNeedingTermination.map(c =>
                    terminateWhatsAppCall(c.id).catch(err =>
                        console.warn(`[Shutdown] terminateWhatsAppCall failed for call ${c.id}:`, err.message)
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
        console.log("📦 Waiting for storage uploads to complete...");
        await streamUploader.cleanup(45_000);

        // 6. Stop background cleanup job
        await redisCleanupService.stop();

        // 7. Close Redis service connections (in reverse order)
        console.log("📦 Closing Redis services...");
        await redisCleanupService.releaseLock();
        await redisPubSubService.close();

        // 8. Close all Redis clients
        await redisClient.closeAll();

        // 9. Close storage client
        await storageClient.close();

        console.log("✅ All services closed");
    } catch (err) {
        console.error("[Shutdown] Error:", err.message);
    }

    server.close(() => {
        console.log("✅ Server closed");
        process.exit(0);
    });

    // Hard kill after 60 s — long enough for S3 multipart finalization on slow links.
    setTimeout(() => {
        console.warn("⏱️ Force exit after timeout");
        process.exit(1);
    }, 60_000);
}
