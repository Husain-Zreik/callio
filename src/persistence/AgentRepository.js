// src/persistence/AgentRepository.js
// Agents, their shift (availability) and the call holding them (busy_call_id).
//
// Two separate facts (docs/direct-lines.md, A1):
//   availability   the shift, AVAILABLE / OFFLINE: set by the agent, the API,
//                  auto-offline. Only queues read it.
//   busy_call_id   the call holding the agent: claimed with a guarded update
//                  (busy_call_id IS NULL), released only by that call. The row
//                  is the lock that stops two routes claiming one agent.
// Reads report one status, as the contract always did: ON_CALL while busy,
// else the shift (reportedAvailability).
import connection from '../../config/dbConnection.js';

// The status an agent reports. 'ON_CALL' in the availability column is the
// value the code before busy_call_id wrote; a worker still running it during a
// deploy can write it, so it reads as the AVAILABLE shift until a later
// migration drops the value.
export const reportedAvailability = (alias = 'agents') =>
    `CASE WHEN ${alias}.busy_call_id IS NOT NULL THEN 'ON_CALL'
          WHEN ${alias}.availability = 'OFFLINE' THEN 'OFFLINE'
          ELSE 'AVAILABLE' END`;

const ON_SHIFT = `availability IN ('AVAILABLE', 'ON_CALL')`;

const AGENT_COLUMNS = `id, tenant_id, external_ref, name, role, ${reportedAvailability()} AS availability, busy_call_id`;

// No other call the agent is on (any active status). Kept next to the
// busy_call_id guard: an outbound intent not started yet (INITIATED) has the
// agent on it without holding them.
const noOtherActiveCall = (excludeCallParam = false) => `NOT EXISTS (
    SELECT 1 FROM calls c
    WHERE c.agent_id = agents.id
    AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
    ${excludeCallParam ? 'AND c.id != ?' : ''}
)`;

function emptyStats() {
    return { total: 0, available: 0, on_call: 0, offline: 0 };
}

function tallyStats(rows) {
    const stats = emptyStats();
    for (const row of rows) {
        const count = Number(row.cnt);
        stats.total += count;
        if (row.availability === 'AVAILABLE') stats.available += count;
        else if (row.availability === 'ON_CALL') stats.on_call += count;
        else stats.offline += count;
    }
    return stats;
}

class AgentRepository {
    // ── Lookups ─────────────────────────────────────────────────────────────────

    async findById(agentId) {
        const [rows] = await connection.execute(
            `SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [agentId]
        );
        return rows[0] ?? null;
    }

    async findByExternalRef(tenantId, externalRef) {
        const [rows] = await connection.execute(
            `SELECT ${AGENT_COLUMNS} FROM agents
             WHERE tenant_id = ? AND external_ref = ? AND deleted_at IS NULL LIMIT 1`,
            [tenantId, externalRef]
        );
        return rows[0] ?? null;
    }

    async findByIds(agentIds) {
        if (!agentIds?.length) return [];
        const placeholders = agentIds.map(() => '?').join(',');
        const [rows] = await connection.execute(
            `SELECT ${AGENT_COLUMNS} FROM agents WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
            agentIds
        );
        return rows;
    }

    async getTenantAgents(tenantId) {
        const [rows] = await connection.execute(
            `SELECT ${AGENT_COLUMNS} FROM agents WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY id ASC`,
            [tenantId]
        );
        return rows;
    }

    async getSupervisors(tenantId) {
        const [rows] = await connection.execute(
            `SELECT ${AGENT_COLUMNS} FROM agents
             WHERE tenant_id = ? AND role = 'SUPERVISOR' AND deleted_at IS NULL ORDER BY id ASC`,
            [tenantId]
        );
        return rows;
    }

    async getTenantId(agentId) {
        const [rows] = await connection.execute('SELECT tenant_id FROM agents WHERE id = ?', [agentId]);
        return rows[0]?.tenant_id ?? null;
    }

    async getNameById(agentId) {
        const [rows] = await connection.execute('SELECT name FROM agents WHERE id = ?', [agentId]);
        return rows[0]?.name ?? null;
    }

    async getNamesByIds(agentIds) {
        if (!agentIds?.length) return new Map();
        const placeholders = agentIds.map(() => '?').join(',');
        const [rows] = await connection.execute(
            `SELECT id, name FROM agents WHERE id IN (${placeholders})`,
            agentIds
        );
        return new Map(rows.map((r) => [String(r.id), r.name ?? null]));
    }

    // ── Provisioning ────────────────────────────────────────────────────────────

    // Create or update an agent by the consumer's reference. `role` is applied
    // only when given; `restore` un-deletes a soft-deleted agent.
    async upsert(tenantId, externalRef, { name, role = null }) {
        await connection.execute(
            `INSERT INTO agents (tenant_id, external_ref, name, role, availability, created_at, updated_at)
             VALUES (?, ?, ?, COALESCE(?, 'AGENT'), 'OFFLINE', NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                 name = VALUES(name),
                 role = COALESCE(?, role),
                 deleted_at = NULL,
                 updated_at = NOW()`,
            [tenantId, externalRef, name, role, role]
        );
        const [rows] = await connection.execute(
            `SELECT ${AGENT_COLUMNS} FROM agents WHERE tenant_id = ? AND external_ref = ? LIMIT 1`,
            [tenantId, externalRef]
        );
        return rows[0] ?? null;
    }

    async softDelete(tenantId, externalRef) {
        const [result] = await connection.execute(
            `UPDATE agents SET deleted_at = NOW(), availability = 'OFFLINE', busy_call_id = NULL, updated_at = NOW()
             WHERE tenant_id = ? AND external_ref = ? AND deleted_at IS NULL`,
            [tenantId, externalRef]
        );
        return result.affectedRows > 0;
    }

