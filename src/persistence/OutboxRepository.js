// src/persistence/OutboxRepository.js
// webhook_deliveries: consumer-facing events awaiting delivery.
import { randomUUID } from 'crypto';
import connection from '../../config/dbConnection.js';

const EVENT_COLUMNS = `d.id, d.event_id, d.event_type, d.call_id, d.payload, d.status, d.attempts,
                       d.last_response_status, d.delivered_at, d.created_at`;

class OutboxRepository {
    // Returns the new event id, or null when dedupeKey is already taken (the
    // event was written before, by this or another worker).
    async enqueue({ consumerId, tenantId = null, callId = null, eventType, payload, dedupeKey = null }) {
        const eventId = randomUUID();
        try {
            await connection.execute(
                `INSERT INTO webhook_deliveries (consumer_id, tenant_id, call_id, event_id, event_type, dedupe_key, payload,
                                                 status, attempts, next_attempt_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, NOW(), NOW(), NOW())`,
                [consumerId, tenantId, callId, eventId, eventType, dedupeKey, JSON.stringify(payload)]
            );
        } catch (err) {
            if (dedupeKey && err.code === 'ER_DUP_ENTRY' && /dedupe_key/.test(err.message)) return null;
            throw err;
        }
        return eventId;
    }

    async existsByDedupeKey(dedupeKey) {
        const [rows] = await connection.execute('SELECT 1 FROM webhook_deliveries WHERE dedupe_key = ? LIMIT 1', [dedupeKey]);
        return rows.length > 0;
    }

    // A consumer's events, newest first (GET /v1/events).
    async listForConsumer(consumerId, { tenantId = null, callId = null, eventType = null, status = null, beforeId = null, limit = 50 } = {}) {
        const where = ['d.consumer_id = ?'];
        const params = [consumerId];
        if (tenantId != null) { where.push('d.tenant_id = ?'); params.push(tenantId); }
        if (callId != null) { where.push('d.call_id = ?'); params.push(callId); }
        if (eventType) { where.push('d.event_type = ?'); params.push(eventType); }
        if (status) { where.push('d.status = ?'); params.push(status); }
        if (beforeId != null) { where.push('d.id < ?'); params.push(beforeId); }
        const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
        const [rows] = await connection.execute(
            `SELECT ${EVENT_COLUMNS} FROM webhook_deliveries d
             WHERE ${where.join(' AND ')}
             ORDER BY d.id DESC
             LIMIT ${safeLimit}`,
            params
        );
        return rows;
    }

    async findForConsumer(consumerId, eventId) {
        const [rows] = await connection.execute(
            `SELECT ${EVENT_COLUMNS} FROM webhook_deliveries d WHERE d.consumer_id = ? AND d.event_id = ?`,
            [consumerId, eventId]
        );
        return rows[0] ?? null;
    }

    // Queues an event for delivery again, whatever happened to it before.
    // Its attempt count restarts, so it gets the full retry schedule.
    async redeliver(consumerId, eventId) {
        const [result] = await connection.execute(
            `UPDATE webhook_deliveries
             SET status = 'PENDING', attempts = 0, next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
             WHERE consumer_id = ? AND event_id = ?`,
            [consumerId, eventId]
        );
        return result.affectedRows > 0;
    }

    // Due deliveries for consumers that have a webhook URL configured.
    async findDue(limit = 50) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
        const [rows] = await connection.execute(
            `SELECT d.id, d.consumer_id, d.event_id, d.event_type, d.payload, d.attempts
             FROM webhook_deliveries d
             JOIN consumers c ON c.id = d.consumer_id
             WHERE d.status = 'PENDING' AND d.next_attempt_at <= NOW()
               AND c.event_webhook_url IS NOT NULL AND c.status = 'ACTIVE'
             ORDER BY d.next_attempt_at ASC, d.id ASC
             LIMIT ${safeLimit}`
        );
        return rows;
    }

    async markDelivered(id, responseStatus) {
        await connection.execute(
            `UPDATE webhook_deliveries
             SET status = 'DELIVERED', attempts = attempts + 1, last_response_status = ?,
                 last_error = NULL, delivered_at = NOW(), updated_at = NOW()
             WHERE id = ?`,
            [responseStatus, id]
        );
    }

    // Records a failed attempt and schedules the next one, or gives up.
    async markAttemptFailed(id, { responseStatus = null, error, nextAttemptInSeconds = null }) {
        if (nextAttemptInSeconds == null) {
            await connection.execute(
                `UPDATE webhook_deliveries
                 SET status = 'FAILED', attempts = attempts + 1, last_response_status = ?, last_error = ?, updated_at = NOW()
                 WHERE id = ?`,
                [responseStatus, String(error ?? '').slice(0, 2000), id]
            );
            return;
        }
        await connection.execute(
            `UPDATE webhook_deliveries
             SET attempts = attempts + 1, last_response_status = ?, last_error = ?,
                 next_attempt_at = NOW() + INTERVAL ? SECOND, updated_at = NOW()
             WHERE id = ?`,
            [responseStatus, String(error ?? '').slice(0, 2000), nextAttemptInSeconds, id]
        );
    }
}

export default new OutboxRepository();
