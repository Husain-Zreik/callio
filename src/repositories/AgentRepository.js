// src/repositories/AgentRepository.js
import connection from '../../config/dbConnection.js';

class AgentRepository {
    // ── Queries ─────────────────────────────────────────────────────────────────

    async getCallCenterAgents(businessId) {
        const [rows] = await connection.execute(`
            SELECT DISTINCT u.id, u.name, u.email, u.call_availability
            FROM users u
            JOIN model_has_roles mhr ON mhr.model_id = u.id
                AND mhr.model_type = 'App\\\\Models\\\\User'
                AND mhr.business_id = ?
             JOIN role_has_permissions rhp ON rhp.role_id = mhr.role_id
             JOIN permissions p ON p.id = rhp.permission_id
             WHERE u.business_id = ?
            AND u.deleted_at IS NULL
            AND p.name = 'call_center_agent_access'
            ORDER BY u.id ASC
        `, [businessId, businessId]);
        return rows;
    }

    async getCallCenterManagers(businessId) {
        const [rows] = await connection.execute(`
            SELECT DISTINCT u.id, u.name, u.email, u.call_availability
            FROM users u
            JOIN model_has_roles mhr ON mhr.model_id = u.id
                AND mhr.model_type = 'App\\\\Models\\\\User'
                AND mhr.business_id = ?
             JOIN role_has_permissions rhp ON rhp.role_id = mhr.role_id
             JOIN permissions p ON p.id = rhp.permission_id
             WHERE u.business_id = ?
            AND u.deleted_at IS NULL
            AND p.name = 'call_center_manager_access'
        `, [businessId, businessId]);
        return rows;
    }

    async getUsersWithCallShowPermission(businessId) {
        const [rows] = await connection.execute(`
            SELECT DISTINCT u.id, u.name, u.email, u.call_availability
            FROM users u
            JOIN model_has_roles mhr ON mhr.model_id = u.id
                AND mhr.model_type = 'App\\\\Models\\\\User'
                AND mhr.business_id = ?
             JOIN role_has_permissions rhp ON rhp.role_id = mhr.role_id
             JOIN permissions p ON p.id = rhp.permission_id
             WHERE u.business_id = ?
            AND u.deleted_at IS NULL
            AND p.name = 'call_show'
        `, [businessId, businessId]);
        return rows;
    }

    async resolveTransferInitiatorType(businessId, userId) {
        if (!businessId || !userId) {
            return 'system';
        }

        const [rows] = await connection.execute(`
            SELECT p.name
            FROM model_has_roles mhr
            JOIN role_has_permissions rhp ON rhp.role_id = mhr.role_id
            JOIN permissions p ON p.id = rhp.permission_id
            WHERE mhr.model_type = 'App\\\\Models\\\\User'
              AND mhr.business_id = ?
              AND mhr.model_id = ?
              AND p.name IN ('call_center_manager_access', 'call_center_agent_access')
        `, [businessId, userId]);

        const permissionNames = new Set(rows.map((row) => row.name));
        if (permissionNames.has('call_center_manager_access')) return 'manager';
        if (permissionNames.has('call_center_agent_access')) return 'agent';

        return 'system';
    }

    async findUserById(userId) {
        const [rows] = await connection.execute(
            'SELECT id, name, email, call_availability FROM users WHERE id = ?',
            [userId]
        );
        return rows[0] || null;
    }

    async getUserBusinessId(userId) {
        const [rows] = await connection.execute(
            'SELECT business_id FROM users WHERE id = ? LIMIT 1',
            [userId]
        );
        return rows[0]?.business_id || null;
    }

    async getUserNameById(userId, businessId) {
        if (!userId) return null;
        const [rows] = await connection.execute(
            'SELECT name FROM users WHERE id = ? AND business_id = ? LIMIT 1',
            [userId, businessId]
        );
        return rows[0]?.name || null;
    }

    async getUserNamesByIds(userIds, businessId) {
        if (!userIds || userIds.length === 0) return new Map();
        const placeholders = userIds.map(() => '?').join(',');
        const [rows] = await connection.execute(
            `SELECT id, name FROM users WHERE id IN (${placeholders}) AND business_id = ?`,
            [...userIds, businessId]
        );
        return new Map(rows.map(r => [String(r.id), r.name ?? null]));
    }

