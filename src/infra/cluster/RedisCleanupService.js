// src/infra/cluster/RedisCleanupService.js
import CallRepository from '../../persistence/CallRepository.js';
import { callOwnershipService } from './CallOwnershipService.js';
import { redisBaseService } from '../redis/RedisBaseService.js';
import { CallStatus, Channel } from '../../core/constants/CallConstants.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../logging/logger.js';

const log = logger('infra.cluster.RedisCleanupService');

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
        log.debug('Initialized');
    }

    // Acquire distributed lock for cleanup
    async acquireLock() {
        try {
            const claimed = await redisBaseService.setnx(this.lockKey, this.workerId, this.lockTTL);
            return claimed;
        } catch (error) {
            log.error({ err: error }, 'Error acquiring lock');
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
            log.error({ err: error }, 'Error releasing lock');
            return false;
        }
    }

    // Start periodic cleanup (runs every 5 minutes)
    start() {
        if (this.isRunning) {
            log.debug('Already running');
            return;
        }

        this.cleanupInterval = setInterval(async () => {
            await this.cleanupOrphanedCalls();
        }, 5 * 60 * 1000);

        this.isRunning = true;
        log.info('Started (runs every 5 minutes)');

        // Run immediately on start
        this.cleanupOrphanedCalls();
    }

    // Clean up orphaned call ownership and state
    async cleanupOrphanedCalls() {
        const hasLock = await this.acquireLock();

        if (!hasLock) {
            log.debug('Skipping - another worker holds the lock');
            return;
        }

        try {
            let cleaned = 0;
            let kept = 0;

            // Scan all call ownership keys
            for await (const key of redisBaseService.scanKeys('call:owner:*')) {
                // Ownership is keyed by <CHANNEL>:<providerCallId> (ChannelIngress).
                const callId = key.replace('call:owner:', '');
                const sep = callId.indexOf(':');
                // Keys written before ownership was namespaced carry no channel.
                const channel = sep > 0 ? callId.slice(0, sep) : Channel.WHATSAPP;
                const providerCallId = sep > 0 ? callId.slice(sep + 1) : callId;

                try {
                    // Check if call exists in database
                    const call = await CallRepository.findByProviderCallId(providerCallId, channel);

                    if (!call) {
                        // Call doesn't exist - clean up Redis
                        await this.cleanupCall(callId);
                        cleaned++;
                        log.info({ callId }, 'Removed ownership for non-existent call');
                        continue;
                    }

                    // Check if call is in terminal state
                    if ([CallStatus.TERMINATED, CallStatus.FAILED, CallStatus.CANCELLED].includes(call.status)) {
                        await this.cleanupCall(callId);
                        cleaned++;
                        log.info({ callId }, `Removed ownership for terminated call (status: ${call.status})`);
                        continue;
                    }

                    // Call is active - keep ownership
                    kept++;

                } catch (callError) {
                    log.error({ callId, err: callError }, 'Error checking call');
                }
            }

            if (cleaned > 0) {
                log.debug({ cleaned, kept }, 'Cleanup complete');
            }

        } catch (error) {
            log.error({ err: error }, 'Error during cleanup');
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
            await redisBaseService.del(callOwnershipService.getKey(callId));

            log.debug({ callId }, 'Cleaned up all data');
            return true;
        } catch (error) {
            log.error({ callId, err: error }, 'Error cleaning up call');
            return false;
        }
    }

    // Stop the cleanup service
    async stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            this.isRunning = false;
            log.info('Stopped');
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
