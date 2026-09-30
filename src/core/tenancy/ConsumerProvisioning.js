// src/core/tenancy/ConsumerProvisioning.js
// Operator-side provisioning of consumers and their credentials. Plaintext
// secrets are returned exactly once, at creation — only hashes (API keys) or
// ciphertext (signing keys, webhook secret) are stored.
import { randomBytes } from 'crypto';
import connection from '../../../config/dbConnection.js';
import { encryptSecret, encryptJson } from '../../infra/crypto/secretBox.js';
import { hashApiKey } from '../../persistence/ConsumerRepository.js';
import EventBus from '../EventBus.js';

const token = (bytes) => randomBytes(bytes).toString('base64url');

export async function createConsumer({ name, slug, eventWebhookUrl = null, lookupUrl = null, pushCredentials = null }) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new Error('slug must be 2-63 lowercase letters, digits or dashes');

    // Signs events and lookup requests, so either URL needs it.
    const webhookSecret = (eventWebhookUrl || lookupUrl) ? token(32) : null;
    const [result] = await connection.execute(
        `INSERT INTO consumers (name, slug, status, event_webhook_url, event_webhook_secret, lookup_url, push_credentials, created_at, updated_at)
         VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, NOW(), NOW())`,
        [name, slug, eventWebhookUrl, webhookSecret ? encryptSecret(webhookSecret) : null, lookupUrl,
            pushCredentials ? encryptJson(pushCredentials) : null]
    );
    const consumerId = result.insertId;
    const apiKey = await issueApiKey(consumerId, slug, 'initial');
    const signingKey = await issueSigningKey(consumerId, 'k1');
    return { consumerId, slug, apiKey, signingKey, webhookSecret };
}

export async function issueApiKey(consumerId, slug, name = null) {
    const apiKey = `ck_${slug}_${token(24)}`;
    await connection.execute(
        `INSERT INTO consumer_api_keys (consumer_id, name, key_prefix, key_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [consumerId, name, apiKey.slice(0, 16), hashApiKey(apiKey)]
    );
    return apiKey;
}

export async function issueSigningKey(consumerId, kid) {
    const secret = token(32);
    await connection.execute(
        `INSERT INTO consumer_signing_keys (consumer_id, kid, secret, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [consumerId, kid, encryptSecret(secret)]
    );
    return { kid, secret };
}

export async function revokeApiKey(consumerId, keyPrefix) {
    const [result] = await connection.execute(
        `UPDATE consumer_api_keys SET revoked_at = NOW(), updated_at = NOW()
         WHERE consumer_id = ? AND key_prefix = ? AND revoked_at IS NULL`,
        [consumerId, keyPrefix]
    );
    return result.affectedRows;
}

export async function revokeSigningKey(consumerId, kid) {
    const [result] = await connection.execute(
        `UPDATE consumer_signing_keys SET revoked_at = NOW(), updated_at = NOW()
         WHERE consumer_id = ? AND kid = ? AND revoked_at IS NULL`,
        [consumerId, kid]
    );
    return result.affectedRows;
}

// ── Key rotation (Management API: /v1/api-keys, /v1/signing-keys) ────────────
// Rotate by issuing the new key, moving over to it, then revoking the old one.
// The last usable key of a kind can't be revoked (it would lock the consumer
// out); both revokes are guarded in SQL so two at once can't both pass.

const usableApiKey = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())';

export async function listApiKeys(consumerId) {
    const [rows] = await connection.execute(
        `SELECT id, name, key_prefix, created_at, last_used_at, expires_at, revoked_at
         FROM consumer_api_keys WHERE consumer_id = ? ORDER BY id ASC`,
        [consumerId]
    );
    return rows;
}

export async function issueApiKeyWithExpiry(consumerId, slug, { name = null, expiresInDays = null } = {}) {
    const apiKey = `ck_${slug}_${token(24)}`;
    const [result] = await connection.execute(
        `INSERT INTO consumer_api_keys (consumer_id, name, key_prefix, key_hash, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ${expiresInDays ? 'NOW() + INTERVAL ? DAY' : 'NULL'}, NOW(), NOW())`,
        [consumerId, name, apiKey.slice(0, 16), hashApiKey(apiKey), ...(expiresInDays ? [expiresInDays] : [])]
    );
    const [[row]] = await connection.execute(
        'SELECT id, name, key_prefix, created_at, last_used_at, expires_at, revoked_at FROM consumer_api_keys WHERE id = ?',
        [result.insertId]
    );
    return { ...row, key: apiKey };
}

/** 'revoked' | 'last_key' | 'not_found' */
export async function revokeApiKeyById(consumerId, keyId) {
    const [result] = await connection.execute(
        `UPDATE consumer_api_keys SET revoked_at = NOW(), updated_at = NOW()
         WHERE id = ? AND consumer_id = ? AND revoked_at IS NULL
           AND (SELECT n FROM (SELECT COUNT(*) AS n FROM consumer_api_keys
                               WHERE consumer_id = ? AND id != ? AND ${usableApiKey}) others) > 0`,
        [keyId, consumerId, consumerId, keyId]
    );
    if (result.affectedRows) return 'revoked';
    const [[row]] = await connection.execute('SELECT revoked_at FROM consumer_api_keys WHERE id = ? AND consumer_id = ?', [keyId, consumerId]);
    return !row || row.revoked_at ? 'not_found' : 'last_key';
}

export async function listSigningKeys(consumerId) {
    const [rows] = await connection.execute(
        'SELECT kid, created_at, revoked_at FROM consumer_signing_keys WHERE consumer_id = ? ORDER BY id ASC',
        [consumerId]
    );
    return rows;
}

// kid: the consumer's choice, or the next free k<n>.
export async function issueNextSigningKey(consumerId, kid = null) {
    if (!kid) {
        const n = (await listSigningKeys(consumerId))
            .map((k) => /^k(\d+)$/.exec(k.kid)?.[1]).filter(Boolean).map(Number);
        kid = `k${(n.length ? Math.max(...n) : 0) + 1}`;
    }
    try {
        return await issueSigningKey(consumerId, kid);
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return null;   // that kid exists (also a revoked one: kids aren't reused)
        throw err;
    }
}

/** 'revoked' | 'last_key' | 'not_found'. Sockets authenticated with it are disconnected. */
export async function revokeSigningKeyGuarded(consumerId, kid) {
    const [result] = await connection.execute(
        `UPDATE consumer_signing_keys SET revoked_at = NOW(), updated_at = NOW()
         WHERE consumer_id = ? AND kid = ? AND revoked_at IS NULL
           AND (SELECT n FROM (SELECT COUNT(*) AS n FROM consumer_signing_keys
                               WHERE consumer_id = ? AND kid != ? AND revoked_at IS NULL) others) > 0`,
        [consumerId, kid, consumerId, kid]
    );
    if (result.affectedRows) {
        EventBus.emit('consumer:signing_key_revoked', { consumerId, kid });
        return 'revoked';
    }
    const [[row]] = await connection.execute('SELECT revoked_at FROM consumer_signing_keys WHERE consumer_id = ? AND kid = ?', [consumerId, kid]);
    return !row || row.revoked_at ? 'not_found' : 'last_key';
}

// A new webhook secret (signs events and lookup requests), replacing the old
// one at once. Returns the plaintext — shown to the consumer only this once.
export async function rotateWebhookSecret(consumerId) {
    const secret = token(32);
    await connection.execute(
        'UPDATE consumers SET event_webhook_secret = ?, updated_at = NOW() WHERE id = ?',
        [encryptSecret(secret), consumerId]
    );
    return secret;
}
