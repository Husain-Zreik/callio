// src/services/redis/CallStateCache.js
import { redisBaseService } from './RedisBaseService.js';
import { config } from '../../../config/envConfig.js';

/**
 * Manages call state caching in Redis.
 * Provides fast access to call metadata across workers.
 */
class CallStateCache {
    constructor() {
        this.keyPrefix = 'call:state:';
        this.defaultTTL = 3600; // 1 hour
        this.workerId = config.runtime.workerId;
    }

    // Initialize the service (call during app startup)
    async init() {
        await redisBaseService.init();
        console.log(`[CallStateCache] Worker ${this.workerId} initialized`);
    }

    // Build Redis key for call state
    getKey(callId) {
        return `${this.keyPrefix}${callId}`;
    }

    // Set call state with optional custom TTL
    async setCallState(callId, state, customTTL = null) {
        const key = this.getKey(callId);
        const ttl = customTTL || this.defaultTTL;

        try {
            const value = JSON.stringify(state);
            const success = await redisBaseService.set(key, value, ttl);

            if (success) {
                console.log(`[CallStateCache] Set state for call ${callId} (TTL: ${ttl}s)`);
            }

            return success;
        } catch (error) {
            console.error(`[CallStateCache] Error setting state for call ${callId}:`, error.message);
            return false;
        }
    }

    // Get call state
    async getCallState(callId) {
        const key = this.getKey(callId);

        try {
            const data = await redisBaseService.get(key);

            if (!data) {
                return null;
            }

            return JSON.parse(data);
        } catch (error) {
            console.error(`[CallStateCache] Error getting state for call ${callId}:`, error.message);
            return null;
        }
    }

    // Delete call state
    async deleteCallState(callId) {
        const key = this.getKey(callId);

        try {
            const deleted = await redisBaseService.del(key);

            if (deleted > 0) {
                console.log(`[CallStateCache] Deleted state for call ${callId}`);
            }

            return deleted > 0;
        } catch (error) {
            console.error(`[CallStateCache] Error deleting state for call ${callId}:`, error.message);
            return false;
        }
    }

    // Check if call state exists
    async hasCallState(callId) {
        const key = this.getKey(callId);

        try {
            return await redisBaseService.exists(key);
        } catch (error) {
            console.error(`[CallStateCache] Error checking state for call ${callId}:`, error.message);
            return false;
        }
    }

    // Update TTL for existing call state
    async refreshCallStateTTL(callId, customTTL = null) {
        const key = this.getKey(callId);
        const ttl = customTTL || this.defaultTTL;

        try {
            const success = await redisBaseService.expire(key, ttl);

            if (success) {
                console.log(`[CallStateCache] Refreshed TTL for call ${callId} (TTL: ${ttl}s)`);
            }

            return success;
        } catch (error) {
            console.error(`[CallStateCache] Error refreshing TTL for call ${callId}:`, error.message);
            return false;
        }
    }

    // Get all cached call IDs
    async getAllCachedCallIds() {
        const callIds = [];

        try {
            for await (const key of redisBaseService.scanKeys(`${this.keyPrefix}*`)) {
                const callId = key.replace(this.keyPrefix, '');
                callIds.push(callId);
            }
            return callIds;
        } catch (error) {
            console.error('[CallStateCache] Error getting cached call IDs:', error.message);
            return [];
        }
    }

    // Get service status
    getStatus() {
        return {
            workerId: this.workerId,
            keyPrefix: this.keyPrefix,
            defaultTTL: this.defaultTTL
        };
    }
}

export const callStateCache = new CallStateCache();
