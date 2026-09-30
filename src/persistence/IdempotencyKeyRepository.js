// src/persistence/IdempotencyKeyRepository.js
// api_idempotency_keys: the Idempotency-Key header on Management API POSTs
// (http/v1/idempotency.js).
import connection from '../../config/dbConnection.js';

class IdempotencyKeyRepository {
    // Claims the key for a new request. Returns the row id, or null when the
    // consumer already has a row for this key.
    async claim(consumerId, key, requestHash, ttlSeconds) {
        try {
            const [result] = await connection.execute(
                `INSERT INTO api_idempotency_keys (consumer_id, idempotency_key, request_hash, status, expires_at, created_at, updated_at)
                 VALUES (?, ?, ?, 'IN_PROGRESS', NOW() + INTERVAL ? SECOND, NOW(), NOW())`,
                [consumerId, key, requestHash, ttlSeconds]
            );
            return result.insertId;
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') return null;
            throw err;
        }
    }

    async find(consumerId, key) {
        const [rows] = await connection.execute(
            `SELECT id, request_hash, status, response_status, response_body,
                    expires_at <= NOW() AS expired,
                    TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS idle_seconds
             FROM api_idempotency_keys WHERE consumer_id = ? AND idempotency_key = ?`,
            [consumerId, key]
        );
        return rows[0] ?? null;
    }

    // Takes over a row whose request never finished (its worker died).
    // Guarded on the row still being that abandoned IN_PROGRESS row.
    async takeOver(id, staleSeconds) {
        const [result] = await connection.execute(
            `UPDATE api_idempotency_keys SET updated_at = NOW()
             WHERE id = ? AND status = 'IN_PROGRESS' AND updated_at <= NOW() - INTERVAL ? SECOND`,
            [id, staleSeconds]
        );
        return result.affectedRows > 0;
    }

    async complete(id, responseStatus, responseBody) {
        await connection.execute(
            `UPDATE api_idempotency_keys
             SET status = 'COMPLETED', response_status = ?, response_body = ?, updated_at = NOW()
             WHERE id = ?`,
            [responseStatus, responseBody == null ? null : JSON.stringify(responseBody), id]
        );
    }

    async remove(id) {
        await connection.execute('DELETE FROM api_idempotency_keys WHERE id = ?', [id]);
    }

    async purgeExpired(limit = 1000) {
        const [result] = await connection.execute(
            `DELETE FROM api_idempotency_keys WHERE expires_at <= NOW() LIMIT ${Math.max(1, Number(limit) || 1000)}`
        );
        return result.affectedRows;
    }
}

export default new IdempotencyKeyRepository();