    // ── Shift ───────────────────────────────────────────────────────────────────

    // Sets the shift (AVAILABLE / OFFLINE). Doesn't touch busy_call_id.
    async updateAgentAvailability(agentId, availability) {
        const [result] = await connection.execute(
            `UPDATE agents SET availability = ?, availability_changed_at = NOW(), updated_at = NOW()
             WHERE id = ? AND deleted_at IS NULL`,
            [availability, agentId]
        );
        return result.affectedRows > 0;
    }

    // Counts by reported status over the given agents. Returns { total, available, on_call, offline }.
    async getAvailabilityStatsForAgentIds(agentIds = []) {
        const ids = [...new Set((agentIds || []).map(Number).filter(Number.isFinite))];
        if (!ids.length) return emptyStats();
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await connection.execute(
            `SELECT ${reportedAvailability()} AS availability, COUNT(*) AS cnt FROM agents
             WHERE id IN (${placeholders}) AND deleted_at IS NULL
             GROUP BY 1`,
            ids
        );
        return tallyStats(rows);
    }

    async getTenantAvailabilityStats(tenantId) {
        const [rows] = await connection.execute(
            `SELECT ${reportedAvailability()} AS availability, COUNT(*) AS cnt FROM agents
             WHERE tenant_id = ? AND deleted_at IS NULL
             GROUP BY 1`,
            [tenantId]
        );
        return tallyStats(rows);
    }

    // ── Busy: claims and releases ───────────────────────────────────────────────

    // Claim an on-shift agent for a waiting inbound call and assign it, in one
    // transaction.
    //   { claimed: false }                  agent not free — give up
    //   { claimed: true, assigned: false }  call taken by another worker — try the next call
    //   { claimed: true, assigned: true }   success
    async claimAgentAndAssignCall(agentId, callId) {
        const conn = await connection.getConnection();
        try {
            await conn.beginTransaction();

            const [agentResult] = await conn.execute(
                `UPDATE agents SET busy_call_id = ?, updated_at = NOW()
                 WHERE id = ? AND busy_call_id IS NULL AND ${ON_SHIFT} AND deleted_at IS NULL AND ${noOtherActiveCall()}`,
                [callId, agentId]
            );
            if (agentResult.affectedRows === 0) {
                await conn.rollback();
                return { claimed: false, assigned: false };
            }

            const [callResult] = await conn.execute(
                `UPDATE calls
                 SET agent_id = ?, offered_at = NOW(), updated_at = NOW()
                 WHERE id = ?
                 AND agent_id IS NULL
                 AND status = 'RINGING'
                 AND direction = 'INBOUND'
                 AND (state IS NULL OR state != 'IVR')`,
                [agentId, callId]
            );
            if (callResult.affectedRows === 0) {
                await conn.rollback();
                return { claimed: true, assigned: false };
            }

            await conn.commit();
            return { claimed: true, assigned: true };
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    }

    // Claim an on-shift agent for a call that is already theirs to take (a
    // transfer target). The caller moves the call to them next.
    async claimAgentForCall(agentId, callId) {
        const [result] = await connection.execute(
            `UPDATE agents SET busy_call_id = ?, updated_at = NOW()
             WHERE id = ? AND busy_call_id IS NULL AND ${ON_SHIFT} AND deleted_at IS NULL AND ${noOtherActiveCall()}`,
            [callId, agentId]
        );
        return result.affectedRows > 0;
    }

    // The agent starts a call that is already theirs — a RING_ALL accept or an
    // outbound call:start — whatever their shift: only while that call is still
    // active and theirs, and they're on no other. A hang-up racing the end of
    // the accept flow releases the agent first; holding them again would strand
    // them busy. Returns true when this call now holds them (also when it
    // already did).
    async holdForOwnCall(agentId, callId) {
        const [result] = await connection.execute(
            `UPDATE agents SET busy_call_id = ?, updated_at = NOW()
             WHERE id = ? AND (busy_call_id IS NULL OR busy_call_id = ?) AND deleted_at IS NULL
               AND ${noOtherActiveCall(true)}
               AND EXISTS (
                   SELECT 1 FROM calls c
                   WHERE c.id = ? AND c.agent_id = agents.id
                     AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
               )`,
            [callId, agentId, callId, callId, callId]
        );
        if (result.affectedRows > 0) return true;
        const [rows] = await connection.execute('SELECT busy_call_id FROM agents WHERE id = ?', [agentId]);
        return String(rows[0]?.busy_call_id) === String(callId);
    }

    // Releases the agent from this call only: a release for a call that no
    // longer holds them (already released, or they moved on) does nothing.
    async releaseFromCall(agentId, callId) {
        const [result] = await connection.execute(
            `UPDATE agents SET busy_call_id = NULL, updated_at = NOW()
             WHERE id = ? AND busy_call_id = ?`,
            [agentId, callId]
        );
        return result.affectedRows > 0;
    }

    // Agents held by a call that has ended or no longer exists — what a missed
    // release leaves behind. Uses the busy_call_id index, so it reads only busy
    // agents.
    async findHeldByEndedCalls(limit = 200) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
        const [rows] = await connection.execute(
            `SELECT a.id, a.tenant_id, a.busy_call_id FROM agents a
             LEFT JOIN calls c ON c.id = a.busy_call_id
             WHERE a.busy_call_id IS NOT NULL
               AND (c.id IS NULL OR c.status NOT IN ('INITIATED', 'RINGING', 'IN_PROGRESS'))
             LIMIT ${safeLimit}`
        );
        return rows;
    }
}

export default new AgentRepository();
