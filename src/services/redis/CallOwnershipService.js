// src/services/redis/CallOwnershipService.js
import { redisBaseService } from './RedisBaseService.js';
import { config } from '../../../config/envConfig.js';

/**
 * Manages call ownership across distributed workers using Redis.
 * Ensures only one worker handles a call at a time.
 */
class CallOwnershipService {
    constructor() {
        this.keyPrefix = 'call:owner:';
        this.defaultTTL = 30; // seconds
        this.workerId = config.runtime.workerId;
    }

    // Initialize the service (call during app startup)
    async init() {
        await redisBaseService.init();
        console.log(`[CallOwnership] Worker ${this.workerId} initialized`);
    }

    // Build Redis key for call ownership
    getKey(callId) {
        return `${this.keyPrefix}${callId}`;
    }

    // Claim ownership of a call with optional custom TTL
    async claimCall(callId, customTTL = null, customWorkerId = null) {
        const workerId = customWorkerId || this.workerId;
        const ttl = customTTL || this.defaultTTL;
        const key = this.getKey(callId);

        try {
            const claimed = await redisBaseService.setnx(key, workerId, ttl);

            if (claimed) {
                console.log(`[CallOwnership] Worker ${workerId} claimed call ${callId} (TTL: ${ttl}s)`);
            }

            return claimed;
        } catch (error) {
            console.error(`[CallOwnership] Error claiming call ${callId}:`, error.message);
            return false;
        }
    }

    // Make call ownership permanent (remove TTL)
    async setCallOwnershipPermanent(callId, customWorkerId = null) {
        const workerId = customWorkerId || this.workerId;
        const key = this.getKey(callId);

        try {
            const currentOwner = await redisBaseService.get(key);

            if (!currentOwner) {
                console.warn(`[CallOwnership] Cannot make call ${callId} permanent - no owner exists`);
                return false;
            }

            if (currentOwner !== workerId) {
                console.warn(`[CallOwnership] Worker ${workerId} cannot make call ${callId} permanent (owned by ${currentOwner})`);
                return false;
            }

            const result = await redisBaseService.persist(key);

            if (result) {
                console.log(`[CallOwnership] Worker ${workerId} made call ${callId} ownership permanent`);
            }

            return result;
        } catch (error) {
            console.error(`[CallOwnership] Error making call ${callId} permanent:`, error.message);
            return false;
        }
    }

    // Release ownership of a call
    async releaseCall(callId, customWorkerId = null) {
        const workerId = customWorkerId || this.workerId;
        const key = this.getKey(callId);

        try {
            const currentOwner = await redisBaseService.get(key);

            if (!currentOwner) {
                console.log(`[CallOwnership] Call ${callId} has no owner to release`);
                return true;
            }

            if (currentOwner !== workerId) {
                console.warn(`[CallOwnership] Worker ${workerId} cannot release call ${callId} (owned by ${currentOwner})`);
                return false;
            }

            await redisBaseService.del(key);
            console.log(`[CallOwnership] Worker ${workerId} released call ${callId}`);
            return true;
        } catch (error) {
            console.error(`[CallOwnership] Error releasing call ${callId}:`, error.message);
            return false;
        }
    }

    // Get the worker ID that owns a call
    async getCallOwner(callId) {
        const key = this.getKey(callId);

        try {
            return await redisBaseService.get(key);
        } catch (error) {
            console.error(`[CallOwnership] Error getting owner for call ${callId}:`, error.message);
            return null;
        }
    }

    // Check if this worker owns a call
    async ownsCall(callId) {
        const owner = await this.getCallOwner(callId);
        return owner === this.workerId;
    }

    // Get all calls owned by this worker
    async getOwnedCalls() {
        const calls = [];

        try {
            for await (const key of redisBaseService.scanKeys(`${this.keyPrefix}*`)) {
                const owner = await redisBaseService.get(key);
                if (owner === this.workerId) {
                    const callId = key.replace(this.keyPrefix, '');
                    calls.push(callId);
                }
            }
            return calls;
        } catch (error) {
            console.error('[CallOwnership] Error getting owned calls:', error.message);
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

export const callOwnershipService = new CallOwnershipService();
