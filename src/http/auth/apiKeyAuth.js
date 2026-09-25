// src/http/auth/apiKeyAuth.js
// Management API authentication: `Authorization: Bearer <api key>` resolves
// to one consumer (consumer_api_keys, hashed). Every /v1 handler reads the
// caller from request.consumer — never from the body or path.
import ConsumerRepository from '../../persistence/ConsumerRepository.js';
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { sendError } from '../errors.js';

// Per-consumer fixed-window rate limit.
const RATE_LIMIT_PER_MINUTE = 1200;

export async function apiKeyAuth(request, reply) {
    const header = request.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return sendError(reply, 401, 'unauthorized', 'Missing API key');

    const consumer = await ConsumerRepository.findByApiKey(match[1].trim());
    if (!consumer) return sendError(reply, 401, 'unauthorized', 'Invalid API key');
    if (consumer.status !== 'ACTIVE') return sendError(reply, 403, 'consumer_suspended', 'Consumer is suspended');

    const window = Math.floor(Date.now() / 60000);
    const key = `callio:ratelimit:${consumer.id}:${window}`;
    const count = await redisBaseService.incr(key);
    if (count === 1) await redisBaseService.expire(key, 70);
    if (count > RATE_LIMIT_PER_MINUTE) {
        reply.header('Retry-After', String(60 - (Math.floor(Date.now() / 1000) % 60)));
        return sendError(reply, 429, 'rate_limited', 'Too many requests');
    }

    request.consumer = consumer;
}
