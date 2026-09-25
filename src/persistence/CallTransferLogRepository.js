// src/persistence/CallTransferLogRepository.js
import connection from '../../config/dbConnection.js';

class CallTransferLogRepository {
    async create(callId, fromAgentId, toAgentId, initiatedByAgentId, initiatedByType, transferredAt, toQueueId = null) {
        await connection.execute(
            `INSERT INTO call_transfer_logs
                (call_id, from_agent_id, to_agent_id, to_queue_id, initiated_by_agent_id, initiated_by_type, transferred_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                callId,
                fromAgentId ?? null,
                toAgentId ?? null,
                toQueueId ?? null,
                initiatedByAgentId ?? null,
                initiatedByType || 'system',
                transferredAt,
            ]
        );
    }

    async findPendingTransfer(callId, toAgentId) {
        const [rows] = await connection.execute(
            `SELECT id, transferred_at
             FROM call_transfer_logs
             WHERE call_id = ? AND to_agent_id = ? AND accepted_at IS NULL
             ORDER BY transferred_at DESC
             LIMIT 1`,
            [callId, toAgentId]
        );
        return rows[0] ?? null;
    }

    async hasPendingTransfer(callId, toAgentId) {
        const [rows] = await connection.execute(
            `SELECT id FROM call_transfer_logs
             WHERE call_id = ? AND to_agent_id = ? AND accepted_at IS NULL
             LIMIT 1`,
            [callId, toAgentId]
        );
        return rows.length > 0;
    }

    async markAccepted(id, acceptedAt, acceptanceDurationSeconds) {
        await connection.execute(
            `UPDATE call_transfer_logs
             SET accepted_at = ?, acceptance_duration_seconds = ?, updated_at = NOW()
             WHERE id = ?`,
            [acceptedAt, acceptanceDurationSeconds, id]
        );
    }

    async listForCall(callId) {
        const [rows] = await connection.execute(
            `SELECT id, from_agent_id, to_agent_id, to_queue_id, initiated_by_agent_id, initiated_by_type,
                    transferred_at, accepted_at, acceptance_duration_seconds
             FROM call_transfer_logs
             WHERE call_id = ?
             ORDER BY transferred_at ASC`,
            [callId]
        );
        return rows;
    }
}

export default new CallTransferLogRepository();
