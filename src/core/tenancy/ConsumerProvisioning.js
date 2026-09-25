// src/core/tenancy/ConsumerProvisioning.js
// Operator-side provisioning of consumers and their credentials. Plaintext
// secrets are returned exactly once, at creation — only hashes (API keys) or
// ciphertext (signing keys, webhook secret) are stored.
import { randomBytes } from 'crypto';
import connection from '../../../config/dbConnection.js';
import { encryptSecret, encryptJson } from '../../infra/crypto/secretBox.js';
import { hashApiKey } from '../../persistence/ConsumerRepository.js';

const token = (bytes) => randomBytes(bytes).toString('base64url');

export async function createConsumer({ name, slug, eventWebhookUrl = null, lookupUrl = null, pushCredentials = null }) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new Error('slug must be 2-63 lowercase letters, digits or dashes');

    const webhookSecret = eventWebhookUrl ? token(32) : null;
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