    // ── Availability ─────────────────────────────────────────────────────────────

    async updateAgentAvailability(userId, status) {
        const [result] = await connection.execute(
            'UPDATE users SET call_availability = ?, updated_at = NOW() WHERE id = ?',
            [status, userId]
        );
        return result.affectedRows > 0;
    }

    async setAgentAvailableIfNoActiveCalls(userId) {
        const [result] = await connection.execute(
            `UPDATE users u
             SET u.call_availability = 'AVAILABLE',
                 u.updated_at = NOW()
             WHERE u.id = ?
             AND u.call_availability = 'ON_CALL'
             AND NOT EXISTS (
                 SELECT 1
                 FROM calls c
                 WHERE c.user_id = u.id
                 AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
             )`,
            [userId]
        );
        return result.affectedRows > 0;
    }

    async setAgentOfflineIfNoActiveCalls(userId) {
        const [result] = await connection.execute(
            `UPDATE users u
             SET u.call_availability = 'OFFLINE',
                 u.updated_at = NOW()
             WHERE u.id = ?
             AND u.call_availability = 'ON_CALL'
             AND NOT EXISTS (
                 SELECT 1
                 FROM calls c
                 WHERE c.user_id = u.id
                 AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
             )`,
            [userId]
        );
        return result.affectedRows > 0;
    }

    async batchUpdateAgentAvailability(agentIds, availability) {
        if (!agentIds || agentIds.length === 0) return;

        const uniqueAgentIds = [...new Set(agentIds)];
        const placeholders = uniqueAgentIds.map(() => '?').join(', ');

        // When releasing to AVAILABLE, skip agents who still have an active call on a
        // different channel — the cleanup service may batch-release agents after terminating
        // a stuck RINGING call while those same agents are already on a separate IN_PROGRESS call.
        const notExistsClause = availability === 'AVAILABLE'
            ? `AND NOT EXISTS (
                   SELECT 1 FROM calls c
                   WHERE c.user_id = users.id
                   AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
               )`
            : '';

        await connection.execute(
            `UPDATE users
             SET call_availability = ?,
                 updated_at = NOW()
             WHERE id IN (${placeholders})
             ${notExistsClause}`,
            [availability, ...uniqueAgentIds]
        );
    }

    // Returns availability stats for all call-center agents in the business.
    // Used by IVR trigger condition evaluation.
    // Returns { total, available, on_call, offline }.
    async getAvailabilityStats(businessId) {
        const [rows] = await connection.execute(
            `SELECT u.call_availability, COUNT(*) AS cnt
             FROM users u
             JOIN model_has_roles mhr
               ON mhr.model_id = u.id
              AND mhr.model_type = 'App\\\\Models\\\\User'
              AND mhr.business_id = ?
             JOIN role_has_permissions rhp ON rhp.role_id = mhr.role_id
             JOIN permissions p ON p.id = rhp.permission_id
             WHERE u.business_id = ?
               AND u.deleted_at IS NULL
               AND p.name = 'call_center_agent_access'
             GROUP BY u.call_availability`,
            [businessId, businessId]
        );

        const stats = { total: 0, available: 0, on_call: 0, offline: 0 };
        for (const row of rows) {
            const count = Number(row.cnt);
            stats.total += count;
            const av = (row.call_availability ?? '').toUpperCase();
            if (av === 'AVAILABLE')  stats.available += count;
            else if (av === 'ON_CALL') stats.on_call += count;
            else                       stats.offline  += count;
        }
        return stats;
    }

