// src/core/agents/PresenceService.js
import { redisBaseService } from "../../infra/redis/RedisBaseService.js";
import { config } from "../../../config/envConfig.js";

/**
 * Tracks which agents have live sockets, across all workers.
 *
 *   user:sockets:{userId}          SET of socket ids for that user (any worker)
 *   presence:worker:{workerId}     SET of "userId|socketId" owned by this worker
 *
 * The per-worker set is what lets a restarting worker remove only the sockets
 * it owned before it died — sockets on other workers are left alone. (The old
 * clearAllPresence() wiped every worker's presence on each worker's boot.)
 *
 * Push tokens are not cached here: they live in the database and are read at
 * send time.
 */
class PresenceService {
    constructor() {
        this.isInitialized = false;
        this.workerId = config.runtime.workerId;
        // Refreshed on every connect; long enough that a socket open all day
        // doesn't age out of its set.
        this.ttl = 86400 * 2;
    }

    async init() {
        if (this.isInitialized) return;
        await redisBaseService.init();
        this.isInitialized = true;
        console.log(`[Presence] Worker ${this.workerId} initialized`);
    }

    async ensureInitialized() {
        if (!this.isInitialized) await this.init();
    }

    #userSocketsKey(userId) { return `user:sockets:${userId}`; }
    #workerSocketsKey() { return `presence:worker:${this.workerId}`; }

    async trackConnection(userId, socketId) {
        await this.ensureInitialized();

        try {
            const userSocketsKey = this.#userSocketsKey(userId);
            const workerKey = this.#workerSocketsKey();

            const pipeline = redisBaseService.pipeline();
            pipeline.sadd(userSocketsKey, socketId);
            pipeline.expire(userSocketsKey, this.ttl);
            pipeline.sadd(workerKey, `${userId}|${socketId}`);
            pipeline.expire(workerKey, this.ttl);
            await redisBaseService.executePipeline(pipeline);

            console.log(`[Presence] User ${userId} connected (Socket: ${socketId})`);
        } catch (error) {
            console.error("[Presence] Error tracking connection:", error);
        }
    }

    async trackDisconnection(userId, socketId) {
        await this.ensureInitialized();

        try {
            const pipeline = redisBaseService.pipeline();
            pipeline.srem(this.#userSocketsKey(userId), socketId);
            pipeline.srem(this.#workerSocketsKey(), `${userId}|${socketId}`);
            await redisBaseService.executePipeline(pipeline);

            const remaining = await redisBaseService.scard(this.#userSocketsKey(userId));
            console.log(
                remaining === 0
                    ? `[Presence] User ${userId} is now completely offline`
                    : `[Presence] User ${userId} disconnected (${remaining} socket(s) remaining)`
            );
        } catch (error) {
            console.error("[Presence] Error tracking disconnection:", error);
        }
    }

    async getUserSocketCount(userId) {
        await this.ensureInitialized();
        try {
            return await redisBaseService.scard(this.#userSocketsKey(userId));
        } catch (error) {
            console.error("[Presence] Error getting socket count:", error);
            return 0;
        }
    }

    async getUserSockets(userId) {
        await this.ensureInitialized();
        try {
            return await redisBaseService.smembers(this.#userSocketsKey(userId));
        } catch (error) {
            console.error("[Presence] Error getting user sockets:", error);
            return [];
        }
    }

    /**
     * Remove the sockets this worker owned in a previous run. Called once at
     * startup, before this worker accepts connections — none of those sockets
     * can still be alive, since they were bound to this process.
     */
    async clearOwnStalePresence() {
        await this.ensureInitialized();

        try {
            const workerKey = this.#workerSocketsKey();
            const entries = await redisBaseService.smembers(workerKey);
            if (!entries?.length) return;

            const pipeline = redisBaseService.pipeline();
            for (const entry of entries) {
                const sep = entry.indexOf("|");
                if (sep === -1) continue;
                pipeline.srem(this.#userSocketsKey(entry.slice(0, sep)), entry.slice(sep + 1));
            }
            pipeline.del(workerKey);
            await redisBaseService.executePipeline(pipeline);

            console.log(`[Presence] Cleared ${entries.length} stale socket(s) from worker ${this.workerId}'s previous run`);
        } catch (error) {
            console.error("[Presence] Error clearing stale presence:", error);
        }
    }
}

export const presenceService = new PresenceService();
