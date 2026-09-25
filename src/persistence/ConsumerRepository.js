// src/persistence/ConsumerRepository.js
// Integrating products: their API keys, agent-token signing keys, event
// webhook and push credentials.
import { createHash } from 'crypto';
import connection from '../../config/dbConnection.js';
import { decryptJson, decryptSecret } from '../infra/crypto/secretBox.js';

export function hashApiKey(apiKey) {
    return createHash('sha256').update(String(apiKey)).digest('hex');
}

class ConsumerRepository {
    async findById(consumerId) {
        const [rows] = await connection.execute(
            'SELECT id, name, slug, status, event_webhook_url, lookup_url FROM consumers WHERE id = ? LIMIT 1',
            [consumerId]
        );
        return rows[0] ?? null;
    }

    async findBySlug(slug) {
        const [rows] = await connection.execute(
            'SELECT id, name, slug, status, event_webhook_url, lookup_url FROM consumers WHERE slug = ? LIMIT 1',
            [slug]
        );
        return rows[0] ?? null;
    }

    // Resolves an API key to its active consumer and records its use.
    async findByApiKey(apiKey) {
        const [rows] = await connection.execute(
            `SELECT c.id, c.name, c.slug, c.status, c.event_webhook_url, c.lookup_url, k.id AS key_id
             FROM consumer_api_keys k
             JOIN consumers c ON c.id = k.consumer_id
             WHERE k.key_hash = ?
               AND k.revoked_at IS NULL
               AND (k.expires_at IS NULL OR k.expires_at > NOW())
             LIMIT 1`,
            [hashApiKey(apiKey)]
        );
        const row = rows[0];
        if (!row) return null;
        connection.execute('UPDATE consumer_api_keys SET last_used_at = NOW() WHERE id = ?', [row.key_id])
            .catch((err) => console.error('[ConsumerRepository] last_used_at update failed:', err));
        return row;
    }

    async getSigningSecret(consumerId, kid) {
        const [rows] = await connection.execute(
            `SELECT secret FROM consumer_signing_keys
             WHERE consumer_id = ? AND kid = ? AND revoked_at IS NULL LIMIT 1`,
            [consumerId, kid]
        );
        return rows[0]?.secret ? decryptSecret(rows[0].secret) : null;
    }

    async getWebhookConfig(consumerId) {
        const [rows] = await connection.execute(
            'SELECT event_webhook_url, event_webhook_secret FROM consumers WHERE id = ? LIMIT 1',
            [consumerId]
        );
        const row = rows[0];
        if (!row?.event_webhook_url) return null;
        return {
            url: row.event_webhook_url,
            secret: row.event_webhook_secret ? decryptSecret(row.event_webhook_secret) : null,
        };
    }

    async getPushCredentials(consumerId) {
        const [rows] = await connection.execute('SELECT push_credentials FROM consumers WHERE id = ?', [consumerId]);
        return rows[0]?.push_credentials ? decryptJson(rows[0].push_credentials) : null;
    }
}

export default new ConsumerRepository();
