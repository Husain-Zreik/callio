// src/persistence/CallRepository.js
import connection from '../../config/dbConnection.js';

// A call is "active" for an agent while it is in any of these statuses.
const ACTIVE_STATUSES = "('INITIATED', 'RINGING', 'IN_PROGRESS')";

// A call is waiting for an agent in its queue: inbound, ringing, nobody
// assigned, and not being handled by IVR (IVR-transferred calls are back in
// state QUEUE and count as waiting).
const WAITING_IN_QUEUE = `
    status = 'RINGING'
    AND agent_id IS NULL
    AND direction = 'INBOUND'
    AND (state IS NULL OR state = 'QUEUE')`;

class CallRepository {
    // ── Queries ─────────────────────────────────────────────────────────────────

    async create(data) {
        const {
            tenant_id,
            channel_id = null,
            channel,
            channel_address = null,
            provider_call_id = null,
            queue_id = null,
            agent_id = null,
            ivr_flow_id = null,
            state = null,
            customer_address = null,
            customer_address_type = null,
            customer_name = null,
            external_ref = null,
            consumer_metadata = null,
            direction,
            type = 'AUDIO',
            status = 'INITIATED',
            ringing_at = null,
            metadata = null,
        } = data;

        const [result] = await connection.execute(`
            INSERT INTO calls (
                tenant_id, channel_id, channel, channel_address, provider_call_id,
                queue_id, agent_id, ivr_flow_id, state,
                customer_address, customer_address_type, customer_name,
                external_ref, consumer_metadata,
                direction, type, status, ringing_at, metadata,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `, [
            tenant_id, channel_id, channel, channel_address, provider_call_id,
            queue_id, agent_id, ivr_flow_id, state,
            customer_address, customer_address_type, customer_name,
            external_ref, consumer_metadata ? JSON.stringify(consumer_metadata) : null,
            direction, type, status, ringing_at, metadata ? JSON.stringify(metadata) : null,
        ]);

        return result.insertId;
    }

    async findById(callId) {
        const [rows] = await connection.execute('SELECT * FROM calls WHERE id = ?', [callId]);
        return rows[0] || null;
    }

    // Provider call ids are unique per channel type.
    async findByProviderCallId(providerCallId, channel) {
        const [rows] = await connection.execute(
            'SELECT * FROM calls WHERE channel = ? AND provider_call_id = ?',
            [channel, providerCallId]
        );
        return rows[0] || null;
    }

    async findActiveInboundByCustomer(tenantId, customerAddress) {
        if (!customerAddress) return null;
        const [rows] = await connection.execute(
            `SELECT id, provider_call_id FROM calls
             WHERE tenant_id = ? AND customer_address = ? AND direction = 'INBOUND'
               AND status IN ('RINGING', 'IN_PROGRESS')
             ORDER BY created_at DESC LIMIT 1`,
            [tenantId, customerAddress]
        );
        return rows[0] || null;
    }

    // Management API listing. Filters: status, agentId, externalRef, direction,
    // from/to (created_at). Keyset pagination on id, newest first.
    async listForTenant(tenantId, { status, agentId, externalRef, direction, from, to, beforeId, limit = 50 } = {}) {
        const where = ['tenant_id = ?'];
        const params = [tenantId];
        if (status) { where.push('status = ?'); params.push(status); }
        if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
        if (externalRef) { where.push('external_ref = ?'); params.push(externalRef); }
        if (direction) { where.push('direction = ?'); params.push(direction); }
        if (from) { where.push('created_at >= ?'); params.push(new Date(from)); }
        if (to) { where.push('created_at < ?'); params.push(new Date(to)); }
        if (beforeId) { where.push('id < ?'); params.push(beforeId); }
        const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
        const [rows] = await connection.execute(
            `SELECT * FROM calls WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${safeLimit}`,
            params
        );
        return rows;
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
        const [rows] = await connection.execute('SELECT status FROM calls WHERE id = ?', [callId]);
        return rows[0]?.status || null;
    }

