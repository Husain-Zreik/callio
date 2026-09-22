// src/services/redis/PresenceService.js
import { redisBaseService } from "./RedisBaseService.js";
import { config } from "../../../config/envConfig.js";

/**
 * Manages user presence tracking across distributed workers.
 * Tracks which users are online and their active socket connections.
 *
 * FCM token design:
 *  - Each user keeps a SET of FCM tokens (one per device): user:fcm_tokens:{userId}
 *  - Each token maps to its current owner:               fcm_token:owner:{token}
 *  - Each socket records which token it registered with: socket:fcm:{socketId}
 *
 * This allows a user to be online on multiple devices simultaneously while
 * still receiving push notifications on any offline device, and handles the
 * case where an agent logs into another agent's account on their device.
 */
class PresenceService {
    constructor() {
        this.isInitialized = false;
        this.workerId = config.runtime.workerId;

        // Live session keys (user:sockets, business:online_users, socket:fcm).
        // These reflect real-time connection state — 24 h is fine because
        // they are recreated automatically on every socket reconnect.
        this.ttl = 86400; // 24 hours

        // Device registry keys (user:devices, user:fcm_tokens, device:owner,
        // fcm_token:owner).  These must survive across days/weeks of inactivity
        // so that offline push notifications keep working.  The TTL is reset on
        // every device:register event so an active device never disappears.
        this.deviceTtl = 86400 * 30; // 30 days
    }

    // Initialize the service (call during app startup)
    async init() {
        if (this.isInitialized) return;

        await redisBaseService.init();
        this.isInitialized = true;
        console.log(`[Presence] Worker ${this.workerId} initialized`);
    }

    // Ensure service is initialized
    async ensureInitialized() {
        if (!this.isInitialized) {
            await this.init();
        }
    }

    // Redis key builders
    #userSocketsKey(userId) { return `user:sockets:${userId}`; }
    #businessUsersKey(bizId) { return `business:online_users:${bizId}`; }
    #userFcmTokensKey(userId) { return `user:fcm_tokens:${userId}`; } // SET of tokens per user
    #fcmOwnerKey(token) { return `fcm_token:owner:${token}`; }
    #socketFcmKey(socketId) { return `socket:fcm:${socketId}`; }   // which token this socket brought
    // Device registry
    #userDevicesKey(userId) { return `user:devices:${userId}`; }    // HASH { deviceId → JSON }
    #deviceOwnerKey(deviceId) { return `device:owner:${deviceId}`; }  // which userId owns this device

