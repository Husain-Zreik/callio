// src/infra/redis/RedisBaseService.js
import { redisClient } from './RedisClient.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../logging/logger.js';

const log = logger('infra.redis.RedisBaseService');

/**
 * Base Redis service providing low-level Redis operations.
 * All other Redis services should use this as their foundation.
 */
class RedisBaseService {
    constructor() {
        this.client = null;
        this.isInitialized = false;
        this.workerId = config.runtime.workerId;
    }

    // Initialize the service (call during app startup)
    async init() {
        if (this.isInitialized) return;

        try {
            this.client = redisClient.getClient();
            this.isInitialized = true;
            log.debug('Initialized');
        } catch (error) {
            log.error({ err: error }, 'Initialization failed');
            throw error;
        }
    }

    // Ensure service is initialized before operations
    ensureInitialized() {
        if (!this.isInitialized || !this.client) {
            throw new Error('RedisBaseService not initialized. Call init() first.');
        }
    }

    // Get a value by key
    async get(key) {
        this.ensureInitialized();
        try {
            return await this.client.get(key);
        } catch (error) {
            log.error({ err: error }, `Error getting key ${key}`);
            return null;
        }
    }

    // Set a key-value pair with optional TTL
    async set(key, value, ttl = null) {
        this.ensureInitialized();
        try {
            if (ttl) {
                await this.client.setex(key, ttl, value);
            } else {
                await this.client.set(key, value);
            }
            return true;
        } catch (error) {
            log.error({ err: error }, `Error setting key ${key}`);
            return false;
        }
    }

    // Set a key only if it doesn't exist (atomic)
    async setnx(key, value, ttl = null) {
        this.ensureInitialized();
        try {
            if (ttl) {
                const result = await this.client.set(key, value, 'EX', ttl, 'NX');
                return result === 'OK';
            } else {
                const result = await this.client.setnx(key, value);
                return result === 1;
            }
        } catch (error) {
            log.error({ err: error }, `Error setnx key ${key}`);
            return false;
        }
    }

    // Atomically get and delete a key (Redis >= 6.2)
    async getdel(key) {
        this.ensureInitialized();
        try {
            return await this.client.getdel(key);
        } catch (error) {
            log.error({ err: error }, `Error getdel key ${key}`);
            return null;
        }
    }

    // Delete one or more keys
    async del(...keys) {
        this.ensureInitialized();
        try {
            if (keys.length === 0) return 0;
            return await this.client.del(...keys);
        } catch (error) {
            log.error({ err: error }, 'Error deleting keys');
            return 0;
        }
    }

    // Check if a key exists
    async exists(key) {
        this.ensureInitialized();
        try {
            const result = await this.client.exists(key);
            return result === 1;
        } catch (error) {
            log.error({ err: error }, `Error checking existence of key ${key}`);
            return false;
        }
    }

    // Set TTL on an existing key
    async expire(key, ttl) {
        this.ensureInitialized();
        try {
            const result = await this.client.expire(key, ttl);
            return result === 1;
        } catch (error) {
            log.error({ err: error }, `Error setting TTL on key ${key}`);
            return false;
        }
    }

    // Remove TTL from a key (make it permanent)
    async persist(key) {
        this.ensureInitialized();
        try {
            const result = await this.client.persist(key);
            return result === 1;
        } catch (error) {
            log.error({ err: error }, `Error persisting key ${key}`);
            return false;
        }
    }

    // Atomically increment a key and return the new integer value
    async incr(key) {
        this.ensureInitialized();
        try {
            return await this.client.incr(key);
        } catch (error) {
            log.error({ err: error }, `Error incrementing key ${key}`);
            return null;
        }
    }

    // Atomically decrement a key and return the new integer value
    async decr(key) {
        this.ensureInitialized();
        try {
            return await this.client.decr(key);
        } catch (error) {
            log.error({ err: error }, `Error decrementing key ${key}`);
            return null;
        }
    }

    // Add members to a set
    async sadd(key, ...members) {
        this.ensureInitialized();
        try {
            if (members.length === 0) return 0;
            return await this.client.sadd(key, ...members);
        } catch (error) {
            log.error({ err: error }, `Error adding to set ${key}`);
            return 0;
        }
    }

