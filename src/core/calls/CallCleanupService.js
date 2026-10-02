// src/core/calls/CallCleanupService.js
// Owns stuck-call detection, cleanup queue processing, and periodic scan.
import CallRepository from '../../persistence/CallRepository.js';
import RecordingRepository from '../../persistence/RecordingRepository.js';
import EventBus from '../EventBus.js';
import { callMedia } from '../media/CallMedia.js';
import { mediaLegs } from '../media/MediaLegs.js';
import { CallStatus, TerminationReason, TerminatedBy } from '../constants/CallConstants.js';
import { callLifecycleLogger } from './CallLifecycleLogger.js';
import { callTerminator } from './CallTerminator.js';
import { autoOfflinePolicy } from '../routing/AutoOfflinePolicy.js';
import { agentAssignmentCoordinator } from '../routing/AgentAssignmentCoordinator.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.calls.CallCleanupService');

const CLEANUP_COOLDOWN = 30_000;
const OUTBOUND_INTENT_TTL_MINUTES = 2;

// Statuses that mean the call is over. A local peer connection still held for a
// call in one of these states is an orphan and must be closed (see reconciler).
const TERMINAL_STATUSES = new Set([
    CallStatus.TERMINATED,
    CallStatus.FAILED,
    CallStatus.CANCELLED,
]);

class CallCleanupService {
    constructor() {
        this.cleanupQueue = new Map();     // callId -> { callId, tenantId, reason }
        this.lastCleanupTime = new Map();  // tenantId -> timestamp
        this._timer = null;
        this._ivrTimer = null;
    }

    start() {
        // 30s poll / 1min cutoff — worst-case latency on a stuck RINGING call
        // is ~90s. Previously 120s/2min (worst case ~4min): far past the ~1min
        // ring lifetime the native call UI and the rest of this flow are meant
        // to match (see push_notification_service.dart's CallKitParams.duration).
        this._timer    = setInterval(() => this._runPeriodicCleanup(), 30_000).unref();
        this._ivrTimer = setInterval(() => this._runIvrRingCleanup(),   30_000).unref();
    }

