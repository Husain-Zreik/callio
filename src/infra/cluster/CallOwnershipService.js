// src/infra/cluster/CallOwnershipService.js
import { redisBaseService } from '../redis/RedisBaseService.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../logging/logger.js';

const log = logger('infra.cluster.CallOwnershipService');

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
        log.debug(`Worker ${this.workerId} initialized`);
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
                log.debug({ callId }, `Worker ${workerId} claimed call (TTL: ${ttl}s)`);
            }

            return claimed;
        } catch (error) {
            log.error({ callId, err: error }, 'Error claiming call');
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
                log.warn({ callId }, 'Cannot make call permanent - no owner exists');
                return false;
            }

            if (currentOwner !== workerId) {
                log.warn({ callId }, `Worker ${workerId} cannot make call permanent (owned by ${currentOwner})`);
                return false;
            }

            const result = await redisBaseService.persist(key);

            if (result) {
                log.debug({ callId }, `Worker ${workerId} made call ownership permanent`);
            }

            return result;
        } catch (error) {
            log.error({ callId, err: error }, 'Error making call permanent');
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
                log.debug({ callId }, 'Call has no owner to release');
                return true;
            }

            if (currentOwner !== workerId) {
                log.warn({ callId }, `Worker ${workerId} cannot release call (owned by ${currentOwner})`);
                return false;
            }

            await redisBaseService.del(key);
            log.debug({ callId }, `Worker ${workerId} released call`);
            return true;
        } catch (error) {
            log.error({ callId, err: error }, 'Error releasing call');
            return false;
        }
    }

    // Get the worker ID that owns a call
    async getCallOwner(callId) {
        const key = this.getKey(callId);

        try {
            return await redisBaseService.get(key);
        } catch (error) {
            log.error({ callId, err: error }, 'Error getting owner');
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
            log.error({ err: error }, 'Error getting owned calls');
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