    // Track a new connection
    async trackConnection(userId, businessId, socketId, fcmToken = null) {
        await this.ensureInitialized();

        // Validate FCM token to prevent storing "undefined" or "null" strings
        if (fcmToken && (fcmToken === "undefined" || fcmToken === "null" || fcmToken.trim() === "")) {
            fcmToken = null;
        }

        const userSocketsKey = this.#userSocketsKey(userId);
        const businessOnlineKey = this.#businessUsersKey(businessId);
        const userFcmTokensKey = this.#userFcmTokensKey(userId);
        const tokenOwnerKey = fcmToken ? this.#fcmOwnerKey(fcmToken) : null;

        try {
            // Reject tokens FCM has previously confirmed as invalid — prevents the
            // re-registration loop where a mobile app reconnects with the same stale
            // token immediately after the server removes it.
            if (fcmToken) {
                const isBlacklisted = await redisBaseService.get(`fcm:invalid:${fcmToken}`);
                if (isBlacklisted) {
                    console.log(`[Presence] User ${userId}: skipping known-invalid FCM token (blacklisted)`);
                    fcmToken = null;
                }
            }

            // If this FCM token was previously registered to a different user
            // (e.g. an agent logged into another agent's account), remove the
            // token from the previous owner's FCM set ONLY.
            // We must NOT touch the previous owner's socket set — they may still
            // be actively connected on their own devices.
            if (fcmToken) {
                const previousOwnerId = await redisBaseService.get(tokenOwnerKey);
                if (
                    previousOwnerId &&
                    String(previousOwnerId) !== String(userId)
                ) {
                    console.log(
                        `[Presence] Device switch detected: Token ${fcmToken.substring(0, 10)}... moved from User ${previousOwnerId} to User ${userId}. Removing token from previous owner only.`,
                    );
                    // Only remove this specific token from the previous owner's set.
                    // Their sockets and other tokens remain untouched.
                    await redisBaseService.srem(
                        this.#userFcmTokensKey(previousOwnerId),
                        fcmToken,
                    );
                }
            }

            const pipeline = redisBaseService.pipeline();

            // Add socket to user's socket set
            pipeline.sadd(userSocketsKey, socketId);
            pipeline.expire(userSocketsKey, this.ttl);

            // Add user to business online users
            pipeline.sadd(businessOnlineKey, String(userId));
            pipeline.expire(businessOnlineKey, this.ttl);

            // Store FCM token in user's token set and update ownership.
            // Use deviceTtl (30 days) so tokens survive periods of inactivity.
            if (fcmToken) {
                pipeline.sadd(userFcmTokensKey, fcmToken);
                pipeline.expire(userFcmTokensKey, this.deviceTtl);

                pipeline.set(tokenOwnerKey, String(userId));
                pipeline.expire(tokenOwnerKey, this.deviceTtl);

                // socket:fcm only needs to live as long as the session
                pipeline.set(this.#socketFcmKey(socketId), fcmToken);
                pipeline.expire(this.#socketFcmKey(socketId), this.ttl);
            }

            await redisBaseService.executePipeline(pipeline);

            console.log(
                `[Presence] User ${userId} connected (Socket: ${socketId})`,
            );
        } catch (error) {
            console.error(
                "[Presence] Error tracking connection:",
                error.message,
            );
        }
    }

    // Remove a connection
    async trackDisconnection(userId, businessId, socketId) {
        await this.ensureInitialized();

        const userSocketsKey = this.#userSocketsKey(userId);
        const businessOnlineKey = this.#businessUsersKey(businessId);
        const socketFcmKey = this.#socketFcmKey(socketId);

        try {
            // Remove socket from user's socket set
            await redisBaseService.srem(userSocketsKey, socketId);

            // Clean up the socket→FCM mapping.
            // We intentionally keep the FCM token in user:fcm_tokens:{userId}
            // so that offline push notifications can still be delivered to the
            // device even after it disconnects from the WebSocket.
            const fcmToken = await redisBaseService.get(socketFcmKey);
            if (fcmToken) {
                await redisBaseService.del(socketFcmKey);
                // Only clear the token ownership if this user still owns it.
                // (Another user may have claimed it since this socket connected.)
                const currentOwner = await redisBaseService.get(
                    this.#fcmOwnerKey(fcmToken),
                );
                if (String(currentOwner) !== String(userId)) {
                    // Token already moved to another user — remove it from our
                    // FCM set so we don't send push to the wrong device.
                    await redisBaseService.srem(
                        this.#userFcmTokensKey(userId),
                        fcmToken,
                    );
                    console.log(
                        `[Presence] Token ${fcmToken.substring(0, 10)}... already belongs to User ${currentOwner}, removed from User ${userId}'s set.`,
                    );
                }
            }

            // Check if user has any other active sockets
            const remainingSockets = await redisBaseService.scard(userSocketsKey);

            if (remainingSockets === 0) {
                // No more sockets — user is completely offline
                await redisBaseService.srem(businessOnlineKey, String(userId));
                console.log(
                    `[Presence] User ${userId} is now completely offline`,
                );
            } else {
                console.log(
                    `[Presence] User ${userId} disconnected (${remainingSockets} socket(s) remaining)`,
                );
            }
        } catch (error) {
            console.error(
                "[Presence] Error tracking disconnection:",
                error.message,
            );
        }
    }

    // Check if a user is connected
    async isUserConnected(userId) {
        await this.ensureInitialized();

        const userSocketsKey = this.#userSocketsKey(userId);

        try {
            const count = await redisBaseService.scard(userSocketsKey);
            return count > 0;
        } catch (error) {
            console.error(
                "[Presence] Error checking user connection:",
                error.message,
            );
            return false;
        }
    }

    // Get number of active sockets for a user
    async getUserSocketCount(userId) {
        await this.ensureInitialized();

        const userSocketsKey = this.#userSocketsKey(userId);

        try {
            return await redisBaseService.scard(userSocketsKey);
        } catch (error) {
            console.error(
                "[Presence] Error getting socket count:",
                error.message,
            );
            return 0;
        }
    }

    // Get all socket IDs for a user
    async getUserSockets(userId) {
        await this.ensureInitialized();

        const userSocketsKey = this.#userSocketsKey(userId);

        try {
            return await redisBaseService.smembers(userSocketsKey);
        } catch (error) {
            console.error(
                "[Presence] Error getting user sockets:",
                error.message,
            );
            return [];
        }
    }

    // ── Device Registry ──────────────────────────────────────────────────
    //
    // Stores richer per-device metadata (device_id, device_info, last_seen)
    // in a HASH alongside the flat token SET that the rest of the system
    // already uses.  Both are kept in sync so callers that only need tokens
    // can still use getCachedFcmTokens() without change.
    //
    // Redis layout:
    //   user:devices:{userId}    HASH { deviceId → JSON{fcm_token,device_info,registered_at,last_seen_at} }
    //   device:owner:{deviceId}  STRING userId  (for cross-user account-switch detection)

    /**
     * Register (or update) a device for a user.
     * Handles account switching: if the same physical device was previously
     * owned by a different user, that user's device entry and FCM token are
     * cleaned up before the new owner is registered.
     *
     * @param {string|number} userId
     * @param {string}        deviceId   - stable app-generated UUID
     * @param {string}        fcmToken   - current FCM registration token
     * @param {object}        deviceInfo - { platform, os_version, app_version, model, … }
     */
    async registerDevice(userId, deviceId, fcmToken, deviceInfo = {}) {
        await this.ensureInitialized();

        // Validate FCM token to prevent storing "undefined" or "null" strings
        if (fcmToken && (fcmToken === "undefined" || fcmToken === "null" || fcmToken.trim() === "")) {
            console.warn(`[Presence] Rejecting invalid FCM token for User ${userId}: ${fcmToken}`);
            return;
        }

        const userDevicesKey = this.#userDevicesKey(userId);
        const deviceOwnerKey = this.#deviceOwnerKey(deviceId);
        const userFcmTokenKey = this.#userFcmTokensKey(userId);

        try {
            // Reject tokens FCM has previously confirmed as invalid.
            if (fcmToken) {
                const isBlacklisted = await redisBaseService.get(`fcm:invalid:${fcmToken}`);
                if (isBlacklisted) {
                    console.log(`[Presence] User ${userId}: device ${deviceId} sent known-invalid FCM token — ignoring`);
                    return;
                }
            }

            // ── 1. Account-switch: same physical device, different user ──────
            const previousOwnerId = await redisBaseService.get(deviceOwnerKey);
            if (previousOwnerId && String(previousOwnerId) !== String(userId)) {
                console.log(
                    `[Presence] Account switch on device ${deviceId}: ` +
                    `removing from User ${previousOwnerId}, assigning to User ${userId}`,
                );
                // Remove device entry from previous owner
                const prevDeviceData = await redisBaseService.hget(
                    this.#userDevicesKey(previousOwnerId), deviceId,
                );
                if (prevDeviceData) {
                    const parsed = JSON.parse(prevDeviceData);
                    // Remove old FCM token from previous owner's token SET
                    await redisBaseService.srem(
                        this.#userFcmTokensKey(previousOwnerId), parsed.fcm_token,
                    );
                    // Remove old owner mapping for that specific token
                    await redisBaseService.del(this.#fcmOwnerKey(parsed.fcm_token));
                }
                await redisBaseService.hdel(
                    this.#userDevicesKey(previousOwnerId), deviceId,
                );
            }

            // ── 2. Token rotation on the same user's other devices ───────────
            // If this FCM token is already stored under a different device_id for
            // THIS user (e.g. app reinstall gave the same token a new device_id),
            // remove that stale device entry.
            const existingRaw = await redisBaseService.hgetall(userDevicesKey);
            if (existingRaw) {
                for (const [existingDeviceId, json] of Object.entries(existingRaw)) {
                    if (existingDeviceId === deviceId) continue;
                    const entry = JSON.parse(json);
                    if (entry.fcm_token === fcmToken) {
                        console.log(
                            `[Presence] Token migrated to new device_id for User ${userId}. ` +
                            `Removing stale device ${existingDeviceId}.`,
                        );
                        await redisBaseService.hdel(userDevicesKey, existingDeviceId);
                        await redisBaseService.srem(userFcmTokenKey, fcmToken);
                    }
                }
            }

            // ── 3. Write the device entry ────────────────────────────────────
            const now = new Date().toISOString();
            const existing = existingRaw?.[deviceId]
                ? JSON.parse(existingRaw[deviceId])
                : null;

            const deviceEntry = JSON.stringify({
                fcm_token: fcmToken,
                device_info: deviceInfo,
                registered_at: existing?.registered_at ?? now,
                last_seen_at: now,
            });

            const pipeline = redisBaseService.pipeline();

            // All device-registry keys use deviceTtl (30 days), reset on every
            // register call so an actively-used device never expires.
            pipeline.hset(userDevicesKey, deviceId, deviceEntry);
            pipeline.expire(userDevicesKey, this.deviceTtl);

            pipeline.sadd(userFcmTokenKey, fcmToken);
            pipeline.expire(userFcmTokenKey, this.deviceTtl);

            pipeline.set(this.#fcmOwnerKey(fcmToken), String(userId));
            pipeline.expire(this.#fcmOwnerKey(fcmToken), this.deviceTtl);

            pipeline.set(deviceOwnerKey, String(userId));
            pipeline.expire(deviceOwnerKey, this.deviceTtl);

            await redisBaseService.executePipeline(pipeline);

            console.log(
                `[Presence] Device ${deviceId} registered for User ${userId} ` +
                `(platform: ${deviceInfo?.platform ?? 'unknown'})`,
            );
        } catch (error) {
            console.error('[Presence] Error registering device:', error.message);
        }
    }

    /**
     * Unregister a specific device (e.g. on explicit logout or token revocation).
     */
    async unregisterDevice(userId, deviceId) {
        await this.ensureInitialized();

        const userDevicesKey = this.#userDevicesKey(userId);
        const deviceOwnerKey = this.#deviceOwnerKey(deviceId);
        const userFcmTokenKey = this.#userFcmTokensKey(userId);

        try {
            const raw = await redisBaseService.hget(userDevicesKey, deviceId);
            if (!raw) return;

            const { fcm_token } = JSON.parse(raw);

            const pipeline = redisBaseService.pipeline();
            pipeline.hdel(userDevicesKey, deviceId);
            pipeline.srem(userFcmTokenKey, fcm_token);
            pipeline.del(this.#fcmOwnerKey(fcm_token));
            pipeline.del(deviceOwnerKey);
            await redisBaseService.executePipeline(pipeline);

            console.log(`[Presence] Device ${deviceId} unregistered for User ${userId}`);
        } catch (error) {
            console.error('[Presence] Error unregistering device:', error.message);
        }
    }

    /**
     * Get all registered devices for a user with full metadata.
     * @returns {Array<{device_id, fcm_token, device_info, registered_at, last_seen_at}>}
     */
    async getDevices(userId) {
        await this.ensureInitialized();

        try {
            const raw = await redisBaseService.hgetall(this.#userDevicesKey(userId));
            if (!raw) return [];

            return Object.entries(raw).map(([deviceId, json]) => ({
                device_id: deviceId,
                ...JSON.parse(json),
            }));
        } catch (error) {
            console.error('[Presence] Error getting devices:', error.message);
            return [];
        }
    }

    /**
     * Remove a single FCM token (e.g. if it returns NotRegistered).
     */
    async removeFcmToken(token) {
        await this.ensureInitialized();
        const ownerKey = this.#fcmOwnerKey(token);

        try {
            // GETDEL atomically reads and deletes the owner key.
            // Only the first worker to call this wins — others get null and skip,
            // preventing redundant removals across concurrent workers.
            const userId = await redisBaseService.getdel(ownerKey);
            if (!userId) {
                // Owner key gone but token may still sit in a user's FCM set.
                // Blacklist it so trackConnection/registerDevice reject re-registration,
                // and getCachedFcmTokens will evict it on the next read.
                await redisBaseService.set(`fcm:invalid:${token}`, '1');
                await redisBaseService.expire(`fcm:invalid:${token}`, 604800);
                return false;
            }

            const pipeline = redisBaseService.pipeline();
            pipeline.srem(this.#userFcmTokensKey(userId), token);

            const userDevicesKey = this.#userDevicesKey(userId);
            const devices = await redisBaseService.hgetall(userDevicesKey);
            if (devices) {
                for (const [deviceId, json] of Object.entries(devices)) {
                    const parsed = JSON.parse(json);
                    if (parsed.fcm_token === token) {
                        pipeline.hdel(userDevicesKey, deviceId);
                        pipeline.del(this.#deviceOwnerKey(deviceId));
                        console.log(`[Presence] Cleaned up device registry for device ${deviceId} (User ${userId})`);
                    }
                }
            }

            // Blacklist for 7 days so reconnects don't re-register the same stale token.
            pipeline.set(`fcm:invalid:${token}`, '1');
            pipeline.expire(`fcm:invalid:${token}`, 604800);

            await redisBaseService.executePipeline(pipeline);
            console.log(`[Presence] Removed invalid FCM token ${token.substring(0, 10)}... for User ${userId}`);
            return true;
        } catch (error) {
            console.error('[Presence] Error removing stale FCM token:', error.message);
            return false;
        }
    }

    // ── End Device Registry ──────────────────────────────────────────────

    // Get all cached FCM tokens for a user (one per registered device)
    async getCachedFcmTokens(userId) {
        await this.ensureInitialized();

        const userFcmTokensKey = this.#userFcmTokensKey(userId);

        try {
            const tokens = await redisBaseService.smembers(userFcmTokensKey);
            if (!tokens?.length) return [];

            const candidates = tokens.filter(t => t && t !== "undefined" && t !== "null" && t.trim() !== "");
            if (!candidates.length) return [];

            // Batch-check blacklist — evicts tokens whose owner key was missing when
            // FCM rejected them, breaking the infinite invalid-argument spam loop.
            const pipeline = redisBaseService.pipeline();
            for (const t of candidates) pipeline.get(`fcm:invalid:${t}`);
            const results = await redisBaseService.executePipeline(pipeline);

            const valid = [], stale = [];
            for (let i = 0; i < candidates.length; i++) {
                (results[i] ? stale : valid).push(candidates[i]);
            }
            if (stale.length) {
                await redisBaseService.srem(userFcmTokensKey, ...stale);
            }
            return valid;
        } catch (error) {
            console.error("[Presence] Error getting FCM tokens:", error.message);
            return [];
        }
    }

    // Get all connected user IDs for a business
    async getConnectedUserIds(businessId) {
        await this.ensureInitialized();

        const businessOnlineKey = this.#businessUsersKey(businessId);

        try {
            const userIds = await redisBaseService.smembers(businessOnlineKey);
            return new Set(userIds.map(String));
        } catch (error) {
            console.error(
                "[Presence] Error getting connected users:",
                error.message,
            );
            return new Set();
        }
    }

    // Get count of online users for a business
    async getOnlineUserCount(businessId) {
        await this.ensureInitialized();

        const businessOnlineKey = this.#businessUsersKey(businessId);

        try {
            return await redisBaseService.scard(businessOnlineKey);
        } catch (error) {
            console.error(
                "[Presence] Error getting online count:",
                error.message,
            );
            return 0;
        }
    }

    // Clear all presence data (use cautiously, typically on server startup)
    async clearAllPresence() {
        await this.ensureInitialized();

        try {
            const patterns = [
                "user:sockets:*",
                "business:online_users:*",
                "user:fcm_tokens:*",
                "user:devices:*",
                "device:owner:*",
                "socket:fcm:*",
            ];

            let totalCleared = 0;

            for (const pattern of patterns) {
                const keysToDelete = [];

                // Use SCAN to collect keys safely
                for await (const key of redisBaseService.scanKeys(pattern)) {
                    keysToDelete.push(key);

                    // Delete in batches of 100
                    if (keysToDelete.length >= 100) {
                        await redisBaseService.del(...keysToDelete);
                        totalCleared += keysToDelete.length;
                        keysToDelete.length = 0;
                    }
                }

                // Delete remaining keys
                if (keysToDelete.length > 0) {
                    await redisBaseService.del(...keysToDelete);
                    totalCleared += keysToDelete.length;
                }
            }

            console.log(`[Presence] Cleared ${totalCleared} presence keys`);
        } catch (error) {
            console.error(
                "[Presence] Error clearing presence data:",
                error.message,
            );
        }
    }

    // Clear presence data for a specific user
    async clearUserPresence(userId, businessId) {
        await this.ensureInitialized();

        const userSocketsKey = this.#userSocketsKey(userId);
        const businessOnlineKey = this.#businessUsersKey(businessId);
        const userFcmTokensKey = this.#userFcmTokensKey(userId);

        try {
            // Also clear fcm_token:owner entries for all tokens this user owns
            const tokens = await redisBaseService.smembers(userFcmTokensKey);
            const ownerKeysToDelete = tokens.map((t) => this.#fcmOwnerKey(t));

            // Also clear device:owner entries for all devices this user owns
            const userDevicesKey = this.#userDevicesKey(userId);
            const deviceRaw = await redisBaseService.hgetall(userDevicesKey);
            const deviceOwnerKeysToDelete = deviceRaw
                ? Object.keys(deviceRaw).map((d) => this.#deviceOwnerKey(d))
                : [];

            const keysToDelete = [
                userSocketsKey,
                userFcmTokensKey,
                userDevicesKey,
                ...ownerKeysToDelete,
                ...deviceOwnerKeysToDelete,
            ];
            await redisBaseService.del(...keysToDelete);
            await redisBaseService.srem(businessOnlineKey, String(userId));

            console.log(`[Presence] Cleared presence data for user ${userId}`);
        } catch (error) {
            console.error(
                "[Presence] Error clearing user presence:",
                error.message,
            );
        }
    }

    // Get presence statistics
    async getPresenceStats() {
        await this.ensureInitialized();

        try {
            const patterns = [
                "user:sockets:*",
                "business:online_users:*",
                "user:fcm_tokens:*",
            ];

            const counts = await Promise.all(
                patterns.map(async (pattern) => {
                    let count = 0;
                    for await (const _ of redisBaseService.scanKeys(pattern)) {
                        count++;
                    }
                    return count;
                }),
            );

            return {
                totalConnectedUsers: counts[0],
                totalBusinesses: counts[1],
                totalFcmTokens: counts[2],
            };
        } catch (error) {
            console.error("[Presence] Error getting stats:", error.message);
            return {
                totalConnectedUsers: 0,
                totalBusinesses: 0,
                totalFcmTokens: 0,
            };
        }
    }

    // Get service status
    getStatus() {
        return {
            isInitialized: this.isInitialized,
            workerId: this.workerId,
            ttl: this.ttl,
        };
    }
}

export const presenceService = new PresenceService();