    async getUserActiveCall(tenantId, callId, agentId) {
        const [rows] = await connection.execute(
            `SELECT * FROM calls
             WHERE tenant_id = ?
             AND id = ?
             AND agent_id = ?
             AND (
                 (status = 'IN_PROGRESS' AND state = 'ACTIVE')
                 OR (status IN ('INITIATED', 'RINGING') AND direction = 'OUTBOUND')
                 -- An INBOUND call already claimed by this agent but still RINGING —
                 -- the accept-in-flight window in AgentEventHandler.handleAgentJoined
                 -- (claim + device_id persisted before the agent's audio track and the
                 -- provider accept round-trip complete). A reconnect landing there is
                 -- legitimate and must not be rejected.
                 OR (status = 'RINGING' AND direction = 'INBOUND')
             )
             ORDER BY created_at DESC
             LIMIT 1`,
            [tenantId, callId, agentId]
        );
        return rows[0] || null;
    }

    async getInProgressCall(tenantId, callId) {
        const [rows] = await connection.execute(
            `SELECT * FROM calls
             WHERE tenant_id = ? AND id = ? AND status = 'IN_PROGRESS' AND state = 'ACTIVE'
             LIMIT 1`,
            [tenantId, callId]
        );
        return rows[0] || null;
    }

    async getOngoingCallsForTenant(tenantId) {
        const [rows] = await connection.execute(
            `SELECT * FROM calls
             WHERE tenant_id = ? AND status IN ${ACTIVE_STATUSES}
             ORDER BY created_at DESC`,
            [tenantId]
        );
        return rows;
    }

    async getOngoingCallsForAgent(tenantId, agentId) {
        const [rows] = await connection.execute(
            `SELECT * FROM calls
             WHERE tenant_id = ? AND agent_id = ? AND status IN ${ACTIVE_STATUSES}
             ORDER BY created_at DESC`,
            [tenantId, agentId]
        );
        return rows;
    }

    // Regular (non-IVR) calls waiting in a queue. IVR-transferred calls are
    // excluded: they have their own assignment path (assignTransferredCall) and
    // must not block a new call from claiming an agent synchronously.
    async hasUnassignedCalls(queueId) {
        const [rows] = await connection.execute(
            `SELECT 1 FROM calls
             WHERE queue_id = ?
               AND status = 'RINGING'
               AND agent_id IS NULL
               AND direction = 'INBOUND'
               AND ivr_flow_id IS NULL
               AND (state IS NULL OR state != 'IVR')
             LIMIT 1`,
            [queueId]
        );
        return rows.length > 0;
    }

    // Every call waiting in a queue, IVR-originated or not — the user-facing
    // "N calls waiting" count.
    async countUnassignedCalls(queueId) {
        const [rows] = await connection.execute(
            `SELECT COUNT(*) AS count FROM calls WHERE queue_id = ? AND ${WAITING_IN_QUEUE}`,
            [queueId]
        );
        return Number(rows[0]?.count ?? 0);
    }

