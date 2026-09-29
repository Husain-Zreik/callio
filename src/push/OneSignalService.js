import axios from 'axios';
import pushTokenRepository from '../persistence/PushTokenRepository.js';
import { config } from '../../config/envConfig.js';
import { logger } from '../infra/logging/logger.js';

const log = logger('push.OneSignalService');

class OneSignalService {
    constructor() {
        this.appId = config.notifications.oneSignal.appId;
        this.restApiKey = config.notifications.oneSignal.restApiKey;
        this.apiUrl = 'https://api.onesignal.com/notifications';
        this.isConfigured = !!(this.appId && this.restApiKey);
        this.timeout = config.notifications.oneSignal.timeoutMs; // 10 seconds default

        if (!this.isConfigured) {
            log.warn('OneSignal not configured (ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY) — web push disabled');
        } else {
            log.info('OneSignal Service initialized');
        }
    }

    /**
     * Send notification to specific subscription IDs.
     *
     * @param {string[]} subscriptionIds - OneSignal subscription IDs
     * @param {string} title - Notification heading
     * @param {string} message - Notification body
     * @param {object} data - Additional data payload (delivered to client)
     * @param {object} [options] - Extra options
     * @param {number} [options.priority]            shorthand for priority (default 10)
     * @param {string} [options.url]                 shorthand for url
     * @param {string} [options.icon]                shorthand → large_icon / chrome_web_icon / firefox_icon
     * @param {string} [options.image]               shorthand → big_picture / chrome_web_image
     * @param {Array}  [options.buttons]             shorthand for buttons
     * @param {object} [options.payload]             ANY extra OneSignal fields, merged into the request
     *                                               (use this for ttl, sounds, channels, ios_category,
     *                                                vibration patterns, presets, etc.)
     */
    async sendToSubscriptions(subscriptionIds, title, message, data = {}, options = {}) {
        try {
            if (!this.isConfigured) {
                log.warn('OneSignal not configured');
                return { success: false, message: 'OneSignal not configured', recipients: 0 };
            }

            if (!subscriptionIds || subscriptionIds.length === 0) {
                return { success: false, message: 'No subscription IDs provided', recipients: 0 };
            }

            const idsArray = Array.isArray(subscriptionIds) ? subscriptionIds : [subscriptionIds];

            // Build payload: shorthand options expanded → preset/payload spread → required fields
            // The order matters: required identity fields (app_id, include_subscription_ids,
            // headings, contents, data) win over anything passed via `payload`.
            const payload = {
                priority: options.priority ?? 10,
                ...this._expandShorthandOptions(options),
                ...(options.payload || {}),
                app_id: this.appId,
                include_subscription_ids: idsArray,
                headings: { en: title },
                contents: { en: message },
                data: data,
            };

            const response = await this._postWithRetry(payload);

            const responseBody = response?.data ?? {};
            const invalidIds = this._extractInvalidSubscriptionIds(responseBody);
            const recipients = responseBody.recipients !== undefined
                ? responseBody.recipients
                : Math.max(0, idsArray.length - invalidIds.length);
            const notificationId = responseBody.id ?? responseBody.notification_id ?? null;

            // Prune dead subscriptions so we don't keep targeting them.
            if (invalidIds.length > 0) {
                log.warn({ invalidIds }, 'Invalid subscription IDs');
                this._pruneInvalidSubscriptions(invalidIds);
            }

            if (!notificationId) {
                // OneSignal may return a non-standard body when all targets are invalid or filtered.
                // Treat this as a handled send failure instead of a transport exception.
                log.warn({ responseBody }, 'OneSignal response missing notification id');
                return {
                    success: false,
                    subscriptionIds: idsArray,
                    recipients,
                    invalidSubscriptionIds: invalidIds,
                    error: 'OneSignal response missing notification id',
                    response: responseBody,
                };
            }

            log.info(`Sent to ${recipients}/${idsArray.length} subscription(s)`);

            return {
                success: true,
                subscriptionIds: idsArray,
                recipients,
                invalidSubscriptionIds: invalidIds,
                notificationId,
                response: responseBody,
            };

        } catch (error) {
            // Handle specific error types
            if (error.code === 'ECONNABORTED') {
                log.error('OneSignal request timeout');
            } else if (error.response) {
                log.error({ status: error.response.status }, 'OneSignal API Error');
                log.error({ data: error.response.data }, 'Response Data');
            } else {
                log.error({ err: error }, 'OneSignal Error');
            }

            return {
                success: false,
                subscriptionIds: Array.isArray(subscriptionIds) ? subscriptionIds : [subscriptionIds],
                recipients: 0,
                error: error.message,
                errorCode: error.code,
                response: error.response?.data
            };
        }
    }