    // Remove members from a set
    async srem(key, ...members) {
        this.ensureInitialized();
        try {
            if (members.length === 0) return 0;
            return await this.client.srem(key, ...members);
        } catch (error) {
            log.error({ err: error }, `Error removing from set ${key}`);
            return 0;
        }
    }

    // Get all members of a set
    async smembers(key) {
        this.ensureInitialized();
        try {
            return await this.client.smembers(key);
        } catch (error) {
            log.error({ err: error }, `Error getting set members ${key}`);
            return [];
        }
    }

    // Get cardinality (size) of a set
    async scard(key) {
        this.ensureInitialized();
        try {
            return await this.client.scard(key);
        } catch (error) {
            log.error({ err: error }, `Error getting set size ${key}`);
            return 0;
        }
    }

    // Scan keys matching a pattern (async iterator, production-safe)
    async *scanKeys(pattern, count = 100) {
        this.ensureInitialized();
        let cursor = '0';

        try {
            do {
                const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
                cursor = nextCursor;
                for (const key of keys) yield key;
            } while (cursor !== '0');
        } catch (error) {
            log.error({ err: error }, `Error scanning keys with pattern ${pattern}`);
        }
    }

    // Get all keys matching a pattern (use only for small datasets)
    async scanKeysAll(pattern) {
        const keys = [];
        try {
            for await (const key of this.scanKeys(pattern)) {
                keys.push(key);
            }
            return keys;
        } catch (error) {
            log.error({ err: error }, `Error collecting keys with pattern ${pattern}`);
            return [];
        }
    }

    // ── Hash operations ─────────────────────────────────────────────────

    // Set one or more fields in a hash — accepts (key, field, value) or (key, f1, v1, f2, v2, ...)
    async hset(key, ...args) {
        this.ensureInitialized();
        try {
            return await this.client.hset(key, ...args);
        } catch (error) {
            log.error({ err: error }, `Error hset ${key}`);
            return 0;
        }
    }

    // Get a single field from a hash
    async hget(key, field) {
        this.ensureInitialized();
        try {
            return await this.client.hget(key, field);
        } catch (error) {
            log.error({ err: error }, `Error hget ${key}[${field}]`);
            return null;
        }
    }

    // Get all fields and values from a hash
    async hgetall(key) {
        this.ensureInitialized();
        try {
            return await this.client.hgetall(key);
        } catch (error) {
            log.error({ err: error }, `Error hgetall ${key}`);
            return null;
        }
    }

    // Delete fields from a hash
    async hdel(key, ...fields) {
        this.ensureInitialized();
        try {
            if (fields.length === 0) return 0;
            return await this.client.hdel(key, ...fields);
        } catch (error) {
            log.error({ err: error }, `Error hdel ${key}`);
            return 0;
        }
    }

    // Get all values of a hash
    async hvals(key) {
        this.ensureInitialized();
        try {
            return await this.client.hvals(key);
        } catch (error) {
            log.error({ err: error }, `Error hvals ${key}`);
            return [];
        }
    }

    // ── Pipeline ─────────────────────────────────────────────────────────

    // Create a Redis pipeline for batching commands
    pipeline() {
        this.ensureInitialized();
        return this.client.pipeline();
    }

    // Execute a pipeline
    async executePipeline(pipeline) {
        this.ensureInitialized();
        try {
            return await pipeline.exec();
        } catch (error) {
            log.error({ err: error }, 'Error executing pipeline');
            throw error;
        }
    }

    // Publish a message to a channel
    async publish(channel, message) {
        this.ensureInitialized();
        try {
            return await this.client.publish(channel, message);
        } catch (error) {
            log.error({ err: error }, `Error publishing to channel ${channel}`);
            return 0;
        }
    }

    // Get Redis client for advanced operations (use with caution)
    getClient() {
        this.ensureInitialized();
        return this.client;
    }

    // Get service status
    getStatus() {
        return {
            isInitialized: this.isInitialized,
            workerId: this.workerId,
            hasClient: !!this.client
        };
    }

    // Close connections (called during graceful shutdown)
    async close() {
        this.client = null;
        this.isInitialized = false;
        log.info('Closed');
    }
}

export const redisBaseService = new RedisBaseService();
