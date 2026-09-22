// src/repositories/NotificationRepository.js
import connection from "../../config/dbConnection.js";

// 5-minute in-process cache for getUserFcmToken lookups.
// Eliminates repeated DB hits when agents reconnect after a PM2 restart.
const FCM_CACHE_TTL_MS = 5 * 60 * 1000;
const FCM_CACHE_MAX_SIZE = 500;
const _fcmTokenCache = new Map(); // `${userId}:${deviceId}` → { token, expiresAt }

function _getCachedFcmToken(userId, deviceId) {
    const key = `${userId}:${deviceId ?? 'null'}`;
    const entry = _fcmTokenCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { _fcmTokenCache.delete(key); return undefined; }
    return entry.token; // may be null — still a valid cached value
}

function _setCachedFcmToken(userId, deviceId, token) {
    const key = `${userId}:${deviceId ?? 'null'}`;
    _fcmTokenCache.set(key, { token, expiresAt: Date.now() + FCM_CACHE_TTL_MS });

    // Evict expired entries when the cache exceeds its size cap.
    // O(n) sweep at insert time — amortised O(1) per insert.
    if (_fcmTokenCache.size > FCM_CACHE_MAX_SIZE) {
        const now = Date.now();
        for (const [k, v] of _fcmTokenCache) {
            if (now > v.expiresAt) _fcmTokenCache.delete(k);
        }
    }
}

class NotificationRepository {
    // Returns OneSignal subscription IDs for all logged-in users.
    async getLoggedInSubscriptionIds(userIds) {
        const userIdsArray = Array.isArray(userIds) ? userIds : [userIds];

        if (userIdsArray.length === 0) {
            return [];
        }

        const placeholders = userIdsArray.map(() => "?").join(",");
        const [rows] = await connection.execute(
            `SELECT subscription_id
             FROM notification_subscriptions
             WHERE user_id IN (${placeholders})
               AND is_logged_in = 1`,
            userIdsArray,
        );
        return rows.map((row) => row.subscription_id);
    }

    // Returns OneSignal subscription IDs for logged-in users with inactive (background) tabs.
    async getInactiveSubscriptionIds(userIds) {
        const userIdsArray = Array.isArray(userIds) ? userIds : [userIds];

        if (userIdsArray.length === 0) {
            return [];
        }

        const placeholders = userIdsArray.map(() => "?").join(",");
        const [rows] = await connection.execute(
            `SELECT subscription_id
             FROM notification_subscriptions
             WHERE user_id IN (${placeholders})
               AND is_logged_in = 1
               AND is_active = 0`,
            userIdsArray,
        );
        return rows.map((row) => row.subscription_id);
    }

    // Returns whether unassigned chat notifications should be limited to the
    // assigned agent only (true = notify no one until assigned). Defaults to
    // true when the business has no settings row yet.
    async getNotifyOnlyAssignedAgent(businessId) {
        const [rows] = await connection.execute(
            `SELECT notify_only_assigned_agent
             FROM business_settings
             WHERE business_id = ?
             LIMIT 1`,
            [businessId],
        );
        if (rows.length === 0 || rows[0].notify_only_assigned_agent === null) {
            return true;
        }
        return Boolean(rows[0].notify_only_assigned_agent);
    }

    // Returns IDs of all assignable and available users for a business.
    async getBusinessAssignableUserIds(businessId) {
        const [rows] = await connection.execute(
            `SELECT id as user_id
             FROM users
             WHERE business_id = ?
               AND is_assignable = 1
               AND is_available = 1`,
            [businessId],
        );
        return rows.map((row) => row.user_id);
    }

    async getBusinessSubscriptionIds(businessId) {
        const [rows] = await connection.execute(
            `SELECT subscription_id
             FROM notification_subscriptions
             WHERE business_id = ?
               AND is_logged_in = 1`,
            [businessId],
        );
        return rows.map((row) => row.subscription_id);
    }

