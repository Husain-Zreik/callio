// src/services/redis/RedisCleanupService.js
import CallRepository from '../../repositories/CallRepository.js';
import { callOwnershipService } from './CallOwnershipService.js';
import { redisBaseService } from './RedisBaseService.js';
import { callStateCache } from './CallStateCache.js';
import { CallStatus } from '../call/constants/CallConstants.js';
import { config } from '../../../config/envConfig.js';

/**
 * Periodically cleans up orphaned call data in Redis.
 * Uses distributed locking to ensure only one worker runs cleanup.
 */
class RedisCleanupService {
    constructor() {
        this.lockKey = 'cleanup:lock';
        this.lockTTL = 300; // 5 minutes
        this.cleanupInterval = null;
        this.isRunning = false;
        this.workerId = config.runtime.workerId;
    }

    // Initialize the service (call during app startup)
    async init() {
        await redisBaseService.init();
        await callOwnershipService.init();
        await callStateCache.init();
        console.log(`[RedisCleanup] Worker ${this.workerId} initialized`);
    }

    // Acquire distributed lock for cleanup
    async acquireLock() {
        try {
            const claimed = await redisBaseService.setnx(this.lockKey, this.workerId, this.lockTTL);
            return claimed;
        } catch (error) {
            console.error('[RedisCleanup] Error acquiring lock:', error.message);
            return false;
        }
    }

    // Release distributed lock — atomic CAS via Lua so another worker that
    // acquired after our TTL expired doesn't get its lock deleted by our DEL.
    async releaseLock() {
        try {
            const client = redisBaseService.getClient();
            const result = await client.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
                1,
                this.lockKey,
                String(this.workerId),
            );
            return Number(result) === 1;
        } catch (error) {
            console.error('[RedisCleanup] Error releasing lock:', error.message);
            return false;
        }
    }

    // Start periodic cleanup (runs every 5 minutes)
    start() {
        if (this.isRunning) {
            console.log('[RedisCleanup] Already running');
            return;
        }

        this.cleanupInterval = setInterval(async () => {
            await this.cleanupOrphanedCalls();
        }, 5 * 60 * 1000);

        this.isRunning = true;
        console.log(`[RedisCleanup] Started on worker ${this.workerId} (runs every 5 minutes)`);

        // Run immediately on start
        this.cleanupOrphanedCalls();
    }

    // Clean up orphaned call ownership and state
    async cleanupOrphanedCalls() {
        const hasLock = await this.acquireLock();

        if (!hasLock) {
            console.log('[RedisCleanup] Skipping - another worker holds the lock');
            return;
        }

        try {
            let cleaned = 0;
            let kept = 0;

            // Scan all call ownership keys
            for await (const key of redisBaseService.scanKeys('call:owner:*')) {
                const callId = key.replace('call:owner:', '');

                try {
                    // Check if call exists in database
                    const call = await CallRepository.findByWacid(callId);

                    if (!call) {
                        // Call doesn't exist - clean up Redis
                        await this.cleanupCall(callId);
                        cleaned++;
                        console.log(`[RedisCleanup] Removed ownership for non-existent call ${callId}`);
                        continue;
                    }

                    // Check if call is in terminal state
                    if ([CallStatus.TERMINATED, CallStatus.FAILED, CallStatus.CANCELLED].includes(call.status)) {
                        await this.cleanupCall(callId);
                        cleaned++;
                        console.log(`[RedisCleanup] Removed ownership for terminated call ${callId} (status: ${call.status})`);
                        continue;
                    }

                    // Call is active - keep ownership
                    kept++;

                } catch (callError) {
                    console.error(`[RedisCleanup] Error checking call ${callId}:`, callError.message);
                }
            }

            if (cleaned > 0) {
                console.log(`[RedisCleanup] Worker ${this.workerId} cleanup complete - Cleaned: ${cleaned}, Kept: ${kept}`);
            }

        } catch (error) {
            console.error('[RedisCleanup] Error during cleanup:', error.message);
        } finally {
            await this.releaseLock();
        }
    }

    // Clean up all Redis data for a call.
    // Uses direct key deletion instead of releaseCall() because cleanup
    // runs on whichever worker wins the distributed lock, not necessarily
    // the worker that owns the call. The ownership check in releaseCall()
    // would block cleanup of calls owned by other (possibly crashed) workers.
    async cleanupCall(callId) {
        try {
            await Promise.all([
                redisBaseService.del(callOwnershipService.getKey(callId)),
                callStateCache.deleteCallState(callId)
            ]);

            console.log(`[RedisCleanup] Cleaned up all data for call ${callId}`);
            return true;
        } catch (error) {
            console.error(`[RedisCleanup] Error cleaning up call ${callId}:`, error.message);
            return false;
        }
    }

    // Stop the cleanup service
    async stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            this.isRunning = false;
            console.log('[RedisCleanup] Stopped');
        }
    }

    // Get service status
    async getStatus() {
        const lockOwner = await redisBaseService.get(this.lockKey);

        return {
            isRunning: this.isRunning,
            interval: this.cleanupInterval ? '5 minutes' : null,
            workerId: this.workerId,
            hasLock: lockOwner === this.workerId,
            lockOwner: lockOwner
        };
    }
}

export const redisCleanupService = new RedisCleanupService();
