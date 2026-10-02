// src/persistence/QueueRepository.js
// Queues and their members — where inbound calls wait for an agent.
import connection from '../../config/dbConnection.js';
import { reportedAvailability } from './AgentRepository.js';

const QUEUE_COLUMNS = `id, tenant_id, external_ref, name, strategy, ring_timeout_seconds,
    max_active_calls, max_wait_seconds, overflow_queue_id, hold_audio_asset_id, status`;

class QueueRepository {
    async findById(queueId) {
        if (!queueId) return null;
        const [rows] = await connection.execute(
            `SELECT ${QUEUE_COLUMNS} FROM queues WHERE id = ? LIMIT 1`,
            [queueId]
        );
        return rows[0] ?? null;
    }

    async findForTenant(queueId, tenantId) {
        if (!queueId) return null;
        const [rows] = await connection.execute(
            `SELECT ${QUEUE_COLUMNS} FROM queues WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [queueId, tenantId]
        );
        return rows[0] ?? null;
    }

    async findByExternalRef(tenantId, externalRef) {
        const [rows] = await connection.execute(
            `SELECT ${QUEUE_COLUMNS} FROM queues WHERE tenant_id = ? AND external_ref = ? LIMIT 1`,
            [tenantId, externalRef]
        );
        return rows[0] ?? null;
    }

    async listForTenant(tenantId) {
        const [rows] = await connection.execute(
            `SELECT ${QUEUE_COLUMNS} FROM queues WHERE tenant_id = ? ORDER BY id ASC`,
            [tenantId]
        );
        return rows;
    }

    // Members with their reported status (AgentRepository.reportedAvailability), in offer order: priority, then agent id.
    async getMembers(queueId) {
        const [rows] = await connection.execute(
            `SELECT a.id, a.tenant_id, a.external_ref, a.name, a.role, ${reportedAvailability('a')} AS availability, m.priority
             FROM queue_members m
             JOIN agents a ON a.id = m.agent_id
             WHERE m.queue_id = ? AND a.deleted_at IS NULL
             ORDER BY m.priority ASC, a.id ASC`,
            [queueId]
        );
        return rows;
    }

    async getMemberIds(queueId) {
        const [rows] = await connection.execute(
            'SELECT agent_id FROM queue_members WHERE queue_id = ?',
            [queueId]
        );
        return rows.map((r) => r.agent_id);
    }

    // Queues an agent belongs to — drained when the agent becomes available.
    async getQueueIdsForAgent(agentId) {
        const [rows] = await connection.execute(
            `SELECT m.queue_id FROM queue_members m
             JOIN queues q ON q.id = m.queue_id
             WHERE m.agent_id = ? AND q.status = 'ACTIVE'`,
            [agentId]
        );
        return rows.map((r) => r.queue_id);
    }

    async isMember(queueId, agentId) {
        const [rows] = await connection.execute(
            'SELECT 1 FROM queue_members WHERE queue_id = ? AND agent_id = ? LIMIT 1',
            [queueId, agentId]
        );
        return rows.length > 0;
    }

    // ── Provisioning ────────────────────────────────────────────────────────────

    async upsert(tenantId, externalRef, fields) {
        const {
            name, strategy = 'ROUND_ROBIN', ring_timeout_seconds = null, max_active_calls = null,
            max_wait_seconds = null, overflow_queue_id = null, hold_audio_asset_id = null, status = 'ACTIVE',
        } = fields;
        await connection.execute(
            `INSERT INTO queues (tenant_id, external_ref, name, strategy, ring_timeout_seconds, max_active_calls,
                                 max_wait_seconds, overflow_queue_id, hold_audio_asset_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                 name = VALUES(name), strategy = VALUES(strategy),
                 ring_timeout_seconds = VALUES(ring_timeout_seconds), max_active_calls = VALUES(max_active_calls),
                 max_wait_seconds = VALUES(max_wait_seconds), overflow_queue_id = VALUES(overflow_queue_id),
                 hold_audio_asset_id = VALUES(hold_audio_asset_id), status = VALUES(status), updated_at = NOW()`,
            [tenantId, externalRef, name, strategy, ring_timeout_seconds, max_active_calls,
                max_wait_seconds, overflow_queue_id, hold_audio_asset_id, status]
        );
        return this.findByExternalRef(tenantId, externalRef);
    }

    // Replace the member list: [{ agentId, priority }].
    async replaceMembers(queueId, members) {
        const conn = await connection.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute('DELETE FROM queue_members WHERE queue_id = ?', [queueId]);
            for (const { agentId, priority = 1 } of members) {
                await conn.execute(
                    `INSERT INTO queue_members (queue_id, agent_id, priority, created_at, updated_at)
                     VALUES (?, ?, ?, NOW(), NOW())`,
                    [queueId, agentId, priority]
                );
            }
            await conn.commit();
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    }

    // Guarded: not while a live call is in the queue. 0 = something is using it
    // (or it's gone). Members go with it; call history keeps queue_id NULL.
    async deleteIfUnused(queueId, tenantId) {
        const [result] = await connection.execute(
            `DELETE FROM queues WHERE id = ? AND tenant_id = ?
               AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.queue_id = ? AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS'))`,
            [queueId, tenantId, queueId]
        );
        return result.affectedRows;
    }

    async overflowingInto(queueId) {
        const [rows] = await connection.execute('SELECT external_ref FROM queues WHERE overflow_queue_id = ?', [queueId]);
        return rows.map((r) => r.external_ref);
    }
}

export default new QueueRepository();