    // Get FCM token for a single user ID.
    // Results are cached in-process for 5 minutes to avoid repeated DB hits
    // on rapid reconnects (e.g. after a PM2 restart).
    async getUserFcmToken(userId, deviceId = null) {
        const cached = _getCachedFcmToken(userId, deviceId);
        if (cached !== undefined) return cached;

        let token = null;

        if (deviceId) {
            const [deviceRows] = await connection.execute(
                "SELECT fcm_token FROM user_devices WHERE user_id = ? AND device_id = ? LIMIT 1",
                [userId, deviceId],
            );
            if (deviceRows.length > 0 && deviceRows[0].fcm_token) {
                token = deviceRows[0].fcm_token;
            }
        }

        if (!token) {
            const [rows] = await connection.execute(
                "SELECT fcm_token FROM users WHERE id = ? LIMIT 1",
                [userId],
            );
            token = rows.length > 0 ? rows[0].fcm_token : null;
        }

        _setCachedFcmToken(userId, deviceId, token);
        return token;
    }

    // Delete notification subscriptions by their OneSignal subscription IDs.
    // Used to prune stale records when OneSignal returns invalid_subscription_ids.
    // Returns affected row count.
    async deleteBySubscriptionIds(subscriptionIds) {
        if (!subscriptionIds || subscriptionIds.length === 0) return 0;
        const placeholders = subscriptionIds.map(() => "?").join(",");
        const [result] = await connection.execute(
            `DELETE FROM notification_subscriptions WHERE subscription_id IN (${placeholders})`,
            subscriptionIds,
        );
        return result.affectedRows || 0;
    }

    // Permanently remove an invalid/expired FCM token from the database.
    // Nulls it in the users table and in the matching user_devices row —
    // must NOT delete the whole user_devices row, since that row may also
    // carry a still-valid voip_token (iOS) independent of this fcm_token's
    // validity; mirrors removeVoipToken's own column-only null below.
    async removeFcmToken(token) {
        await Promise.all([
            connection.execute(
                `UPDATE users SET fcm_token = NULL WHERE fcm_token = ?`,
                [token],
            ),
            connection.execute(
                `UPDATE user_devices SET fcm_token = NULL WHERE fcm_token = ?`,
                [token],
            ),
        ]);
    }

    // Permanently remove an invalid/expired VoIP push token. Only nulls the
    // voip_token column — unlike removeFcmToken, must NOT delete the whole
    // user_devices row, since the same device row also carries that
    // device's regular fcm_token (used for chat notifications), which is
    // still valid and must not be wiped out just because the VoIP token
    // specifically went stale.
    //
    // Looks up the owning user/device first so the caller can log who lost
    // VoIP push without a manual DB lookup after the fact — the row is gone
    // (nulled) by the time the caller would otherwise ask.
    async removeVoipToken(token) {
        const [rows] = await connection.execute(
            `SELECT ud.user_id, ud.device_id, u.business_id
             FROM user_devices ud
             LEFT JOIN users u ON u.id = ud.user_id
             WHERE ud.voip_token = ?
             LIMIT 1`,
            [token],
        );
        await connection.execute(
            `UPDATE user_devices SET voip_token = NULL WHERE voip_token = ?`,
            [token],
        );
        return rows[0] || null;
    }

    // Returns all FCM tokens from user_devices for the given user IDs.
    async getFcmTokensFromUserDevices(userIds) {
        const userIdsArray = Array.isArray(userIds) ? userIds : [userIds];
        if (userIdsArray.length === 0) return [];

        const placeholders = userIdsArray.map(() => "?").join(",");
        const [rows] = await connection.execute(
            `SELECT fcm_token FROM user_devices WHERE user_id IN (${placeholders}) AND fcm_token IS NOT NULL`,
            userIdsArray,
        );
        return rows.map((row) => row.fcm_token);
    }

