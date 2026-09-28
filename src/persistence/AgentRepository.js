// src/persistence/AgentRepository.js
// Agents and their live availability (AVAILABLE / ON_CALL / OFFLINE).
import connection from '../../config/dbConnection.js';

const AGENT_COLUMNS = 'id, tenant_id, external_ref, name, role, availability';

// No other call the agent is on (any active status).
const NO_ACTIVE_CALL = `NOT EXISTS (
    SELECT 1 FROM calls c
    WHERE c.agent_id = agents.id
    AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
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
            `UPDATE agents SET deleted_at = NOW(), availability = 'OFFLINE', updated_at = NOW()
             WHERE tenant_id = ? AND external_ref = ? AND deleted_at IS NULL`,
            [tenantId, externalRef]
        );
        return result.affectedRows > 0;
    }

    // ── Availability ────────────────────────────────────────────────────────────

    async updateAgentAvailability(agentId, availability) {
        const [result] = await connection.execute(
            `UPDATE agents SET availability = ?, availability_changed_at = NOW(), updated_at = NOW()
             WHERE id = ? AND deleted_at IS NULL`,
            [availability, agentId]
        );
        return result.affectedRows > 0;
    }

    async setAgentAvailableIfNoActiveCalls(agentId) {
        const [result] = await connection.execute(
            `UPDATE agents
             SET availability = 'AVAILABLE', availability_changed_at = NOW(), updated_at = NOW()
             WHERE id = ? AND availability = 'ON_CALL' AND ${NO_ACTIVE_CALL}`,
            [agentId]
        );
        return result.affectedRows > 0;
    }

    async setAgentOfflineIfNoActiveCalls(agentId) {
        const [result] = await connection.execute(
            `UPDATE agents
             SET availability = 'OFFLINE', availability_changed_at = NOW(), updated_at = NOW()
             WHERE id = ? AND availability = 'ON_CALL' AND ${NO_ACTIVE_CALL}`,
            [agentId]
        );
        return result.affectedRows > 0;
    }

    // When releasing to AVAILABLE, skips agents still on another active call —
    // cleanup may batch-release agents of a stuck RINGING call who are already
    // on a separate IN_PROGRESS call.
    async batchUpdateAgentAvailability(agentIds, availability) {
        if (!agentIds || agentIds.length === 0) return;
        const unique = [...new Set(agentIds)];
        const placeholders = unique.map(() => '?').join(', ');
        const guard = availability === 'AVAILABLE' ? `AND ${NO_ACTIVE_CALL}` : '';
        await connection.execute(
            `UPDATE agents
             SET availability = ?, availability_changed_at = NOW(), updated_at = NOW()
             WHERE id IN (${placeholders}) ${guard}`,
            [availability, ...unique]
        );
    }

    // Counts by availability over the given agents. Returns { total, available, on_call, offline }.
    async getAvailabilityStatsForAgentIds(agentIds = []) {
        const ids = [...new Set((agentIds || []).map(Number).filter(Number.isFinite))];
        if (!ids.length) return emptyStats();
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await connection.execute(
            `SELECT availability, COUNT(*) AS cnt FROM agents
             WHERE id IN (${placeholders}) AND deleted_at IS NULL
             GROUP BY availability`,
            ids
        );
        return tallyStats(rows);
    }

    async getTenantAvailabilityStats(tenantId) {
        const [rows] = await connection.execute(
            `SELECT availability, COUNT(*) AS cnt FROM agents
             WHERE tenant_id = ? AND deleted_at IS NULL
             GROUP BY availability`,
            [tenantId]
        );
        return tallyStats(rows);
    }

    // ── Atomic claims ───────────────────────────────────────────────────────────

    // Claim an agent and assign a queued call in one transaction.
    //   { claimed: false }                  agent not AVAILABLE — give up
    //   { claimed: true, assigned: false }  call taken by another worker — try the next call
    //   { claimed: true, assigned: true }   success
    async claimAgentAndAssignCall(agentId, callId) {
        const conn = await connection.getConnection();
        try {
            await conn.beginTransaction();

            const [agentResult] = await conn.execute(
                `UPDATE agents
                 SET availability = 'ON_CALL', availability_changed_at = NOW(), updated_at = NOW()
                 WHERE id = ? AND availability = 'AVAILABLE' AND deleted_at IS NULL AND ${NO_ACTIVE_CALL}`,
                [agentId]
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

    async claimAgentIfAvailable(agentId) {
        const [result] = await connection.execute(
            `UPDATE agents
             SET availability = 'ON_CALL', availability_changed_at = NOW(), updated_at = NOW()
             WHERE id = ? AND availability = 'AVAILABLE' AND deleted_at IS NULL AND ${NO_ACTIVE_CALL}`,
            [agentId]
        );
        return result.affectedRows > 0;
    }

    // RING_ALL accept: the call was offered without claiming anyone, so the
    // accepting agent is flipped ON_CALL here — but only while that call is
    // still active and theirs. A hang-up racing the end of the accept flow
    // releases the agent first; flipping them back would strand them ON_CALL.
    async markOnCall(agentId, callId) {
        const [result] = await connection.execute(
            `UPDATE agents SET availability = 'ON_CALL', availability_changed_at = NOW(), updated_at = NOW()
             WHERE id = ? AND availability != 'ON_CALL' AND deleted_at IS NULL
               AND EXISTS (
                   SELECT 1 FROM calls c
                   WHERE c.id = ? AND c.agent_id = agents.id
                     AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
               )`,
            [agentId, callId]
        );
        return result.affectedRows > 0;
    }
}

export default new AgentRepository();
