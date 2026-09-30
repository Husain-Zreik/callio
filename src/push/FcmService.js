import admin from "firebase-admin";
import { config } from "../../config/envConfig.js";
import { notifyLog } from "./notificationLogger.js";
import pushTokenRepository from "../persistence/PushTokenRepository.js";
import { pushCredentials } from './PushCredentials.js';
import { logger } from '../infra/logging/logger.js';

const log = logger('push.FcmService');

class FcmService {
    constructor() {
        // credentials key ('platform' or '<consumerId>:<fingerprint>') → messaging, or null when unusable
        this._clients = new Map();
        // consumerId → its current key, to drop the Firebase app of replaced credentials
        this._consumerKeys = new Map();
        // The platform app is set up at startup, so a missing file is reported once, up front.
        this._messaging(pushCredentials.platformFcm());
    }

    // One Firebase app per credential set; the platform's is the default app.
    _messaging(cred) {
        if (!cred) return null;
        if (this._clients.has(cred.key)) return this._clients.get(cred.key);
        if (cred.consumerId != null) this._retire(cred.consumerId, cred.key);

        let messaging = null;
        const name = cred.key === 'platform' ? '[DEFAULT]' : `consumer:${cred.key}`;
        try {
            const existingApp = admin.apps.find(a => a?.name === name);
            const credential = admin.credential.cert(cred.serviceAccount ?? cred.credentialsPath);
            const app = existingApp ?? (name === '[DEFAULT]' ? admin.initializeApp({ credential }) : admin.initializeApp({ credential }, name));
            messaging = admin.messaging(app);
            log.info({ source: cred.source, ...(cred.consumerId != null ? { consumerId: cred.consumerId } : {}) }, 'Firebase Admin initialized');
        } catch (error) {
            // Missing platform credentials is a configuration choice (push off), anything else a fault.
            if (cred.source === 'platform' && /ENOENT|no such file/.test(error?.message ?? '')) {
                log.warn(`No Firebase credentials at ${cred.credentialsPath} — FCM push without consumer credentials disabled`);
            } else {
                log.error({ err: error, source: cred.source, consumerId: cred.consumerId }, 'Firebase initialization error — FCM push with these credentials disabled');
            }
        }
        this._clients.set(cred.key, messaging);
        return messaging;
    }

    _retire(consumerId, currentKey) {
        const previous = this._consumerKeys.get(consumerId);
        this._consumerKeys.set(consumerId, currentKey);
        if (!previous || previous === currentKey) return;
        this._clients.delete(previous);
        const app = admin.apps.find(a => a?.name === `consumer:${previous}`);
        app?.delete().catch((err) => log.warn({ consumerId, err }, 'Deleting a replaced Firebase app failed'));
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
     * @param {object} [credentials] - pushCredentials' fcm section for the
     *   agents' consumer (default: the platform's).
     */
    async sendToTokens(tokens, { title, body, data = {}, ttlSeconds = null, silent = false }, credentials = pushCredentials.platformFcm()) {
        if (!tokens || tokens.length === 0) return;

        const fcm = this._messaging(credentials);
        if (!fcm) {
            log.warn({ length: tokens.length }, 'Service not initialized — skipping notification to device(s)');
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
            const response = await fcm.sendEachForMulticast(message);
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
                            await pushTokenRepository.removeToken("FCM", token).catch(err => {
                                log.error({ err }, 'Failed to remove stale token from DB');
                            });
                        }
                    }
                }

                const codesSummary = Object.entries(failureCodes)
                    .map(([code, count]) => `${code} x${count}`)
                    .join(", ");

                if (invalidTokenCount === response.failureCount) {
                    // Every failure was a stale/invalid token, already pruned above —
                    // this is routine cleanup, not something that needs attention.
                    log.info(`Pruned ${invalidTokenCount} stale token(s) after multicast send (${codesSummary})`);
                } else {
                    const unexpectedCount = response.failureCount - invalidTokenCount;
                    log.warn(`Multicast send had ${unexpectedCount} unexpected failure(s) (plus ${invalidTokenCount} stale token(s) pruned) — codes: ${codesSummary}`);
                }
            }

            return response;
        } catch (error) {
            log.error({ err: error }, 'Error sending multicast message');
        }
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
