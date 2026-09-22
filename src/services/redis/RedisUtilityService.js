// src/services/redis/RedisUtilityService.js
import { callOwnershipService } from './CallOwnershipService.js';
import { redisBaseService } from './RedisBaseService.js';
import { callStateCache } from './CallStateCache.js';
import { config } from '../../../config/envConfig.js';

/**
 * Utility service for cross-cutting Redis operations.
 * Provides helper methods that span multiple Redis services.
 */
class RedisUtilityService {
    constructor() {
        this.workerId = config.runtime.workerId;
    }

    // Initialize the service (call during app startup)
    async init() {
        await callOwnershipService.init();
        await callStateCache.init();
        console.log(`[RedisUtility] Worker ${this.workerId} initialized`);
    }

    // Clean up all Redis data for a call (ownership + state).
    // Direct key deletion instead of releaseCall() — mirrors
    // RedisCleanupService.cleanupCall's identical reasoning: this can now run
    // on whichever worker actually processed the terminate webhook, which
    // isn't necessarily the worker that owns the call (see
    // CallWebhookProcessor._processCallEvent, which no longer gates
    // 'terminate' on ownership). releaseCall()'s ownership check would just
    // warn-and-no-op for a non-owning caller, leaking the (often TTL-less,
    // made-permanent-at-connect-time) ownership key forever.
    async cleanupCall(callId) {
        try {
            await Promise.all([
                redisBaseService.del(callOwnershipService.getKey(callId)),
                callStateCache.deleteCallState(callId)
            ]);

            console.log(`[RedisUtility] Cleaned up all data for call ${callId}`);
            return true;
        } catch (error) {
            console.error(`[RedisUtility] Error cleaning up call ${callId}:`, error.message);
            return false;
        }
    }

    // Get comprehensive worker information
    getWorkerInfo() {
        return {
            workerId: this.workerId,
            isPM2: config.runtime.isPM2,
            ownership: callOwnershipService.getStatus(),
            stateCache: callStateCache.getStatus()
        };
    }

    // Get all Redis service statuses (for monitoring/debugging)
    async getFullStatus() {
        const [ownedCalls] = await Promise.all([
            callOwnershipService.getOwnedCalls()
        ]);

        return {
            worker: this.getWorkerInfo(),
            ownedCalls: ownedCalls,
            ownedCallsCount: ownedCalls.length
        };
    }
}

export const redisUtilityService = new RedisUtilityService();
