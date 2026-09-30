// src/http/v1/keyRoutes.js
// The calling consumer's own keys (docs/management-api.md, Keys): API keys
// and agent-token signing keys — list, issue, revoke. A new key's secret is
// in the POST response only; it is never stored in the clear and never
// returned again, so these POSTs opt out of Idempotency-Key replay.
import {
    listApiKeys, issueApiKeyWithExpiry, revokeApiKeyById,
    listSigningKeys, issueNextSigningKey, revokeSigningKeyGuarded,
} from '../../core/tenancy/ConsumerProvisioning.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { requireString, optionalInt } from './validate.js';

const iso = (d) => (d ? new Date(d).toISOString() : null);
const apiKeyView = (k) => ({
    id: k.id, name: k.name, prefix: k.key_prefix, createdAt: iso(k.created_at), lastUsedAt: iso(k.last_used_at),
    expiresAt: iso(k.expires_at), revokedAt: iso(k.revoked_at),
});
const signingKeyView = (k) => ({ kid: k.kid, createdAt: iso(k.created_at), revokedAt: iso(k.revoked_at) });

const lastKey = (what) => new HttpError(409, 'last_key', `This is your last active ${what} — issue another one first`);

export default async function keyRoutes(fastify) {
    const noReplay = { config: { idempotent: false } };

    // API keys
    fastify.get('/api-keys', async (request) => ({ apiKeys: (await listApiKeys(request.consumer.id)).map(apiKeyView) }));

    fastify.post('/api-keys', noReplay, async (request, reply) => {
        const body = request.body ?? {};
        const key = await issueApiKeyWithExpiry(request.consumer.id, request.consumer.slug, {
            name: requireString(body, 'name', { optional: true }),
            expiresInDays: optionalInt(body, 'expires_in_days', { min: 1, max: 3650 }),
        });
        return reply.code(201).send({ apiKey: { ...apiKeyView(key), key: key.key } });
    });

    fastify.delete('/api-keys/:keyId', async (request, reply) => {
        const id = Number(request.params.keyId);
        if (!Number.isInteger(id) || id < 1) throw notFound('API key');
        const result = await revokeApiKeyById(request.consumer.id, id);
        if (result === 'not_found') throw notFound('API key');
        if (result === 'last_key') throw lastKey('API key');
        return reply.code(204).send();
    });

    // Agent-token signing keys
    fastify.get('/signing-keys', async (request) => ({ signingKeys: (await listSigningKeys(request.consumer.id)).map(signingKeyView) }));

    fastify.post('/signing-keys', noReplay, async (request, reply) => {
        const kid = requireString(request.body ?? {}, 'kid', { max: 64, optional: true });
        if (kid && !/^[A-Za-z0-9._-]+$/.test(kid)) throw badRequest('kid may contain letters, digits, dot, dash and underscore');
        const key = await issueNextSigningKey(request.consumer.id, kid);
        if (!key) throw new HttpError(409, 'kid_taken', `Signing key "${kid}" already exists (kids are never reused)`);
        return reply.code(201).send({ signingKey: { kid: key.kid, secret: key.secret } });
    });

    fastify.delete('/signing-keys/:kid', async (request, reply) => {
        const result = await revokeSigningKeyGuarded(request.consumer.id, String(request.params.kid));
        if (result === 'not_found') throw notFound('Signing key');
        if (result === 'last_key') throw lastKey('signing key');
        return reply.code(204).send();
    });
}