    async findOldestUnassignedCalls(queueId, limit = 20) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
        const [rows] = await connection.execute(
            `SELECT * FROM calls WHERE queue_id = ? AND ${WAITING_IN_QUEUE}
             ORDER BY ringing_at ASC
             LIMIT ${safeLimit}`,
            [queueId]
        );
        return rows;
    }

    // A tenant's queues that have calls waiting, longest wait first — the order
    // a freed agent should drain them in.
    async findQueuesWithWaitingCalls(tenantId) {
        const [rows] = await connection.execute(
            `SELECT queue_id, MIN(ringing_at) AS oldest
             FROM calls
             WHERE tenant_id = ? AND queue_id IS NOT NULL AND ${WAITING_IN_QUEUE}
             GROUP BY queue_id
             ORDER BY oldest ASC`,
            [tenantId]
        );
        return rows.map((r) => r.queue_id);
    }

    // Calls in a queue that count toward queues.max_active_calls: answered
    // calls plus outbound calls still setting up, excluding one call.
    async countOtherActiveCallsInQueue(queueId, excludeCallId = 0) {
        const [rows] = await connection.execute(
            `SELECT COUNT(*) AS count FROM calls
             WHERE queue_id = ?
               AND id != ?
               AND (
                   (status = 'IN_PROGRESS' AND state = 'ACTIVE')
                   OR (status IN ('INITIATED', 'RINGING') AND direction = 'OUTBOUND')
               )`,
            [queueId, excludeCallId]
        );
        return Number(rows[0]?.count ?? 0);
    }

    // Finds a RINGING call for the agent, with a 30-second IN_PROGRESS window for
    // the push-notification race: a mobile agent can accept natively before the
    // socket connect handler queries, leaving the call already IN_PROGRESS.
    async findPendingInboundCallForUser(tenantId, agentId) {
        const [rows] = await connection.execute(
            `SELECT *
             FROM calls
             WHERE tenant_id = ?
               AND agent_id  = ?
               AND direction = 'INBOUND'
               AND (
                   status = 'RINGING'
                   OR (status = 'IN_PROGRESS' AND answered_at >= NOW() - INTERVAL 30 SECOND)
               )
             ORDER BY created_at ASC
             LIMIT 1`,
            [tenantId, agentId]
        );
        return rows[0] || null;
    }

    // IVR-transferred calls whose assigned agent hasn't accepted within the
    // flow's agent_ring_timeout (default 60 s) — exactly the state
    // IvrTransferHandler leaves after a transfer to an agent.
    async findStuckIvrTransferredCalls() {
        const [rows] = await connection.execute(
            `SELECT c.id, c.tenant_id, c.agent_id, c.queue_id, c.ivr_flow_id, c.ringing_at,
                    COALESCE(f.agent_ring_timeout, 60) AS agent_ring_timeout
             FROM calls c
             LEFT JOIN ivr_flows f ON c.ivr_flow_id = f.id
             WHERE c.status  = 'RINGING'
               AND c.state   = 'QUEUE'
               AND c.direction = 'INBOUND'
               AND c.agent_id IS NOT NULL
               AND c.ivr_flow_id IS NOT NULL
               AND c.ringing_at IS NOT NULL
               AND c.ringing_at < DATE_SUB(NOW(), INTERVAL COALESCE(f.agent_ring_timeout, 60) SECOND)`
        );
        return rows;
    }

    async findAllStuckCalls(ringingMinutes = 1) {
        const cutoff = new Date(Date.now() - ringingMinutes * 60 * 1000);
        const [rows] = await connection.execute(
            `SELECT id, tenant_id, agent_id, queue_id, status, termination_reason
             FROM calls
             WHERE (
                 (status = 'RINGING' AND ringing_at < ?
                  -- IVR calls waiting for auto-accept: still in IVR with no agent
                  AND NOT (direction = 'INBOUND' AND agent_id IS NULL AND state = 'IVR')
                  -- IVR-transferred RINGING calls: handled only by _runIvrRingCleanup,
                  -- to keep the IVR_AGENT_NO_ANSWER reason regardless of timeout
                  AND NOT (direction = 'INBOUND' AND agent_id IS NOT NULL AND ivr_flow_id IS NOT NULL AND state = 'QUEUE')
                 )
                 OR
                 (status = 'IN_PROGRESS' AND termination_reason IS NOT NULL)
             )
             AND status NOT IN ('TERMINATED', 'FAILED')`,
            [cutoff]
        );
        return rows;
    }

    // Same predicate as findAllStuckCalls, scoped to one agent, so a stale call
    // blocking an agent can be released immediately.
    async findStuckCallsForUser(agentId, ringingMinutes = 1) {
        const cutoff = new Date(Date.now() - ringingMinutes * 60 * 1000);
        const [rows] = await connection.execute(
            `SELECT id, tenant_id, agent_id, queue_id, status, termination_reason
             FROM calls
             WHERE agent_id = ?
               AND (
                   (status = 'RINGING' AND ringing_at < ?
                    AND NOT (direction = 'INBOUND' AND ivr_flow_id IS NOT NULL AND state = 'QUEUE')
                   )
                   OR
                   (status = 'IN_PROGRESS' AND termination_reason IS NOT NULL)
               )
               AND status NOT IN ('TERMINATED', 'FAILED')`,
            [agentId, cutoff]
        );
        return rows;
    }

    // Outbound intents never started by their agent (call:start seeds ringing_at).
    async findExpiredOutboundIntents(minutes = 2) {
        const cutoff = new Date(Date.now() - minutes * 60 * 1000);
        const [rows] = await connection.execute(
            `SELECT id, tenant_id, agent_id FROM calls
             WHERE direction = 'OUTBOUND' AND status = 'INITIATED'
               AND ringing_at IS NULL AND provider_call_id IS NULL
               AND created_at < ?`,
            [cutoff]
        );
        return rows;
    }

    // ── Updates ─────────────────────────────────────────────────────────────────

    async updateStatus(callId, status) {
        await connection.execute('UPDATE calls SET status = ?, updated_at = NOW() WHERE id = ?', [status, callId]);
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
        await connection.execute('UPDATE calls SET state = ?, updated_at = NOW() WHERE id = ?', [state, callId]);
    }

    // Marks a call IN_PROGRESS/IVR right after the provider accept returns.
    // Guarded on state='IVR': for a trivial flow the whole IVR session can finish
    // (and move the call to QUEUE) before the ~0.5s accept round-trip returns; an
    // unguarded write would then revert it to IN_PROGRESS/IVR permanently.
    async markIvrAutoAccepted(callId) {
        const [result] = await connection.execute(
            `UPDATE calls SET status = 'IN_PROGRESS', state = 'IVR', updated_at = NOW()
             WHERE id = ? AND state = 'IVR'`,
            [callId]
        );
        return result.affectedRows > 0;
    }

    async updateProviderCallId(callId, providerCallId) {
        await connection.execute(
            'UPDATE calls SET provider_call_id = ?, updated_at = NOW() WHERE id = ?',
            [providerCallId, callId]
        );
    }

    async updateQueue(callId, queueId) {
        await connection.execute('UPDATE calls SET queue_id = ?, updated_at = NOW() WHERE id = ?', [queueId, callId]);
    }

    async updateTimestamp(callId, field, timestamp = null) {
        const validFields = ['ringing_at', 'answered_at', 'ended_at'];
        if (!validFields.includes(field)) {
            throw new Error(`Invalid timestamp field: ${field}`);
        }
        const value = timestamp || new Date();
        await connection.execute(`UPDATE calls SET ${field} = ?, updated_at = NOW() WHERE id = ?`, [value, callId]);

        // answered_at can arrive from several independent writers, any of which can
        // land after another already finalized the call as NO_ANSWER. NO_ANSWER must
        // never coexist with answered_at, so self-heal here. Best-effort: callers run
        // important logic right after this without their own try/catch.
        if (field === 'answered_at') {
            await this.correctNoAnswerIfAnswered(callId).catch((err) =>
                console.error(`[CallRepository] correctNoAnswerIfAnswered failed for call ${callId}:`, err)
            );
        }
    }

    async updateDuration(callId, field, value = 0) {
        const validFields = ['ringing_duration', 'call_duration', 'queue_duration', 'on_hold_duration'];
        if (!validFields.includes(field)) {
            throw new Error(`Invalid duration field: ${field}`);
        }
        await connection.execute(`UPDATE calls SET ${field} = ?, updated_at = NOW() WHERE id = ?`, [value, callId]);
    }

    async updateFailureDetails(callId, failureDetails) {
        await connection.execute(
            'UPDATE calls SET failure_details = ?, updated_at = NOW() WHERE id = ?',
            [JSON.stringify(failureDetails), callId]
        );
    }

    // Patches terminated_by on an already-FAILED row when the provider's terminate
    // webhook arrives after a local detection path already set FAILED.
    async updateTerminatedByIfFailed(callId, terminatedBy) {
        await connection.execute(
            `UPDATE calls SET terminated_by = ?, updated_at = NOW() WHERE id = ? AND status = 'FAILED'`,
            [terminatedBy, callId]
        );
    }

    async updateMetadata(callId, metadata = null) {
        const [result] = await connection.execute(
            'UPDATE calls SET metadata = ?, updated_at = NOW() WHERE id = ?',
            [metadata ? JSON.stringify(metadata) : null, callId]
        );
        return result.affectedRows > 0;
    }

    async updateConsumerFields(callId, { externalRef, consumerMetadata }) {
        const sets = [];
        const params = [];
        if (externalRef !== undefined) { sets.push('external_ref = ?'); params.push(externalRef); }
        if (consumerMetadata !== undefined) {
            sets.push('consumer_metadata = ?');
            params.push(consumerMetadata == null ? null : JSON.stringify(consumerMetadata));
        }
        if (!sets.length) return false;
        const [result] = await connection.execute(
            `UPDATE calls SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
            [...params, callId]
        );
        return result.affectedRows > 0;
    }

    async updateCallAgentIfCurrent(callId, oldAgentId, newAgentId) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET agent_id = ?, updated_at = NOW()
             WHERE id = ?
             AND agent_id <=> ?
             AND status IN ${ACTIVE_STATUSES}
             AND (state IS NULL OR state != 'IVR')`,
            [newAgentId, callId, oldAgentId]
        );
        return result.affectedRows > 0;
    }

    // ── Assignment ───────────────────────────────────────────────────────────────

    async assignCallToAgentIfUnassigned(callId, agentId) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET agent_id = ?, updated_at = NOW()
             WHERE id = ?
             AND agent_id IS NULL
             AND status = 'RINGING'
             AND direction = 'INBOUND'
             AND (state IS NULL OR state != 'IVR')`,
            [agentId, callId]
        );
        return result.affectedRows > 0;
    }

    async assignCallToAgentIfEligible(callId, agentId) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET agent_id = ?, updated_at = NOW()
             WHERE id = ?
             AND status IN ${ACTIVE_STATUSES}
             AND (agent_id IS NULL OR agent_id = ?)
             AND (state IS NULL OR state != 'IVR')`,
            [agentId, callId, agentId]
        );
        return result.affectedRows > 0;
    }

    async hasAgentActiveCall(agentId, excludeCallId) {
        const [rows] = await connection.execute(
            `SELECT 1 FROM calls
             WHERE agent_id = ? AND id != ? AND status IN ${ACTIVE_STATUSES}
             LIMIT 1`,
            [agentId, excludeCallId]
        );
        return rows.length > 0;
    }

    // An older RINGING call already assigned to this agent (id < excludeCallId) —
    // used by delivery to detect a race double-assignment and suppress the later one.
    async getConflictingRingingCallId(agentId, excludeCallId) {
        const [rows] = await connection.execute(
            `SELECT id FROM calls
             WHERE agent_id = ? AND id < ? AND status = 'RINGING'
             ORDER BY id DESC LIMIT 1`,
            [agentId, excludeCallId]
        );
        return rows.length > 0 ? rows[0].id : null;
    }

    // ── Termination & Finalization ───────────────────────────────────────────────

    #failureDetails(errors, providerCallbackData) {
        const details = {};
        if (errors) details.errors = errors;
        if (providerCallbackData) details.provider_callback_data = providerCallbackData;
        return Object.keys(details).length ? JSON.stringify(details) : null;
    }

    async markCallFailed(callId, errors = null, providerCallbackData = null, reason = 'PROVIDER_ERROR', terminatedBy = 'SYSTEM') {
        await connection.execute(
            `UPDATE calls
             SET status = 'FAILED', state = NULL,
                 termination_reason = ?, terminated_by = ?, failure_details = ?,
                 ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
             WHERE id = ?`,
            [reason, terminatedBy, this.#failureDetails(errors, providerCallbackData), callId]
        );
    }

    async markCallFailedIfNotFinal(callId, errors = null, providerCallbackData = null, reason = 'PROVIDER_ERROR', terminatedBy = 'SYSTEM') {
        const [result] = await connection.execute(
            `UPDATE calls
             SET status = 'FAILED', state = NULL,
                 termination_reason = ?, terminated_by = ?, failure_details = ?,
                 ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
             WHERE id = ? AND status NOT IN ('TERMINATED', 'FAILED')`,
            [reason, terminatedBy, this.#failureDetails(errors, providerCallbackData), callId]
        );
        return result.affectedRows > 0;
    }

    async terminateCall(callId, terminationReason = null, terminatedBy = 'AGENT', endedAt = null) {
        await this.terminateCallIfNotTerminated(callId, terminationReason, terminatedBy, endedAt);
    }

    // Returns true if this call caused the status transition — for callers that
    // need to know whether they "won" the race to terminate the call.
    async terminateCallIfNotTerminated(callId, terminationReason = null, terminatedBy = 'AGENT', endedAt = null) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET status = 'TERMINATED', state = NULL,
                 termination_reason = ?, terminated_by = ?,
                 ended_at = COALESCE(?, NOW()), updated_at = NOW()
             WHERE id = ? AND status NOT IN ('TERMINATED', 'FAILED')`,
            [terminationReason, terminatedBy, endedAt, callId]
        );
        return result.affectedRows > 0;
    }

    // NO_ANSWER with a non-null answered_at is a contradiction (a late ACCEPTED
    // proved the call was answered) — flip it to COMPLETED.
    async correctNoAnswerIfAnswered(callId) {
        const [result] = await connection.execute(
            `UPDATE calls
             SET termination_reason = 'COMPLETED', updated_at = NOW()
             WHERE id = ? AND status = 'TERMINATED'
               AND termination_reason = 'NO_ANSWER' AND answered_at IS NOT NULL`,
            [callId]
        );
        return result.affectedRows > 0;
    }

    // Idempotent finalization driven by the provider's terminate event.
    //   Phase 1 always fills missing timestamps/durations (COALESCE) — late
    //   durations can still be patched onto an already-terminated row.
    //   Phase 2 is the guarded status flip, so side effects fire exactly once
    //   across racing handlers. terminated_by is COALESCE'd: whoever stamped it
    //   first (the agent hang-up path) wins.
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

        const [result] = await connection.execute(
            `UPDATE calls
             SET status             = ?,
                 state              = NULL,
                 termination_reason = COALESCE(termination_reason, ?),
                 terminated_by      = COALESCE(terminated_by, ?),
                 ended_at           = COALESCE(ended_at, NOW()),
                 updated_at = NOW()
             WHERE id = ? AND status NOT IN ('TERMINATED', 'FAILED')`,
            [status, terminationReason, terminatedBy, callId]
        );

        // Phase 1 may have just written answered_at onto a row a local path already
        // finalized as NO_ANSWER — correct that contradiction. Best-effort.
        await this.correctNoAnswerIfAnswered(callId).catch((err) =>
            console.error(`[CallRepository] correctNoAnswerIfAnswered failed for call ${callId}:`, err)
        );

        return result.affectedRows > 0;
    }

    // Finalize as FAILED/PROVIDER_ERROR. Distinct from finalizeFromWebhook:
    // the reason is force-written (a provider failure must not be masked by an
    // earlier COMPLETED/NO_ANSWER), and FAILED may upgrade a TERMINATED row since
    // the provider's ordering isn't guaranteed. Idempotent on already-FAILED rows.
    // Returns true iff this call caused the status transition.
    async finalizeCallAsFailed(callId, {
        terminatedBy = null,
        endedAt = null,
        answeredAt = null,
        callDuration = null,
        ringingDuration = null,
    } = {}) {
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

        const [result] = await connection.execute(
            `UPDATE calls
             SET status             = 'FAILED',
                 state              = NULL,
                 termination_reason = 'PROVIDER_ERROR',
                 terminated_by      = COALESCE(terminated_by, ?),
                 ended_at           = COALESCE(ended_at, NOW()),
                 updated_at = NOW()
             WHERE id = ? AND status != 'FAILED'`,
            [terminatedBy, callId]
        );
        return result.affectedRows > 0;
    }

    // ── Batch ────────────────────────────────────────────────────────────────────

    // Terminates a batch of calls. Never overwrites calls already finalized.
    // `requireStatus` (opt-in) additionally requires each call to still be in
    // that status — the periodic NO_ANSWER sweep passes 'RINGING' so a genuine
    // accept landing between its scan and this UPDATE isn't wiped back to
    // TERMINATED. Returns the ids that actually ended up TERMINATED; callers
    // emitting per-call events must use that list, not the input.
    async batchTerminateCalls(callIds, terminationReason, terminatedBy, requireStatus = null) {
        if (!callIds || callIds.length === 0) return [];

        const placeholders = callIds.map(() => '?').join(', ');
        const statusGuard = requireStatus ? 'AND status = ?' : '';

        await connection.execute(
            `UPDATE calls
             SET status = 'TERMINATED', state = NULL,
                 termination_reason = ?, terminated_by = ?,
                 ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
             WHERE id IN (${placeholders})
               AND status NOT IN ('TERMINATED', 'FAILED')
               ${statusGuard}`,
            requireStatus
                ? [terminationReason, terminatedBy, ...callIds, requireStatus]
                : [terminationReason, terminatedBy, ...callIds]
        );

        if (!requireStatus) return callIds;

        const [rows] = await connection.execute(
            `SELECT id FROM calls WHERE id IN (${placeholders}) AND status = 'TERMINATED'`,
            callIds
        );
        return rows.map(r => r.id);
    }
}

export default new CallRepository();