    // Same as getFcmTokensFromUserDevices, but excludes iOS — iOS calls now
    // rely exclusively on the real VoIP push (ApnsVoipService); the FCM
    // fallback there was the source of most of the delivery ambiguity this
    // investigation traced (confirmed live: it was still what showed the
    // ring on a device with zero voip_token across all its registered
    // devices). Used only by delivery.js's call-delivery functions — every
    // other FCM send (chat notifications, etc.) still uses the unfiltered
    // getFcmTokensFromUserDevices above. Rows with no platform info are
    // treated as non-iOS (sent to) to avoid a silent regression for
    // whatever client type that represents — COALESCE is required for this,
    // not just documentation: device_info is nullable, and MySQL's NULL != 'ios'
    // evaluates to NULL (excluded by WHERE), not TRUE, so a bare
    // JSON_EXTRACT/!= comparison would silently drop exactly the rows this
    // comment claims to keep.
    // excludeDeviceId (2026-09-01, real bug found and fixed): notifyCallResolved
    // uses these two methods to dismiss a resolved call's stale ring on this
    // agent's OTHER devices. Without a way to exclude the device_id that
    // actually just accepted, the accepting device's own token was included
    // in that same fan-out — confirmed via real iOS device logs to be the
    // cause of every accepted call receiving a `call_ended` VoIP push ~1.6s
    // after answer and having CallManager.endCall torn down natively right
    // after connecting. `device_id IS NULL OR device_id != ?` (not a bare
    // `!=`) so devices with no recorded device_id aren't silently dropped —
    // MySQL's NULL != x is NULL (excluded by WHERE), not TRUE.
    async getFcmTokensForCallsFromUserDevices(userIds, excludeDeviceId = null) {
        const userIdsArray = Array.isArray(userIds) ? userIds : [userIds];
        if (userIdsArray.length === 0) return [];

        const placeholders = userIdsArray.map(() => "?").join(",");
        const excludeClause = excludeDeviceId ? "AND (device_id IS NULL OR device_id != ?)" : "";
        const [rows] = await connection.execute(
            `SELECT fcm_token FROM user_devices
             WHERE user_id IN (${placeholders})
               AND fcm_token IS NOT NULL
               AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(device_info, '$.platform')), '') != 'ios'
               ${excludeClause}`,
            excludeDeviceId ? [...userIdsArray, excludeDeviceId] : userIdsArray,
        );
        return rows.map((row) => row.fcm_token);
    }

    // Counterpart to getFcmTokensForCallsFromUserDevices above — iOS-only
    // instead of iOS-excluded. Used to send a visible alert notification
    // alongside the real VoIP push (delivery.js's notifyMobileDevices):
    // the VoIP push alone drives CallKit natively with no OS banner of its
    // own, so a killed/backgrounded device that dismisses/misses the CallKit
    // screen has nothing else telling it a call came in. Platform match is
    // exact ('ios'), unlike the != 'ios' exclusion above, since a row with no
    // platform info can't be assumed iOS.
    async getIosFcmTokensFromUserDevices(userIds, excludeDeviceId = null) {
        const userIdsArray = Array.isArray(userIds) ? userIds : [userIds];
        if (userIdsArray.length === 0) return [];

        const placeholders = userIdsArray.map(() => "?").join(",");
        const excludeClause = excludeDeviceId ? "AND (device_id IS NULL OR device_id != ?)" : "";
        const [rows] = await connection.execute(
            `SELECT fcm_token FROM user_devices
             WHERE user_id IN (${placeholders})
               AND fcm_token IS NOT NULL
               AND JSON_UNQUOTE(JSON_EXTRACT(device_info, '$.platform')) = 'ios'
               ${excludeClause}`,
            excludeDeviceId ? [...userIdsArray, excludeDeviceId] : userIdsArray,
        );
        return rows.map((row) => row.fcm_token);
    }

    // Returns all APNs VoIP push tokens (PushKit, iOS-only) from user_devices
    // for the given user IDs — separate column/channel from fcm_token, since
    // VoIP pushes go directly through APNs (ApnsVoipService), not FCM.
    // excludeDeviceId: see getFcmTokensForCallsFromUserDevices's doc comment above.
    async getVoipTokensFromUserDevices(userIds, excludeDeviceId = null) {
        const userIdsArray = Array.isArray(userIds) ? userIds : [userIds];
        if (userIdsArray.length === 0) return [];

        const placeholders = userIdsArray.map(() => "?").join(",");
        const excludeClause = excludeDeviceId ? "AND (device_id IS NULL OR device_id != ?)" : "";
        const [rows] = await connection.execute(
            `SELECT voip_token FROM user_devices
             WHERE user_id IN (${placeholders})
               AND voip_token IS NOT NULL
               ${excludeClause}`,
            excludeDeviceId ? [...userIdsArray, excludeDeviceId] : userIdsArray,
        );
        return rows.map((row) => row.voip_token);
    }
}

export default new NotificationRepository();
