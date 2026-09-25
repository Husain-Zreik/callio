// src/persistence/OutboxRepository.js
// webhook_deliveries: consumer-facing events awaiting delivery.
import { randomUUID } from 'crypto';
import connection from '../../config/dbConnection.js';

class OutboxRepository {
    async enqueue({ consumerId, tenantId = null, callId = null, eventType, payload }) {
        const eventId = randomUUID();
        await connection.execute(
            `INSERT INTO webhook_deliveries (consumer_id, tenant_id, call_id, event_id, event_type, payload,
                                             status, attempts, next_attempt_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, NOW(), NOW(), NOW())`,
            [consumerId, tenantId, callId, eventId, eventType, JSON.stringify(payload)]
        );
        return eventId;
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
