// src/repositories/CallRepository.js
import connection from '../../config/dbConnection.js';

function normalizeNumber(num) {
    if (!num) return null;
    return num.startsWith('+') ? num.slice(1) : num;
}

class CallRepository {
    // ── Queries ─────────────────────────────────────────────────────────────────

    async create(data) {
        const {
            wacid = null,
            user_id = null,
            business_id,
            business_number_id,
            client_number_id = null,
            ivr_menu_id = null,
            state = null,
            caller_number,
            caller_name = null,
            caller_username = null,
            callee_number,
            callee_name = null,
            callee_username = null,
            direction,
            type = 'AUDIO',
            status = 'INITIATED',
            ringing_at = null,
            is_billable = true,
            is_billed = false,
            metadata = null
        } = data;

        const normalizedFrom = normalizeNumber(caller_number);
        const normalizedTo = normalizeNumber(callee_number);

        const [result] = await connection.execute(`
        INSERT INTO calls (
            wacid,
            business_id,
            user_id,
            business_number_id,
            client_number_id,
            ivr_menu_id,
            state,
            caller_number,
            caller_name,
            caller_username,
            callee_number,
            callee_name,
            callee_username,
            direction,
            type,
            status,
            ringing_at,
            is_billable,
            is_billed,
            metadata,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
            wacid,
            business_id,
            user_id,
            business_number_id,
            client_number_id,
            ivr_menu_id,
            state,
            normalizedFrom,
            caller_name,
            caller_username,
            normalizedTo,
            callee_name,
            callee_username,
            direction,
            type,
            status,
            ringing_at,
            is_billable,
            is_billed,
            metadata ? JSON.stringify(metadata) : null
        ]);

        return result.insertId;
    }

    async findById(callId) {
        const [rows] = await connection.execute(
            'SELECT * FROM calls WHERE id = ?',
            [callId]
        );
        return rows[0] || null;
    }

    async findByWacid(wacid) {
        const [rows] = await connection.execute(
            'SELECT * FROM calls WHERE wacid = ?',
            [wacid]
        );
        return rows[0] || null;
    }

    async findActiveInboundByClient(clientNumberId, businessId) {
        const [rows] = await connection.execute(
            `SELECT id, wacid FROM calls
             WHERE client_number_id = ? AND business_id = ? AND direction = 'INBOUND'
               AND status IN ('RINGING', 'IN_PROGRESS')
             ORDER BY created_at DESC LIMIT 1`,
            [clientNumberId, businessId]
        );
        return rows[0] || null;
    }

    async findByIds(callIds) {
        if (!callIds || callIds.length === 0) return [];
        const placeholders = callIds.map(() => '?').join(', ');
        const [rows] = await connection.execute(
            `SELECT * FROM calls WHERE id IN (${placeholders})`,
            callIds
        );
        return rows;
    }

    async getStatus(callId) {
        const [rows] = await connection.execute(
            'SELECT status FROM calls WHERE id = ?',
            [callId]
        );
        return rows[0]?.status || null;
    }

    async getUserActiveCall(businessId, callId, userId) {
        const [rows] = await connection.execute(
            `SELECT * FROM calls
             WHERE business_id = ?
             AND id = ?
             AND user_id = ?
             AND (
                 (status = 'IN_PROGRESS' AND state = 'ACTIVE')
                 OR (status IN ('INITIATED', 'RINGING') AND direction = 'OUTBOUND')
                 -- An INBOUND call already claimed by this exact user_id (the WHERE
                 -- clause above already guarantees that) but still RINGING — the
                 -- "accept in flight" window in AgentEventHandler.handleAgentJoined:
                 -- it claims the call and persists the FRONTEND connection's device_id
                 -- well before waiting for the agent's audio track + the WhatsApp
                 -- Accept API round-trip, which can take anywhere from ~0.5s up to
                 -- several seconds. A reconnect/switch-here attempt landing in that
                 -- window is legitimate (this user_id really does own this call) and
                 -- must not be rejected just because status hasn't flipped to
                 -- IN_PROGRESS yet.
                 OR (status = 'RINGING' AND direction = 'INBOUND')
             )
             ORDER BY created_at DESC
             LIMIT 1`,
            [businessId, callId, userId]
        );
        return rows[0] || null;
    }

    async getInProgressCall(businessId, callId) {
        const [rows] = await connection.execute(
            `SELECT *
             FROM calls
             WHERE business_id = ?
             AND id = ?
             AND (status = 'IN_PROGRESS' AND state = 'ACTIVE')
             ORDER BY created_at DESC
             LIMIT 1`,
            [businessId, callId]
        );
        return rows[0] || null;
    }

    async getOngoingCallsForBusiness(businessId) {
        const [rows] = await connection.execute(
            `SELECT * FROM calls
             WHERE business_id = ?
             AND status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
             ORDER BY created_at DESC`,
            [businessId]
        );
        return rows;
    }

    async getOngoingCallsForAgent(businessId, userId) {
        const [rows] = await connection.execute(
            `SELECT * FROM calls
             WHERE business_id = ?
               AND user_id = ?
               AND status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
             ORDER BY created_at DESC`,
            [businessId, userId]
        );
        return rows;
    }

    async hasUnassignedCalls(businessId) {
        // Only counts regular (non-IVR) queued calls. IVR-transferred calls
        // (ivr_menu_id IS NOT NULL AND state='QUEUE') are excluded because they
        // have their own handler (assignTransferredCall) and should not block
        // new PRIORITY/RECEPTIONIST calls from claiming an agent synchronously.
        // Including them caused the coordinator to race with assignTransferredCall
        // and attempt FRONTEND SDP creation on the wrong worker.
        const [rows] = await connection.execute(
            `SELECT 1 FROM calls
             WHERE business_id = ?
               AND status = 'RINGING'
               AND user_id IS NULL
               AND direction = 'INBOUND'
               AND ivr_menu_id IS NULL
               AND (state IS NULL OR state NOT IN ('IVR'))
             LIMIT 1`,
            [businessId]
        );
        return rows.length > 0;
    }

    // Same WHERE shape as findOldestUnassignedCalls (both regular-queued and
    // IVR-transferred-to-QUEUE calls) — used to surface a "N calls waiting"
    // count to a plain agent, who otherwise has no visibility into calls
    // unassigned to anyone (calls:list is scoped to their own userId only).
    // Deliberately not hasUnassignedCalls's narrower IVR-excluding shape,
    // which exists for a different, internal race-avoidance purpose — this
    // count is a user-facing total, so it should count every call actually
    // waiting for an agent, IVR-originated or not.
    async countUnassignedCalls(businessId) {
        const [rows] = await connection.execute(
            `SELECT COUNT(*) AS count FROM calls
             WHERE business_id = ?
               AND status = 'RINGING'
               AND user_id IS NULL
               AND direction = 'INBOUND'
               AND (
                     (ivr_menu_id IS NULL AND (state IS NULL OR state NOT IN ('IVR')))
                  OR (ivr_menu_id IS NOT NULL AND state = 'QUEUE')
               )`,
            [businessId]
        );
        return Number(rows[0]?.count ?? 0);
    }

    async findOldestUnassignedCalls(businessId, limit = 20) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
        const [rows] = await connection.execute(
            `SELECT * FROM calls
             WHERE business_id = ?
               AND status = 'RINGING'
               AND user_id IS NULL
               AND direction = 'INBOUND'
               AND (
                     (ivr_menu_id IS NULL AND (state IS NULL OR state NOT IN ('IVR')))
                  OR (ivr_menu_id IS NOT NULL AND state = 'QUEUE')
               )
             ORDER BY ringing_at ASC
             LIMIT ${safeLimit}`,
            [businessId]
        );
        return rows;
    }

    // Finds a RINGING call for the agent, with a 30-second IN_PROGRESS window to
    // handle the push-notification race: a mobile agent can accept natively and
    // send the accept event before the WebSocket connect handler queries. In that
    // case the call has already flipped to IN_PROGRESS and a RINGING-only query
    // would silently miss it. The 30-second cap prevents false positives for
    // long-running active calls (e.g. agent reopens a browser tab mid-call).
    async findPendingInboundCallForUser(businessId, userId) {
        const [rows] = await connection.execute(
            `SELECT *
             FROM calls
             WHERE business_id = ?
               AND user_id     = ?
               AND direction   = 'INBOUND'
               AND (
                   status = 'RINGING'
                   OR (status = 'IN_PROGRESS' AND answered_at >= NOW() - INTERVAL 30 SECOND)
               )
             ORDER BY created_at ASC
             LIMIT 1`,
            [businessId, userId]
        );
        return rows[0] || null;
    }

    // Returns calls that were IVR-transferred to an agent but the agent has not
    // accepted within the per-menu timeout (default 60 s, per-menu via
    // ivr_menus.agent_ring_timeout). Only RINGING calls with state=QUEUE and a
    // non-null ivr_menu_id are considered — this is the exact state produced by
    // IvrTransferHandler after a successful IVR-to-agent transfer.
    async findStuckIvrTransferredCalls() {
        const [rows] = await connection.execute(
            `SELECT c.id, c.business_id, c.user_id, c.ivr_menu_id, c.ringing_at,
                    COALESCE(im.agent_ring_timeout, 60) AS agent_ring_timeout
             FROM calls c
             LEFT JOIN ivr_menus im ON c.ivr_menu_id = im.id
             WHERE c.status  = 'RINGING'
               AND c.state   = 'QUEUE'
               AND c.direction = 'INBOUND'
               AND c.user_id IS NOT NULL
               AND c.ivr_menu_id IS NOT NULL
               AND c.ringing_at IS NOT NULL
               AND c.ringing_at < DATE_SUB(NOW(), INTERVAL COALESCE(im.agent_ring_timeout, 60) SECOND)`
        );
        return rows;
    }

    async findAllStuckCalls(ringingMinutes = 1) {
        const cutoff = new Date(Date.now() - ringingMinutes * 60 * 1000);

        const [rows] = await connection.execute(
            `SELECT id, business_id, user_id, status, termination_reason
             FROM calls
             WHERE (
                 (status = 'RINGING' AND ringing_at < ?
                  -- IVR calls waiting for auto-accept: still in IVR state with no agent
                  AND NOT (direction = 'INBOUND' AND user_id IS NULL AND state = 'IVR')
                  -- IVR-transferred RINGING calls: handled exclusively by _runIvrRingCleanup
                  -- to preserve the IVR_AGENT_NO_ANSWER termination reason regardless of timeout
                  AND NOT (direction = 'INBOUND' AND user_id IS NOT NULL AND ivr_menu_id IS NOT NULL AND state = 'QUEUE')
                 )
                 OR
                 (status = 'IN_PROGRESS' AND termination_reason IS NOT NULL)
             )
             AND status NOT IN ('TERMINATED', 'FAILED')`,
            [cutoff]
        );
        return rows;
    }

    // Same predicate as findAllStuckCalls, scoped to one agent. Used by the
    // on-demand /internal/calls/release-stale endpoint (see
    // CallCleanupService.releaseStaleCallsForUser) so a stale call blocking an
    // agent's availability toggle can be cleared immediately instead of
    // waiting up to 30s for the next periodic scan. The IVR-auto-accept
    // exclusion from findAllStuckCalls is omitted here since it only applies
    // to user_id IS NULL rows, which can never match a user-scoped query.
    async findStuckCallsForUser(userId, ringingMinutes = 1) {
        const cutoff = new Date(Date.now() - ringingMinutes * 60 * 1000);

        const [rows] = await connection.execute(
            `SELECT id, business_id, user_id, status, termination_reason
             FROM calls
             WHERE user_id = ?
               AND (
                   (status = 'RINGING' AND ringing_at < ?
                    -- IVR-transferred RINGING calls: handled exclusively by _runIvrRingCleanup
                    -- to preserve the IVR_AGENT_NO_ANSWER termination reason regardless of timeout
                    AND NOT (direction = 'INBOUND' AND ivr_menu_id IS NOT NULL AND state = 'QUEUE')
                   )
                   OR
                   (status = 'IN_PROGRESS' AND termination_reason IS NOT NULL)
               )
               AND status NOT IN ('TERMINATED', 'FAILED')`,
            [userId, cutoff]
        );
        return rows;
    }

    // ── Updates ─────────────────────────────────────────────────────────────────

    async updateStatus(callId, status) {
        await connection.execute(
            'UPDATE calls SET status = ?, updated_at = NOW() WHERE id = ?',
            [status, callId]
        );
    }

    // Returns true if the transition succeeded (row had expected status).
    async transitionStatus(callId, expectedStatus, newStatus) {
        const [result] = await connection.execute(
            'UPDATE calls SET status = ?, updated_at = NOW() WHERE id = ? AND status = ?',
            [newStatus, callId, expectedStatus]
        );
        return result.affectedRows > 0;
    }

    async updateState(callId, state) {
        await connection.execute(
            'UPDATE calls SET state = ?, updated_at = NOW() WHERE id = ?',
            [state, callId]
        );
    }

    // Marks a call IN_PROGRESS/IVR right after Meta's accept API call returns.
    // Guarded (state = 'IVR') instead of the blind updateStatus+updateState pair it
    // replaces, because acceptWhatsAppCall is a real ~400-600ms HTTP round-trip to
    // Meta. For a trivial IVR menu (start node wired straight to a transfer node,
    // no audio) the entire session — start, navigate, transfer to queue — can finish
    // in single-digit milliseconds once the WHATSAPP peer connects, which happens
    // BEFORE acceptWhatsAppCall's response comes back. An unguarded write here would
    // then land after IvrTransferHandler already set state='QUEUE'/status='RINGING'
    // and blindly revert the call back to IN_PROGRESS/IVR — stuck permanently,
    // because no cleanup query matches status=IN_PROGRESS + state=IVR +
    // termination_reason=NULL. The guard makes this a no-op once the call has
    // already moved past IVR, instead of undoing that transition.
    async markIvrAutoAccepted(callId) {
        const [result] = await connection.execute(
            `UPDATE calls SET status = 'IN_PROGRESS', state = 'IVR', updated_at = NOW()
             WHERE id = ? AND state = 'IVR'`,
            [callId]
        );
        return result.affectedRows > 0;
    }

    async updateWacid(callId, wacid) {
        await connection.execute(
            'UPDATE calls SET wacid = ?, updated_at = NOW() WHERE id = ?',
            [wacid, callId]
        );
    }

    async updateTimestamp(callId, field, timestamp = null) {
        const validFields = ['connected_at', 'ringing_at', 'answered_at', 'ended_at'];
        if (!validFields.includes(field)) {
            throw new Error(`Invalid timestamp field: ${field}`);
        }
        const value = timestamp || new Date();
        await connection.execute(
            `UPDATE calls SET ${field} = ?, updated_at = NOW() WHERE id = ?`,
            [value, callId]
        );

        // answered_at can legitimately arrive from several independent writers (local
        // accept flow, Meta's ACCEPTED webhook, IVR handoff) — any of them can land
        // after another writer already finalized the call as NO_ANSWER. NO_ANSWER
        // must never coexist with a non-null answered_at, so self-heal here once,
        // covering every current and future caller instead of each call site
        // remembering to check.
        //
        // .catch() is deliberate: several callers (e.g. AgentEventHandler's accept
        // flow) run important logic — releasing agents, emitting call:success — right
        // after this call, with no try/catch of their own around it. This correction
        // is best-effort cosmetic cleanup; it must never be the reason a real accept
        // or webhook-processing flow gets treated as failed.
        if (field === 'answered_at') {
            await this.correctNoAnswerIfAnswered(callId).catch((err) =>
                console.error(`[CallRepository] correctNoAnswerIfAnswered failed for call ${callId}:`, err.message)
            );
        }
    }

    async updateDuration(callId, field, value = 0) {
        const validFields = ['ringing_duration', 'call_duration', 'queue_duration', 'on_hold_duration'];
        if (!validFields.includes(field)) {
            throw new Error(`Invalid duration field: ${field}`);
        }
        await connection.execute(
            `UPDATE calls SET ${field} = ?, updated_at = NOW() WHERE id = ?`,
            [value, callId]
        );
    }

    async updateCallbackData(callId, callbackData) {
        await connection.execute(
            `UPDATE calls SET callback_data = ?, updated_at = NOW() WHERE id = ?`,
            [JSON.stringify(callbackData), callId]
        );
    }

    // Patches terminated_by on an already-FAILED row when Meta's termination webhook
    // arrives after a local detection path (e.g. CUSTOMER_NETWORK_LOSS) already set
    // the status to FAILED. Phase 2 of finalizeCallAsFailed is blocked for FAILED rows,
    // so terminated_by would otherwise stay as SYSTEM even though Meta's error code
    // tells us whether the client or WhatsApp's relay was at fault.
    async updateTerminatedByIfFailed(callId, terminatedBy) {
        await connection.execute(
            `UPDATE calls SET terminated_by = ?, updated_at = NOW() WHERE id = ? AND status = 'FAILED'`,
            [terminatedBy, callId]
        );
    }

    async updateMetadata(callId, metadata = null) {
        const serialized = metadata ? JSON.stringify(metadata) : null;
        const [result] = await connection.execute(
            'UPDATE calls SET metadata = ?, updated_at = NOW() WHERE id = ?',
            [serialized, callId]
        );
        return result.affectedRows > 0;
    }

    async updateCallAgentIfCurrent(callId, oldAgentId, newAgentId) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET user_id = ?, updated_at = NOW()
             WHERE id = ?
             AND user_id <=> ?
             AND status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
             AND (state IS NULL OR state != 'IVR')`,
            [newAgentId, callId, oldAgentId]
        );
        return result.affectedRows > 0;
    }