    stop() {
        clearInterval(this._timer);
        clearInterval(this._ivrTimer);
        this._timer = null;
        this._ivrTimer = null;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    enqueue(callId, tenantId, reason) {
        this.cleanupQueue.set(callId, { callId, tenantId, reason });
    }

    // ── Cleanup queue ─────────────────────────────────────────────────────────

    processCleanupQueue(tenantId) {
        const now = Date.now();
        const lastCleanup = this.lastCleanupTime.get(tenantId) || 0;

        if (now - lastCleanup < CLEANUP_COOLDOWN) return;

        const businessQueue = Array.from(this.cleanupQueue.values())
            .filter(item => item.tenantId === tenantId);

        if (businessQueue.length === 0) return;

        this.lastCleanupTime.set(tenantId, now);
        log.info({ tenantId }, `Processing ${businessQueue.length} queued calls`);

        setImmediate(async () => {
            try {
                await this.batchCleanupCalls(businessQueue);
                businessQueue.forEach(item => this.cleanupQueue.delete(item.callId));
                log.info(`Batch cleanup completed for ${businessQueue.length} calls`);
            } catch (error) {
                log.error({ err: error }, 'Batch cleanup failed');
            }
        });
    }

    // Ends each stuck call through the CallTerminator (which also tells the
    // provider, so the customer stops ringing). Returns the ids actually ended.
    //
    // NO_ANSWER means "was RINGING, timed out unanswered", and is the one
    // reason where the call may have been genuinely accepted between the scan
    // and now (a real bug: an agent's call ended itself moments after they
    // accepted it) — so it only ends a call still RINGING. Other reasons (a
    // stuck IN_PROGRESS call that already has its termination_reason) end
    // unconditionally.
    async batchCleanupCalls(callItems) {
        if (!callItems?.length) return new Set();
        const calls = await CallRepository.findByIds(callItems.map((item) => item.callId));
        const byId = new Map(calls.map((c) => [String(c.id), c]));

        const terminatedIds = new Set();
        for (const item of callItems) {
            const call = byId.get(String(item.callId));
            if (!call) continue;
            const reason = item.reason || TerminationReason.SYSTEM_ERROR;
            const ended = await callTerminator.end(call, {
                reason,
                terminatedBy: TerminatedBy.SYSTEM,
                onlyIfStatus: reason === TerminationReason.NO_ANSWER || reason === TerminationReason.IVR_AGENT_NO_ANSWER
                    ? CallStatus.RINGING
                    : null,
                provider: 'end',
                source: 'cleanup',
            }).catch((err) => {
                log.error({ callId: call.id, err }, 'Ending stuck call failed');
                return false;
            });
            if (ended) terminatedIds.add(call.id);
        }

        const skipped = callItems.length - terminatedIds.size;
        log.info(`Ended ${terminatedIds.size}/${callItems.length} stuck call(s)${skipped > 0 ? ` (${skipped} skipped — already ended or moved on)` : ''}`);
        return terminatedIds;
    }

    // On-demand equivalent of the periodic scan, scoped to one agent — used
    // when an agent's availability is forced through the Management API, so a
    // stale call blocking them is released now instead of on the next 30s tick.
    async releaseStaleCallsForUser(userId) {
        const stuckCalls = await CallRepository.findStuckCallsForUser(userId, 1);
        if (stuckCalls.length === 0) return { releasedCount: 0 };

        log.info({ agentId: userId }, `On-demand stale-call release: ${stuckCalls.length} call(s)`);

        const callItems = stuckCalls.map(call => ({
            callId: call.id,
            tenantId: call.tenant_id,
            reason: call.status === CallStatus.RINGING
                ? TerminationReason.NO_ANSWER
                : (call.termination_reason ?? TerminationReason.COMPLETED),
        }));

        const terminatedIds = await this.batchCleanupCalls(callItems);
        return { releasedCount: terminatedIds?.size ?? 0 };
    }

    // ── Periodic scan ─────────────────────────────────────────────────────────

    async _runPeriodicCleanup() {
        // Reconcile this worker's media legs against the DB first — closes the legs
        // of calls already terminated elsewhere (runs every cycle, even when the DB
        // stuck-call scan below finds nothing).
        await this._reconcileOrphanedLegs();

        await RecordingRepository.markStaleRecordingsFailed().catch((err) =>
            log.error({ err }, 'Stale recording scan failed')
        );

        await this._expireOutboundIntents().catch((err) =>
            log.error({ err }, 'Outbound intent expiry failed')
        );

        await agentAssignmentCoordinator.releaseAgentsOfEndedCalls().catch((err) =>
            log.error({ err }, 'Releasing agents of ended calls failed')
        );

        try {
            const stuckCalls = await CallRepository.findAllStuckCalls(1);
            if (stuckCalls.length === 0) return;

            log.debug(`Periodic scan found ${stuckCalls.length} stuck call(s)`);

            for (const call of stuckCalls) {
                const reason = call.status === 'RINGING' ? 'NO_ANSWER' : (call.termination_reason ?? 'COMPLETED');
                this.enqueue(call.id, call.tenant_id, reason);
            }

            const businesses = [...new Set(stuckCalls.map(c => c.tenant_id))];
            for (const bId of businesses) {
                this.lastCleanupTime.delete(bId); // force drain immediately
                this.processCleanupQueue(bId);
            }
        } catch (err) {
            log.error({ err }, 'Periodic cleanup scan failed');
        }
    }

    // Outbound intents the agent never started (no call:start within
    // OUTBOUND_INTENT_TTL_MINUTES) are cancelled so they don't sit INITIATED forever.
    async _expireOutboundIntents() {
        const expired = await CallRepository.findExpiredOutboundIntents(OUTBOUND_INTENT_TTL_MINUTES);
        for (const call of expired) {
            await callTerminator.end(call.id, {
                reason: TerminationReason.CANCELLED,
                terminatedBy: TerminatedBy.SYSTEM,
                onlyIfStatus: CallStatus.INITIATED,
                provider: 'none',
                source: 'outbound_intent_expired',
            });
        }
    }

    // ── IVR ring timeout scan ─────────────────────────────────────────────────

    async _runIvrRingCleanup() {
        try {
            const stuckCalls = await CallRepository.findStuckIvrTransferredCalls();
            if (stuckCalls.length === 0) return;

            log.info(`IVR ring timeout: ${stuckCalls.length} call(s) exceeded agent ring timeout`);

            for (const call of stuckCalls) {
                // Lifecycle event — written before termination so the duration is accurate.
                callLifecycleLogger.logIvrAgentMissed(call.id, call.tenant_id, call.agent_id, {
                    ring_duration_seconds: Math.floor(
                        (Date.now() - new Date(call.ringing_at).getTime()) / 1000
                    ),
                    ivr_flow_id: call.ivr_flow_id,
                    configured_timeout: call.agent_ring_timeout,
                }).catch(err =>
                    log.error({ callId: call.id, err }, 'IVR lifecycle log failed')
                );

                // A missed offer for the auto-offline policy. Counted here because
                // this path ends the call itself, so the provider's end never sees
                // an unanswered offer. Any queue: IVR → agent is its own overlay.
                if (await autoOfflinePolicy.recordMiss({
                    callId: call.id, tenantId: call.tenant_id, queueId: call.queue_id, agentId: call.agent_id, anyQueue: true,
                })) {
                    await agentAssignmentCoordinator.emitQueueUpdate(call.tenant_id).catch(() => { });
                }

                this.enqueue(call.id, call.tenant_id, TerminationReason.IVR_AGENT_NO_ANSWER);
            }

            const businesses = [...new Set(stuckCalls.map(c => c.tenant_id))];
            for (const bId of businesses) {
                this.lastCleanupTime.delete(bId);
                this.processCleanupQueue(bId);
            }
        } catch (err) {
            log.error({ err }, 'IVR ring cleanup scan failed');
        }
    }

    /**
     * Reconcile this worker's call media against the DB: a call can be
     * finalized in the DB without this worker closing its legs (an IVR-only
     * call ending at the provider, whose owner never got CALL_TERMINATED).
     * Closes the media of any call that is terminal or gone.
     */
    async _reconcileOrphanedLegs() {
        const localCallIds = callMedia.activeCallIds();
        if (localCallIds.length === 0) return;

        let calls;
        try {
            calls = await CallRepository.findByIds(localCallIds);
        } catch (err) {
            log.error({ err }, 'Reconciler DB lookup failed');
            return;
        }

        const statusById = new Map(calls.map(c => [String(c.id), c.status]));
        const callById = new Map(calls.map(c => [String(c.id), c]));

        for (const callId of localCallIds) {
            const status = statusById.get(String(callId));
            // Close if the call is terminal, or no longer exists in the DB at all.
            if (status !== undefined && !TERMINAL_STATUSES.has(status)) continue;

            log.info({ callId }, `Closing an ended call's media (db status: ${status ?? 'not found'})`);
            await mediaLegs.close(callId).catch(err =>
                log.error({ callId, err }, 'Reconciler close failed')
            );

            // Emit call:terminated so every EventBus subscriber (the IVR, the
            // network-loss policy) stops for this call too.
            const call = callById.get(String(callId));
            EventBus.emit('call:terminated', {
                callId,
                tenantId: call?.tenant_id ?? null,
                reason: 'orphan_cleanup',
                terminationReason: status ?? 'NOT_FOUND',
            });
        }
    }
}

export const callCleanupService = new CallCleanupService();