    // Returns availability stats for a specific set of agent IDs.
    // Returns { total, available, on_call, offline }.
    async getAvailabilityStatsForAgentIds(agentIds = [], businessId = null) {
        const uniqueAgentIds = [...new Set(
            (agentIds || [])
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id))
        )];

        if (!uniqueAgentIds.length) {
            return { total: 0, available: 0, on_call: 0, offline: 0 };
        }

        const placeholders = uniqueAgentIds.map(() => '?').join(',');
        const params = [...uniqueAgentIds];
        let businessFilter = '';

        if (Number.isFinite(Number(businessId))) {
            businessFilter = 'AND u.business_id = ?';
            params.push(Number(businessId));
        }

        const [rows] = await connection.execute(
            `SELECT u.call_availability, COUNT(*) AS cnt
             FROM users u
             WHERE u.id IN (${placeholders})
               AND u.deleted_at IS NULL
               ${businessFilter}
             GROUP BY u.call_availability`,
            params
        );

        const stats = { total: 0, available: 0, on_call: 0, offline: 0 };
        for (const row of rows) {
            const count = Number(row.cnt);
            stats.total += count;
            const av = (row.call_availability ?? '').toUpperCase();
            if (av === 'AVAILABLE') stats.available += count;
            else if (av === 'ON_CALL') stats.on_call += count;
            else stats.offline += count;
        }
        return stats;
    }

    // ── Atomic Operations ────────────────────────────────────────────────────────

    // Atomically claim an agent and assign a queued call in a single transaction.
    // Returns { claimed, assigned }:
    //   claimed=false: agent is not AVAILABLE (give up)
    //   claimed=true, assigned=false: call was taken by another worker (retry with next call)
    //   claimed=true, assigned=true: success
    async claimAgentAndAssignCall(userId, callId) {
        const conn = await connection.getConnection();
        try {
            await conn.beginTransaction();

            const [agentResult] = await conn.execute(
                `UPDATE users
                 SET call_availability = 'ON_CALL', updated_at = NOW()
                 WHERE id = ?
                 AND call_availability = 'AVAILABLE'
                 AND NOT EXISTS (
                     SELECT 1
                     FROM calls c
                     WHERE c.user_id = users.id
                     AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
                 )`,
                [userId]
            );

            if (agentResult.affectedRows === 0) {
                await conn.rollback();
                return { claimed: false, assigned: false };
            }

            const [callResult] = await conn.execute(
                `UPDATE calls
                 SET user_id = ?, updated_at = NOW()
                 WHERE id = ?
                 AND user_id IS NULL
                 AND status = 'RINGING'
                 AND direction = 'INBOUND'
                 AND (state IS NULL OR state != 'IVR')`,
                [userId, callId]
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

    async claimAgentIfAvailable(userId) {
        const [result] = await connection.execute(
            `UPDATE users
             SET call_availability = 'ON_CALL', updated_at = NOW()
             WHERE id = ?
             AND call_availability = 'AVAILABLE'
             AND NOT EXISTS (
                 SELECT 1
                 FROM calls c
                 WHERE c.user_id = users.id
                 AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
             )`,
            [userId]
        );
        return result.affectedRows > 0;
    }

    // Check the availability of an IVR transfer target.
    // targetType: 'queue'|'agent'|'group'; targetId: null for queue.
    // Returns 'available' (at least one agent AVAILABLE), 'busy' (all ON_CALL), or 'offline'.
    async checkTargetAvailability(targetType, targetId, businessId) {
        let agentIds = [];

        if (targetType === 'queue') {
            const agents = await this.getCallCenterAgents(businessId);
            agentIds = agents.map((a) => a.id);

        } else if (targetType === 'agent') {
            agentIds = targetId ? [Number(targetId)] : [];

        } else if (targetType === 'group') {
            if (!targetId) return 'offline';
            const [rows] = await connection.execute(
                `SELECT user_id FROM user_group_members WHERE group_id = ?`,
                [Number(targetId)]
            );
            agentIds = rows.map((r) => r.user_id);
        }

        if (agentIds.length === 0) return 'offline';

        const placeholders = agentIds.map(() => '?').join(',');
        const [statuses] = await connection.execute(
            `SELECT call_availability FROM users WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
            agentIds
        );

        if (statuses.some((r) => r.call_availability === 'AVAILABLE')) return 'available';
        if (statuses.some((r) => r.call_availability === 'ON_CALL'))   return 'busy';
        return 'offline';
    }
}

export default new AgentRepository();