    // ── Assignment ───────────────────────────────────────────────────────────────

    async assignCallToAgentIfUnassigned(callId, userId) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET user_id = ?, updated_at = NOW()
             WHERE id = ?
             AND user_id IS NULL
             AND status = 'RINGING'
             AND direction = 'INBOUND'
             AND (state IS NULL OR state != 'IVR')`,
            [userId, callId]
        );
        return result.affectedRows > 0;
    }

    async assignCallToAgentIfEligible(callId, userId) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET user_id = ?, updated_at = NOW()
             WHERE id = ?
             AND status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
             AND (user_id IS NULL OR user_id = ?)
             AND (state IS NULL OR state != 'IVR')`,
            [userId, callId, userId]
        );
        return result.affectedRows > 0;
    }

    async hasActiveCall(businessId) {
        const [rows] = await connection.execute(
            `SELECT 1
             FROM calls
             WHERE business_id = ?
             AND (
                 (status = 'IN_PROGRESS' AND state = 'ACTIVE')
                 OR (status IN ('INITIATED', 'RINGING') AND direction = 'OUTBOUND')
             )
             LIMIT 1`,
            [businessId]
        );
        return rows.length > 0;
    }

    async hasOtherActiveCall(businessId, excludeCallId) {
        const [rows] = await connection.execute(
            `SELECT 1
             FROM calls
             WHERE business_id = ?
             AND id != ?
             AND (
                 (status = 'IN_PROGRESS' AND state = 'ACTIVE')
                 OR (status IN ('INITIATED', 'RINGING') AND direction = 'OUTBOUND')
             )
             LIMIT 1`,
            [businessId, excludeCallId]
        );
        return rows.length > 0;
    }

    async hasAgentActiveCall(agentId, excludeCallId) {
        const [rows] = await connection.execute(
            `SELECT 1
             FROM calls
             WHERE user_id = ?
             AND id != ?
             AND status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
             LIMIT 1`,
            [agentId, excludeCallId]
        );
        return rows.length > 0;
    }

    // Returns the ID of an older RINGING call already assigned to this agent (id < excludeCallId).
    // Used by the delivery handler to detect race-condition double-assignments: if a prior
    // ringing call exists, the current one is the late/wrong assignment and should be suppressed.
    async getConflictingRingingCallId(agentId, excludeCallId) {
        const [rows] = await connection.execute(
            `SELECT id FROM calls
             WHERE user_id = ?
             AND id < ?
             AND status = 'RINGING'
             ORDER BY id DESC
             LIMIT 1`,
            [agentId, excludeCallId]
        );
        return rows.length > 0 ? rows[0].id : null;
    }

    // ── Termination & Finalization ───────────────────────────────────────────────

    async markCallFailed(callId, errors = null, biz_opaque_callback_data = null, reason = 'PROVIDER_ERROR', terminatedBy = 'SYSTEM') {
        const callbackData = {};
        if (errors) callbackData.errors = errors;
        if (biz_opaque_callback_data) callbackData.biz_opaque_callback_data = biz_opaque_callback_data;

        await connection.execute(
            `UPDATE calls
             SET status = ?,
                 state = ?,
                 termination_reason = ?,
                 terminated_by = ?,
                 callback_data = ?,
                 ended_at = COALESCE(ended_at, NOW()),
                 updated_at = NOW()
             WHERE id = ?`,
            [
                'FAILED', null, reason, terminatedBy,
                Object.keys(callbackData).length ? JSON.stringify(callbackData) : null,
                callId
            ]
        );
    }

    async markCallFailedIfNotFinal(callId, errors = null, biz_opaque_callback_data = null, reason = 'PROVIDER_ERROR', terminatedBy = 'SYSTEM') {
        const callbackData = {};
        if (errors) callbackData.errors = errors;
        if (biz_opaque_callback_data) callbackData.biz_opaque_callback_data = biz_opaque_callback_data;

        const [result] = await connection.execute(
            `UPDATE calls
             SET status = ?,
                 state = ?,
                 termination_reason = ?,
                 terminated_by = ?,
                 callback_data = ?,
                 ended_at = COALESCE(ended_at, NOW()),
                 updated_at = NOW()
             WHERE id = ?
               AND status NOT IN ('TERMINATED', 'FAILED')`,
            [
                'FAILED', null, reason, terminatedBy,
                Object.keys(callbackData).length ? JSON.stringify(callbackData) : null,
                callId
            ]
        );
        return result.affectedRows > 0;
    }

    async terminateCall(callId, terminationReason = null, terminatedBy = 'BUSINESS', endedAt = null) {
        await connection.execute(
            `UPDATE calls
             SET status = ?,
                 state = ?,
                 termination_reason = ?,
                 terminated_by = ?,
                 ended_at = COALESCE(?, NOW()),
                 updated_at = NOW()
             WHERE id = ?
               AND status NOT IN ('TERMINATED', 'FAILED')`,
            ['TERMINATED', null, terminationReason, terminatedBy, endedAt, callId]
        );
    }

    // Same as terminateCall but returns true if this call caused the status transition.
    // Use when the caller needs to know whether it "won" the race to terminate the call.
    async terminateCallIfNotTerminated(callId, terminationReason = null, terminatedBy = 'BUSINESS', endedAt = null) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET status = ?,
                 state = ?,
                 termination_reason = ?,
                 terminated_by = ?,
                 ended_at = COALESCE(?, NOW()),
                 updated_at = NOW()
             WHERE id = ?
               AND status NOT IN ('TERMINATED', 'FAILED')`,
            ['TERMINATED', null, terminationReason, terminatedBy, endedAt, callId]
        );
        return result.affectedRows > 0;
    }

    // Self-healing correction: a call can be locally marked NO_ANSWER (terminated
    // before our own accept flow observed answered_at) and then have Meta's ACCEPTED
    // webhook arrive afterward, proving the call was in fact answered. NO_ANSWER
    // with a non-null answered_at is a contradiction — flip it to COMPLETED so
    // reporting/billing reflects what actually happened. Scoped tightly (only
    // touches rows currently mislabeled) so it can't affect any other outcome.
    async correctNoAnswerIfAnswered(callId) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET termination_reason = 'COMPLETED',
                 updated_at = NOW()
             WHERE id = ?
               AND status = 'TERMINATED'
               AND termination_reason = 'NO_ANSWER'
               AND answered_at IS NOT NULL`,
            [callId]
        );
        return result.affectedRows > 0;
    }

    // Idempotent finalization driven by Meta's termination webhook.
    //
    // Two phases, deliberately separate:
    //
    //   Phase 1 — always fill missing timestamps/durations (COALESCE preserves any
    //   value already there). Safe to re-run; webhook can deliver durations LATE
    //   (e.g. after the row was already marked TERMINATED by an IVR or system path)
    //   and still patch them in.
    //
    //   Phase 2 — guarded status transition. Only flips TERMINATED/FAILED when the
    //   row isn't already terminal, so side-effect fan-out (agent release, lifecycle
    //   log, redis event) fires exactly once across racing handlers.
    //
    // `terminated_by` is COALESCE'd: preserve whoever stamped it first (the business
    // socket path sets BUSINESS; the webhook otherwise sets CLIENT/SYSTEM).
    //
    // Returns true iff THIS call caused the status transition.
    async finalizeFromWebhook(callId, {
        status = 'TERMINATED',
        terminationReason = null,
        terminatedBy = null,
        endedAt = null,
        answeredAt = null,
        callDuration = null,
        ringingDuration = null,
    } = {}) {
        // Phase 1: always fill missing details (idempotent, no status guard)
        await connection.execute(
            `UPDATE calls
             SET ended_at         = COALESCE(?, ended_at),
                 answered_at      = COALESCE(?, answered_at),
                 call_duration    = COALESCE(?, call_duration),
                 ringing_duration = COALESCE(?, ringing_duration),
                 updated_at = NOW()
             WHERE id = ?`,
            [endedAt, answeredAt, callDuration, ringingDuration, callId]
        );

        // Phase 2: guarded status flip (only fires side effects once)
        const [result] = await connection.execute(
            `UPDATE calls
             SET status             = ?,
                 state              = NULL,
                 termination_reason = COALESCE(termination_reason, ?),
                 terminated_by      = COALESCE(terminated_by, ?),
                 ended_at           = COALESCE(ended_at, NOW()),
                 updated_at = NOW()
             WHERE id = ?
               AND status NOT IN ('TERMINATED', 'FAILED')`,
            [status, terminationReason, terminatedBy, callId]
        );

        // Phase 1 writes answered_at unconditionally (no status guard) — if the call
        // was already finalized as NO_ANSWER by a local path before this webhook
        // arrived, Phase 2 just preserved that reason via COALESCE (it only guards
        // against re-finalizing, not against this exact contradiction). Meta's
        // answeredAt now proves the call WAS answered, so correct it here — this
        // writer bypasses updateTimestamp()'s own self-heal, hence the direct call.
        //
        // .catch() is deliberate: every caller of finalizeFromWebhook uses this
        // return value (or the side effects gated on it — agent release, call
        // reassignment, queue updates) with no wrapping try/catch at the call site.
        // This correction is best-effort; it must never turn an otherwise-successful
        // finalize into a rejected promise that skips that downstream logic.
        await this.correctNoAnswerIfAnswered(callId).catch((err) =>
            console.error(`[CallRepository] correctNoAnswerIfAnswered failed for call ${callId}:`, err.message)
        );

        return result.affectedRows > 0;
    }

    // Finalize a call as FAILED with PROVIDER_ERROR termination reason.
    //
    // Intentionally distinct from finalizeFromWebhook because FAILED has
    // different semantics:
    //
    //   • termination_reason is FORCE-written as PROVIDER_ERROR — never
    //     COALESCE'd. A previously-stored COMPLETED or NO_ANSWER reason
    //     must be corrected when Meta later reports a provider failure.
    //
    //   • FAILED can UPGRADE a row that is already TERMINATED. Meta's
    //     ordering is not guaranteed: a FAILED status event may arrive
    //     after the call was already closed as TERMINATED/COMPLETED. The
    //     final truth is FAILED — that is what must be persisted.
    //
    //   • FAILED is idempotent: a row that is already FAILED is left
    //     untouched (affectedRows = 0 → returns false).
    //
    // Returns true iff this call caused the status transition.
    async finalizeCallAsFailed(callId, {
        terminatedBy = null,
        endedAt = null,
        answeredAt = null,
        callDuration = null,
        ringingDuration = null,
    } = {}) {
        // Phase 1: fill missing timing details (same idempotent COALESCE logic)
        await connection.execute(
            `UPDATE calls
             SET ended_at         = COALESCE(?, ended_at),
                 answered_at      = COALESCE(?, answered_at),
                 call_duration    = COALESCE(?, call_duration),
                 ringing_duration = COALESCE(?, ringing_duration),
                 updated_at = NOW()
             WHERE id = ?`,
            [endedAt, answeredAt, callDuration, ringingDuration, callId]
        );

        // Phase 2: upgrade to FAILED — allowed even from TERMINATED, blocked only
        // when already FAILED (idempotency).
        const [result] = await connection.execute(
            `UPDATE calls
             SET status             = 'FAILED',
                 state              = NULL,
                 termination_reason = 'PROVIDER_ERROR',
                 terminated_by      = COALESCE(terminated_by, ?),
                 ended_at           = COALESCE(ended_at, NOW()),
                 updated_at = NOW()
             WHERE id = ?
               AND status != 'FAILED'`,
            [terminatedBy, callId]
        );
        return result.affectedRows > 0;
    }

    // ── Batch ────────────────────────────────────────────────────────────────────

    // Guard against overwriting calls already correctly finalized as FAILED
    // (e.g. calls where Meta reported PROVIDER_ERROR and finalizeCallAsFailed
    // already force-wrote that reason). Without this guard, the periodic
    // cleanup would downgrade FAILED+PROVIDER_ERROR to TERMINATED+NO_ANSWER.
    //
    // Real bug found and fixed (2026-09-01, live-reported: a mobile agent's
    // call ended itself moments after they accepted it). This function's own
    // WHERE clause never re-checked status beyond "not already terminal" —
    // it terminated whatever the caller listed, unconditionally, even if a
    // call had since moved on. The periodic stuck-call sweep
    // (CallCleanupService._runPeriodicCleanup → findAllStuckCalls) selects
    // stale-RINGING calls by `ringing_at` age, tags them reason=NO_ANSWER,
    // and queues them — but nothing re-verified a call was STILL ringing by
    // the time this UPDATE actually ran. A genuine agent accept
    // (RINGING → IN_PROGRESS) landing in that window got silently wiped back
    // to TERMINATED/NO_ANSWER right after succeeding — indistinguishable,
    // from the client's side, from "the business ended the call." Made
    // measurably more likely by the recent tightening of the sweep's poll
    // interval/cutoff to sit much closer to the real accept-latency window
    // this same call flow can take on a cold client start.
    //
    // [requireStatus]: opt-in, not a blanket restriction — this function is
    // also used for whole-batch termination where "the call's exact current
    // status" is deliberately irrelevant (server shutdown draining every
    // live call regardless of state; a business disabling call-center mode
    // and ending everything). Only CallCleanupService's NO_ANSWER path
    // (the one actually racing against a real accept) passes this.
    // Returns the subset of `callIds` that actually ended up TERMINATED —
    // i.e. excluding any that `requireStatus` protected from this specific
    // call (see this function's own doc comment above). Callers that go on
    // to emit a `call:terminated` event or release resources per-call MUST
    // use this returned list, not the original `callIds` — emitting that
    // event for a call this UPDATE didn't actually touch is exactly the
    // "silent no-op" restated as a "silent wrong event" instead, which would
    // leave the underlying bug's user-visible symptom unfixed even with the
    // DB-level race closed.
    async batchTerminateCalls(callIds, terminationReason, terminatedBy, requireStatus = null) {
        if (!callIds || callIds.length === 0) return [];

        const placeholders = callIds.map(() => '?').join(', ');
        const statusGuard = requireStatus ? 'AND status = ?' : '';

        await connection.execute(
            `UPDATE calls
             SET status = 'TERMINATED',
                 state = NULL,
                 termination_reason = ?,
                 terminated_by = ?,
                 ended_at = COALESCE(ended_at, NOW()),
                 updated_at = NOW()
             WHERE id IN (${placeholders})
               AND status NOT IN ('TERMINATED', 'FAILED')
               ${statusGuard}`,
            requireStatus
                ? [terminationReason, terminatedBy, ...callIds, requireStatus]
                : [terminationReason, terminatedBy, ...callIds]
        );

        if (!requireStatus) {
            // No guard was applied, so nothing could have been excluded —
            // skip the extra round trip and trust the original list.
            return callIds;
        }

        const [rows] = await connection.execute(
            `SELECT id FROM calls WHERE id IN (${placeholders}) AND status = 'TERMINATED'`,
            callIds
        );
        return rows.map(r => r.id);
    }
}

export default new CallRepository();
