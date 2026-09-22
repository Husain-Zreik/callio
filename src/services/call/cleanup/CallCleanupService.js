// services/call/cleanup/CallCleanupService.js
// Owns stuck-call detection, cleanup queue processing, and periodic scan.
// getOngoingCalls lives in CallManager (it's a query, not a cleanup operation).
import CallRepository from '../../../repositories/CallRepository.js';
import AgentRepository from '../../../repositories/AgentRepository.js';
import BusinessRepository from '../../../repositories/BusinessRepository.js';
import EventBus from '../../core/EventBus.js';
import { peerRegistry } from '../signaling/webrtc/PeerRegistry.js';
import { AgentAvailability, CallStatus, TerminationReason } from '../constants/CallConstants.js';
import { agentMissedCallTracker } from '../../redis/AgentMissedCallTracker.js';
import { callLifecycleLogger } from '../lifecycle/CallLifecycleLogger.js';
import { agentAssignmentCoordinator } from '../assignment/AgentAssignmentCoordinator.js';

const CLEANUP_COOLDOWN = 30_000;

// Statuses that mean the call is over. A local peer connection still held for a
// call in one of these states is an orphan and must be closed (see reconciler).
const TERMINAL_STATUSES = new Set([
    CallStatus.TERMINATED,
    CallStatus.FAILED,
    CallStatus.CANCELLED,
]);

