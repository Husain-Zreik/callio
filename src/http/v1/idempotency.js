// src/http/v1/idempotency.js
// Idempotency-Key on Management API POSTs (docs/management-api.md#idempotency).
// A client that retries a POST with the same key gets the first request's
// response back instead of a second call, asset or terminate:
//   - first request with a key: runs, and its response (2xx/4xx) is stored for 24 h;
//   - same key, same request, finished: the stored response, header Idempotent-Replayed: true;
//   - same key while the first is still running: 409 idempotency_key_in_use;
//   - same key, different method/path/body: 422 idempotency_key_reused.
// A 5xx isn't stored, so the retry runs again. Keys are per consumer.
import { createHash } from 'crypto';
import IdempotencyKeyRepository from '../../persistence/IdempotencyKeyRepository.js';
import { sendError } from '../errors.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('http.v1.idempotency');

const HEADER = 'idempotency-key';
const TTL_SECONDS = 24 * 3600;
// A request still IN_PROGRESS after this long was abandoned (its worker died);
// a retry may take the key over. Far above any Management API request.
const ABANDONED_AFTER_SECONDS = 120;
const PURGE_EVERY_MS = 10 * 60 * 1000;
let lastPurge = 0;

function fingerprint(request) {
    const path = request.url.split('?')[0];
    return createHash('sha256').update(`${request.method} ${path}\n${JSON.stringify(request.body ?? null)}`).digest('hex');
}

function purgeExpiredNowAndThen() {
    if (Date.now() - lastPurge < PURGE_EVERY_MS) return;
    lastPurge = Date.now();
    IdempotencyKeyRepository.purgeExpired().catch((err) => log.warn({ err }, 'Purging expired idempotency keys failed'));
}

// preHandler, after apiKeyAuth (request.consumer is set).
export async function idempotencyPreHandler(request, reply) {
    if (request.method !== 'POST' || !request.consumer) return;
    const key = request.headers[HEADER];
    if (key == null) return;
    if (typeof key !== 'string' || !key.length || key.length > 255) {
        return sendError(reply, 400, 'invalid_request', 'Idempotency-Key must be 1-255 characters');
    }
    purgeExpiredNowAndThen();

    const consumerId = request.consumer.id;
    const hash = fingerprint(request);
    for (let attempt = 0; attempt < 2; attempt++) {
        const id = await IdempotencyKeyRepository.claim(consumerId, key, hash, TTL_SECONDS);
        if (id) {
            request.idempotencyKeyId = id;
            return;
        }
        const row = await IdempotencyKeyRepository.find(consumerId, key);
        if (!row) continue;                               // removed in between: claim again
        if (Number(row.expired)) {
            await IdempotencyKeyRepository.remove(row.id);
            continue;
        }
        if (row.request_hash !== hash) {
            return sendError(reply, 422, 'idempotency_key_reused',
                'This Idempotency-Key was used with a different request');
        }
        if (row.status === 'COMPLETED') {
            const body = typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body;
            reply.header('Idempotent-Replayed', 'true').code(row.response_status);
            return body == null ? reply.send() : reply.send(body);
        }
        if (Number(row.idle_seconds) >= ABANDONED_AFTER_SECONDS && await IdempotencyKeyRepository.takeOver(row.id, ABANDONED_AFTER_SECONDS)) {
            request.idempotencyKeyId = row.id;
            return;
        }
        reply.header('Retry-After', '1');
        return sendError(reply, 409, 'idempotency_key_in_use', 'A request with this Idempotency-Key is still in progress');
    }
    return sendError(reply, 409, 'idempotency_key_in_use', 'A request with this Idempotency-Key is still in progress');
}

// onSend: stores the response for the claimed key (or frees the key on a 5xx).
export async function idempotencyOnSend(request, reply, payload) {
    const id = request.idempotencyKeyId;
    if (!id) return payload;
    request.idempotencyKeyId = null;
    try {
        if (reply.statusCode >= 500) {
            await IdempotencyKeyRepository.remove(id);
        } else {
            let body = null;
            if (payload != null && payload !== '') {
                try { body = JSON.parse(payload); } catch { body = null; }
            }
            await IdempotencyKeyRepository.complete(id, reply.statusCode, body);
        }
    } catch (err) {
        log.error({ err, idempotencyKeyId: id }, 'Storing the idempotent response failed');
    }
    return payload;
}
