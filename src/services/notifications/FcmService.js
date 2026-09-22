import admin from "firebase-admin";
import { config } from "../../../config/envConfig.js";
import { notifyLog } from "./notificationLogger.js";
import { presenceService } from "../redis/PresenceService.js";
import notificationRepository from "../../repositories/NotificationRepository.js";

class FcmService {
    constructor() {
        try {
            // Reuse existing default app if already initialized — prevents
            // "app already exists" errors if the module is somehow evaluated twice.
            const existingApp = admin.apps.find(a => a?.name === '[DEFAULT]');
            const app = existingApp ?? admin.initializeApp({
                credential: admin.credential.cert(config.firebase.credentialsPath),
            });
            this.fcm = admin.messaging(app);
            console.log("[FCM] Firebase Admin initialized");
        } catch (error) {
            console.error("[FCM] Initialization error:", error.message);
            // this.fcm intentionally left undefined — sendToTokens guards against this
        }
    }

    /**
     * Send notification to specific tokens
     * @param {string[]} tokens
     * @param {object} payload - { title, body, data, ttlSeconds, silent }
     * @param {number|null} payload.ttlSeconds - How long FCM should keep retrying
     *   delivery to an offline device before giving up. Omitted (null) keeps
     *   FCM's own default (4 weeks) — right for regular chat notifications,
     *   which should still arrive whenever the device reconnects. Call-related
     *   pushes (delivery.js's notifyMobileDevices/notifyMobileDevicesCallEnded)
     *   pass a short one instead — without it, a device offline when a call
     *   rang could reconnect hours later and get shown a stale `call` push,
     *   ringing for a call long since over. Matches ApnsVoipService.js's
     *   note.expiry, which already does this on the iOS side.
     * @param {boolean} payload.silent - For iOS only (Android never carried an
     *   OS-visible `notification`/`android.notification` block to begin with,
     *   see below): omits `aps.alert`/`sound`/`badge` so this arrives as a
     *   background push instead of an alert one, meaning iOS won't
     *   auto-display anything for it — the app's own UI (MIDLR_APP's
     *   CallKit-driven incoming-call screen) becomes the only thing the user
     *   sees. Call-type pushes pass this (2026-08-20 fix — a call push's
     *   `alert` was showing a redundant plain "Incoming call" OS notification
     *   alongside the app's own native CallKit ring); regular chat
     *   notifications must not, since nothing else shows anything for those.
     *   Trade-off accepted knowingly: a background push has weaker delivery
     *   guarantees than an alert one (APNs may delay/drop it under Low Power
     *   Mode or once a device's background-push budget is spent) — the
     *   *correct* fix per Apple's own guidance is a real PushKit VoIP push
     *   (see ApnsVoipService.js), which is silent by OS design with none of
     *   this throttling, but that path's registration was confirmed dead
     *   end-to-end (see push_notification_service.dart's own comment) and
     *   fixing that is native-entitlement work out of scope here.
     */
    async sendToTokens(tokens, { title, body, data = {}, ttlSeconds = null, silent = false }) {
        if (!tokens || tokens.length === 0) return;

        if (!this.fcm) {
            console.error('[FCM] Service not initialized — skipping notification to', tokens.length, 'device(s)');
            return;
        }

        // Filter null/undefined/empty tokens before sending — FCM returns
        // messaging/invalid-argument for these, burning the whole multicast call.
        const validTokens = tokens.filter(t => t && typeof t === 'string' && t.length > 0);
        if (validTokens.length === 0) return;

        const message = {
            // notification: { title, body }, // Removed so app can handle manually and cancel by ID
            data: this.formatData({
                ...data,
                notification_title: title,
                notification_body: body,
            }),
            tokens: validTokens,
            android: {
                priority: "high",
                // AndroidConfig.ttl is in milliseconds.
                ...(ttlSeconds != null ? { ttl: ttlSeconds * 1000 } : {}),
                // notification: {
                //     sound: "default",
                //     clickAction: "FLUTTER_NOTIFICATION_CLICK",
                // },
            },
            apns: {
                payload: {
                    aps: silent
                        ? { contentAvailable: true }
                        : {
                            alert: {
                                title,
                                body,
                            },
                            sound: "default",
                            badge: 1,
                            contentAvailable: true,
                        },
                },
                headers: {
                    // A background push (no alert/sound/badge) is only valid
                    // at priority 5 — APNs requires immediate (10) delivery
                    // be paired with visible content, per Apple's Notification
                    // Programming Guide.
                    "apns-priority": silent ? "5" : "10",
                },
            },
        };

        try {
            const response = await this.fcm.sendEachForMulticast(message);
            notifyLog(
                `FCM Multicast Sent: ${response.successCount} success, ${response.failureCount} failure`,
            );

            if (response.failureCount > 0) {
                let invalidTokenCount = 0;
                const failureCodes = {};

                for (let idx = 0; idx < response.responses.length; idx++) {
                    const res = response.responses[idx];
                    if (!res.success) {
                        const token = validTokens[idx];
                        const errCode = res.error?.code;
                        const errMsg = res.error?.message;
                        const normalizedCode = errCode || "unknown_error";
                        failureCodes[normalizedCode] = (failureCodes[normalizedCode] || 0) + 1;

                        // "messaging/registration-token-not-registered" is the official code
                        // Sometimes the message itself contains "NotRegistered"
                        // FCM may also return "not a valid FCM registration token"
                        // "messaging/invalid-argument" often means the token is malformed or null
                        const isInvalidToken =
                            errCode === "messaging/registration-token-not-registered" ||
                            errCode === "messaging/invalid-registration-token" ||
                            errCode === "messaging/invalid-argument" ||
                            errMsg?.includes("NotRegistered") ||
                            errMsg?.includes("not a valid FCM registration token") ||
                            errMsg?.includes("The registration token is not a valid");

                        if (isInvalidToken) {
                            invalidTokenCount++;
                            const [removed] = await Promise.all([
                                presenceService.removeFcmToken(token).catch(err => {
                                    console.error(`[FCM] Failed to remove stale token from Redis: ${err.message}`);
                                    return false;
                                }),
                                notificationRepository.removeFcmToken(token).catch(err => {
                                    console.error(`[FCM] Failed to remove stale token from DB: ${err.message}`);
                                }),
                            ]);
                            if (removed) {
                                console.log(`[FCM] Removed stale/invalid token for index ${idx}: ${token?.substring(0, 10)}... (Code: ${errCode})`);
                            }
                        }
                    }
                }

                const codesSummary = Object.entries(failureCodes)
                    .map(([code, count]) => `${code} x${count}`)
                    .join(", ");

                if (invalidTokenCount === response.failureCount) {
                    // Every failure was a stale/invalid token, already pruned above —
                    // this is routine cleanup, not something that needs attention.
                    console.log(
                        `[FCM] Pruned ${invalidTokenCount} stale token(s) after multicast send (${codesSummary})`,
                    );
                } else {
                    const unexpectedCount = response.failureCount - invalidTokenCount;
                    console.warn(
                        `[FCM] Multicast send had ${unexpectedCount} unexpected failure(s) (plus ${invalidTokenCount} stale token(s) pruned) — codes: ${codesSummary}`,
                    );
                }
            }

            return response;
        } catch (error) {
            console.error(
                "[FCM] Error sending multicast message:",
                error.message,
            );
        }
    }

    /**
     * Send to all registered devices of a single user (from Redis presence cache).
     * @param {string|number} userId
     * @param {object} payload - { title, body, data }
     */
    async sendToUser(userId, payload) {
        const tokens = await presenceService.getCachedFcmTokens(userId);
        if (!tokens.length) return null;
        return this.sendToTokens(tokens, payload);
    }

    /**
     * Send to all registered devices of multiple users/agents.
     * Deduplicates tokens so a device shared across accounts gets notified once.
     * @param {Array<string|number>} userIds
     * @param {object} payload - { title, body, data }
     */
    async sendToUsers(userIds, payload) {
        const allTokens = new Set();
        for (const userId of userIds) {
            const tokens = await presenceService.getCachedFcmTokens(userId);
            tokens.forEach((t) => allTokens.add(t));
        }
        if (!allTokens.size) return null;
        return this.sendToTokens([...allTokens], payload);
    }

    formatData(data) {
        // FCM data values must be strings
        const formatted = {};
        for (const [key, value] of Object.entries(data)) {
            formatted[key] = String(value);
        }
        return formatted;
    }
}

export const fcmService = new FcmService();
