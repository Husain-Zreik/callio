// src/persistence/CallLifecycleEventRepository.js
import connection from '../../config/dbConnection.js';

class CallLifecycleEventRepository {
    async insert(callId, agentId, eventType, durationSeconds, metadata, occurredAt = null) {
        const meta = metadata && Object.keys(metadata).length > 0
            ? JSON.stringify(metadata)
            : null;

        // occurredAt is captured by the caller (CallLifecycleLogger#insert) at the
        // moment the log call was made — several callers fire this fire-and-forget,
        // so NOW() here would record commit order, not logical event order.
        await connection.execute(
            `INSERT INTO call_lifecycle_events
                (call_id, agent_id, event_type, occurred_at, duration_seconds, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [callId, agentId ?? null, eventType, occurredAt ?? new Date(), durationSeconds ?? null, meta]
        );
    }

    async getLatestEvent(callId) {
        const [rows] = await connection.execute(
            `SELECT event_type, agent_id, occurred_at
             FROM call_lifecycle_events
             WHERE call_id = ?
             ORDER BY occurred_at DESC, id DESC
             LIMIT 1`,
            [callId]
        );
        return rows[0] ?? null;
    }

    async listForCall(callId) {
        const [rows] = await connection.execute(
            `SELECT id, agent_id, event_type, occurred_at, duration_seconds, metadata
             FROM call_lifecycle_events
             WHERE call_id = ?
             ORDER BY occurred_at ASC, id ASC`,
            [callId]
        );
        return rows;
    }
}

export default new CallLifecycleEventRepository();