    /**
     * Send notification to logged-in users
     * Targets all devices where users are logged in
     * @param {number|number[]} userIds - Single user ID or array of user IDs
     * @param {string} title - Notification title
     * @param {string} message - Notification message
     * @param {object} data - Additional data payload
     * @param {object} options - Additional notification options
     */
    async sendToUsers(userIds, title, message, data = {}, options = {}) {
        try {
            if (!this.isConfigured) {
                return {
                    success: false,
                    message: 'OneSignal not configured',
                    recipients: 0
                };
            }

            const userIdsArray = Array.isArray(userIds) ? userIds : [userIds];

            const subscriptionIds = (await pushTokenRepository.getTokens(userIdsArray, 'ONESIGNAL')).map((t) => t.token);

            if (subscriptionIds.length === 0) {
                return {
                    success: false,
                    message: 'No logged-in subscriptions found',
                    userIds: userIdsArray,
                    recipients: 0
                };
            }

            return await this.sendToSubscriptions(subscriptionIds, title, message, data, options);

        } catch (error) {
            log.error({ err: error }, 'Error sending to users');
            return {
                success: false,
                userIds: Array.isArray(userIds) ? userIds : [userIds],
                recipients: 0,
                error: error.message
            };
        }
    }

    async _postWithRetry(payload, maxRetries = 2) {
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                await new Promise(r => setTimeout(r, 1000 * attempt));
                log.warn(`Retry attempt ${attempt}/${maxRetries}...`);
            }
            try {
                return await axios.post(this.apiUrl, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Key ${this.restApiKey}`,
                    },
                    timeout: this.timeout,
                });
            } catch (err) {
                lastError = err;
                const isRetryable = err.code === 'ECONNABORTED' || (err.response && err.response.status >= 500);
                if (!isRetryable || attempt === maxRetries) throw err;
                log.warn(`Request failed (${err.code || err.response?.status}), retrying...`);
            }
        }
        throw lastError;
    }

    /**
     * Expand convenience options into their OneSignal API field equivalents.
     * @private
     */
    _expandShorthandOptions(options) {
        const extra = {};
        if (options.url) extra.url = options.url;
        if (options.icon) {
            extra.large_icon = options.icon;
            extra.chrome_web_icon = options.icon;
            extra.firefox_icon = options.icon;
        }
        if (options.image) {
            extra.big_picture = options.image;
            extra.chrome_web_image = options.image;
        }
        if (options.buttons) extra.buttons = options.buttons;
        return extra;
    }

    /**
     * Normalize OneSignal invalid-target errors across response shapes.
     * @private
     */
    _extractInvalidSubscriptionIds(responseBody = {}) {
        const errors = responseBody?.errors;
        if (!errors) return [];

        // Common object-based shape:
        // { errors: { invalid_subscription_ids: [...] } }
        if (Array.isArray(errors.invalid_subscription_ids)) {
            return errors.invalid_subscription_ids;
        }

        // Legacy aliases used by some accounts/endpoints.
        if (Array.isArray(errors.invalid_player_ids)) {
            return errors.invalid_player_ids;
        }

        return [];
    }

    /**
     * Best-effort cleanup of dead subscription rows. Fire-and-forget — we
     * never want a cleanup failure to bubble up and mask a successful send.
     * @private
     */
    _pruneInvalidSubscriptions(invalidIds) {
        Promise.all(invalidIds.map((id) => pushTokenRepository.removeToken('ONESIGNAL', id)))
            .then((counts) => {
                const deleted = counts.reduce((sum, n) => sum + n, 0);
                if (deleted > 0) {
                    log.info(`Pruned ${deleted} stale subscription(s)`);
                }
            })
            .catch((err) => {
                log.error({ err }, 'Stale subscription cleanup failed');
            });
    }
}

export default new OneSignalService();