class CallCleanupService {
    constructor() {
        this.cleanupQueue = new Map();     // callId -> { callId, businessId, reason }
        this.lastCleanupTime = new Map();  // businessId -> timestamp
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

    // ── Public API ────────────────────────────────────────────────────────────

    enqueue(callId, businessId, reason) {
        this.cleanupQueue.set(callId, { callId, businessId, reason });
    }

    // ── Cleanup queue ─────────────────────────────────────────────────────────

    processCleanupQueue(businessId) {
        const now = Date.now();
        const lastCleanup = this.lastCleanupTime.get(businessId) || 0;

        if (now - lastCleanup < CLEANUP_COOLDOWN) return;

        const businessQueue = Array.from(this.cleanupQueue.values())
            .filter(item => item.businessId === businessId);

        if (businessQueue.length === 0) return;

        this.lastCleanupTime.set(businessId, now);
        console.log(`[Cleanup] Processing ${businessQueue.length} queued calls for business ${businessId}`);

        setImmediate(async () => {
            try {
                await this.batchCleanupCalls(businessQueue);
                businessQueue.forEach(item => this.cleanupQueue.delete(item.callId));
                console.log(`[Cleanup] ✅ Batch cleanup completed for ${businessQueue.length} calls`);
            } catch (error) {
                console.error(`[Cleanup] ❌ Batch cleanup failed:`, error);
            }
        });
    }

    async batchCleanupCalls(callItems) {
        if (!callItems?.length) return;

        const callIds = callItems.map(item => item.callId);
        const businessId = callItems[0].businessId;

        console.log(`[Cleanup] 🧹 Batch cleaning ${callIds.length} calls for business ${businessId}`);

        const calls = await CallRepository.findByIds(callIds);
        if (calls.length === 0) { console.log(`[Cleanup] ⚠️ No calls found`); return; }

        // Group by reason for accurate batch updates
        const byReason = {};
        callItems.forEach(item => {
            const reason = item.reason || 'UNKNOWN';
            (byReason[reason] ??= []).push(item.callId);
        });

        // Real bug found and fixed (2026-09-01, live-reported: an agent's
        // call ended itself moments after they accepted it) — see
        // CallRepository.batchTerminateCalls's own doc comment for the full
        // race. NO_ANSWER specifically means "was RINGING, timed out
        // unanswered" per _runPeriodicCleanup's own reason assignment — the
        // only reason value in this whole function where "the call already
        // moved on to IN_PROGRESS via a genuine accept" is possible and
        // wrong to terminate for. Other reasons (a stuck IN_PROGRESS call
        // that already has its own termination_reason set, see
        // findAllStuckCalls) aren't subject to this same race, so they keep
        // the unconditional behavior.
        //
        // terminatedIds accumulates only what batchTerminateCalls confirms
        // was ACTUALLY terminated — the DB-level guard alone isn't enough:
        // emitting call:terminated for an id this UPDATE didn't touch would
        // just move the same "silent wrong termination" bug from the
        // database into the event stream instead of fixing it.
        const terminatedIds = new Set();
        for (const [reason, ids] of Object.entries(byReason)) {
            const requireStatus = reason === TerminationReason.NO_ANSWER ? CallStatus.RINGING : null;
            const actuallyTerminated = await CallRepository.batchTerminateCalls(ids, reason, 'SYSTEM', requireStatus);
            actuallyTerminated.forEach(id => terminatedIds.add(id));
            const skipped = ids.length - actuallyTerminated.length;
            console.log(`[Cleanup] ✅ Terminated ${actuallyTerminated.length} calls with reason: ${reason}`
                + (skipped > 0 ? ` (${skipped} skipped — already moved past the expected status)` : ''));
        }

        // Computed from the terminated set, not the original batch — same
        // reasoning as terminatedIds itself: an agent whose call raced to
        // IN_PROGRESS and was correctly excluded above is still genuinely on
        // that call; marking them AVAILABLE would hand a second inbound call
        // to someone mid-conversation.
        const agentIds = [...new Set(
            calls.filter(c => terminatedIds.has(c.id) && c.user_id).map(c => c.user_id)
        )];
        if (agentIds.length > 0) {
            await AgentRepository.batchUpdateAgentAvailability(agentIds, AgentAvailability.AVAILABLE);
            console.log(`[Cleanup] ✅ Released ${agentIds.length} agents`);
        }

        terminatedIds.forEach(id => {
            peerRegistry.closePeerConnection(id).catch(err =>
                console.error(`[Cleanup] Error closing connection ${id}:`, err)
            );
        });

        calls.forEach(call => {
            if (!terminatedIds.has(call.id)) return;
            const item = callItems.find(i => i.callId === call.id);
            EventBus.emit('call:terminated', {
                callId: call.id,
                businessId: call.business_id,
                reason: 'cleanup_queued',
                terminationReason: item?.reason || 'UNKNOWN',
            });
        });

        console.log(`[Cleanup] ✅ Batch cleanup completed for ${terminatedIds.size}/${calls.length} calls`);
        return terminatedIds;
    }

    // On-demand equivalent of the periodic scan, scoped to one agent. Called
    // from POST /internal/calls/release-stale — the replacement for Laravel's
    // UserController::updateCallAvailability doing its own raw `calls` UPDATE,
    // which skipped peer close / agent release / call:terminated / lifecycle
    // logging and lacked this service's own accept-vs-terminate race guard
    // (see batchTerminateCalls). Runs the real cleanup immediately instead of
    // waiting up to 30s for the next periodic tick.
    async releaseStaleCallsForUser(userId) {
        const stuckCalls = await CallRepository.findStuckCallsForUser(userId, 1);
        if (stuckCalls.length === 0) return { releasedCount: 0 };

        console.log(`[Cleanup] 📞 On-demand stale-call release for user ${userId}: ${stuckCalls.length} call(s)`);

        const callItems = stuckCalls.map(call => ({
            callId: call.id,
            businessId: call.business_id,
            reason: call.status === CallStatus.RINGING
                ? TerminationReason.NO_ANSWER
                : (call.termination_reason ?? TerminationReason.COMPLETED),
        }));

        const terminatedIds = await this.batchCleanupCalls(callItems);
        return { releasedCount: terminatedIds?.size ?? 0 };
    }

    // ── Periodic scan ─────────────────────────────────────────────────────────

    async _runPeriodicCleanup() {
        // Reconcile this worker's in-memory peers against the DB first — closes orphaned
        // wrtc peers for calls already terminated elsewhere (runs every cycle, even when
        // the DB stuck-call scan below finds nothing).
        await this._reconcileOrphanedPeers();

        try {
            const stuckCalls = await CallRepository.findAllStuckCalls(1);
            if (stuckCalls.length === 0) return;

            console.log(`[Cleanup] ⏰ Periodic scan found ${stuckCalls.length} stuck call(s)`);

            for (const call of stuckCalls) {
                const reason = call.status === 'RINGING' ? 'NO_ANSWER' : (call.termination_reason ?? 'COMPLETED');
                this.enqueue(call.id, call.business_id, reason);
            }

            const businesses = [...new Set(stuckCalls.map(c => c.business_id))];
            for (const bId of businesses) {
                this.lastCleanupTime.delete(bId); // force drain immediately
                this.processCleanupQueue(bId);
            }
        } catch (err) {
            console.error('[Cleanup] ❌ Periodic cleanup scan failed:', err.message);
        }
    }

    // ── IVR ring timeout scan ─────────────────────────────────────────────────

    async _runIvrRingCleanup() {
        try {
            const stuckCalls = await CallRepository.findStuckIvrTransferredCalls();
            if (stuckCalls.length === 0) return;

            console.log(`[Cleanup] ⏰ IVR ring timeout: ${stuckCalls.length} call(s) exceeded agent ring timeout`);

            const policyCache = new Map(
                await Promise.all(
                    [...new Set(stuckCalls.map(c => c.business_id))].map(async bId => {
                        try {
                            return [bId, await BusinessRepository.getAutoOfflineSettings(bId)];
                        } catch {
                            return [bId, { enabled: false }];
                        }
                    })
                )
            );

            for (const call of stuckCalls) {
                // Lifecycle event — written before termination so the duration is accurate.
                callLifecycleLogger.logIvrAgentMissed(call.id, call.business_id, call.user_id, {
                    ring_duration_seconds: Math.floor(
                        (Date.now() - new Date(call.ringing_at).getTime()) / 1000
                    ),
                    ivr_menu_id: call.ivr_menu_id,
                    configured_timeout: call.agent_ring_timeout,
                }).catch(err =>
                    console.error(`[Cleanup] IVR lifecycle log failed for call ${call.id}:`, err.message)
                );

                // AutoOffline streak — mirrors the logic in CallWebhookProcessor but fires
                // here because the cleanup service terminates the call first, so
                // finalizedByThisWebhook=false in the webhook path and the streak block there
                // never runs. We skip the routing-strategy guard used for regular QUEUE calls
                // because the IVR path is its own routing overlay (not strategy-specific).
                try {
                    const policy = policyCache.get(call.business_id) ?? { enabled: false };
                    if (policy.enabled && call.user_id) {
                        const agentIsOnActiveCall = await CallRepository.hasAgentActiveCall(call.user_id, call.id);
                        if (agentIsOnActiveCall) {
                            console.log(
                                `[AutoOffline] Skipping IVR missed-streak for agent ${call.user_id} — agent is on ` +
                                `an active call (business=${call.business_id}, missed=${call.id})`
                            );
                        } else {
                            const streak = await agentMissedCallTracker.increment(call.user_id);
                            console.log(
                                `[AutoOffline] Agent ${call.user_id} IVR missed-streak=${streak}/${policy.threshold} ` +
                                `(business=${call.business_id}, call=${call.id})`
                            );
                            if (streak >= policy.threshold) {
                                const flipped = await AgentRepository.updateAgentAvailability(
                                    call.user_id, AgentAvailability.OFFLINE
                                );
                                await agentMissedCallTracker.reset(call.user_id);
                                if (flipped) {
                                    EventBus.emit('call:agent_availability', {
                                        businessId: call.business_id,
                                        userId: call.user_id,
                                        availability: AgentAvailability.OFFLINE,
                                        reason: 'auto_offline_missed_calls',
                                        consecutiveMissed: streak,
                                        updatedAt: new Date().toISOString(),
                                    });
                                    await agentAssignmentCoordinator.emitQueueUpdate(call.business_id).catch(() => { });
                                    console.log(
                                        `[AutoOffline] Flipped agent ${call.user_id} OFFLINE after ${streak} consecutive ` +
                                        `IVR missed calls (threshold=${policy.threshold}, business=${call.business_id})`
                                    );
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error(
                        `[Cleanup] IVR AutoOffline check failed for call ${call.id}:`, err.message
                    );
                }

                this.enqueue(call.id, call.business_id, TerminationReason.IVR_AGENT_NO_ANSWER);
            }

            const businesses = [...new Set(stuckCalls.map(c => c.business_id))];
            for (const bId of businesses) {
                this.lastCleanupTime.delete(bId);
                this.processCleanupQueue(bId);
            }
        } catch (err) {
            console.error('[Cleanup] ❌ IVR ring cleanup scan failed:', err.message);
        }
    }

    /**
     * Reconcile this worker's in-memory peer connections against the DB.
     *
     * A call can be finalized in the DB without this worker's closePeerConnection
     * ever running — most notably IVR-only inbound calls, which have a WHATSAPP peer
     * but no FRONTEND/agent and therefore never subscribe to the Redis CALL_TERMINATED
     * event. When such a call ends (caller hangup → WhatsApp webhook, or an IVR hangup
     * node), the DB is marked terminal but the owning worker keeps the wrtc peer
     * (peerConnections + connectionStates + ~native memory) forever. The RINGING/
     * IN_PROGRESS stuck-call scan can't catch it because the row is already terminal.
     *
     * This closes any local peer whose call is terminal (or no longer present) in the DB.
     */
    async _reconcileOrphanedPeers() {
        const localCallIds = [...peerRegistry.peerConnections.keys()];
        if (localCallIds.length === 0) return;

        let calls;
        try {
            calls = await CallRepository.findByIds(localCallIds);
        } catch (err) {
            console.error('[Cleanup] ♻️ Reconciler DB lookup failed:', err.message);
            return;
        }

        const statusById = new Map(calls.map(c => [String(c.id), c.status]));
        const callById = new Map(calls.map(c => [String(c.id), c]));

        for (const callId of localCallIds) {
            const status = statusById.get(String(callId));
            // Close if the call is terminal, or no longer exists in the DB at all.
            if (status !== undefined && !TERMINAL_STATUSES.has(status)) continue;

            console.log(`[Cleanup] ♻️ Closing orphaned peer for call ${callId} (db status: ${status ?? 'not found'})`);
            await peerRegistry.closePeerConnection(callId).catch(err =>
                console.error(`[Cleanup] ♻️ Reconciler close failed for call ${callId}:`, err.message)
            );

            // Emit call:terminated so QueueAudioCoordinator (and any other EventBus
            // subscriber) receives the stop signal. Without this emit the queue audio
            // keeps running until a WhatsApp webhook arrives — up to 32 seconds later.
            const call = callById.get(String(callId));
            EventBus.emit('call:terminated', {
                callId,
                businessId: call?.business_id ?? null,
                reason: 'orphan_cleanup',
                terminationReason: status ?? 'NOT_FOUND',
            });
        }
    }
}

export const callCleanupService = new CallCleanupService();
