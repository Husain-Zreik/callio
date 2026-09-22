// src/services/notifications/notificationPresets.js
//
// Reusable OneSignal payload presets. Each preset is a partial OneSignal
// "Create notification" payload — callers spread it into their request and
// override only the dynamic fields (headings, contents, data, buttons, url).
//
// All values come from envConfig.js so ops can tune sounds / channels /
// colors / TTLs per environment without touching code.

import { config } from "../../../config/envConfig.js";

const callCfg = config.notifications.presets.call;

// Common Android/iOS fields shared by every call-related notification.
const callBase = Object.freeze({
    priority: 10,
    ttl: callCfg.ttl,
    ios_sound: callCfg.iosSound,
    android_sound: callCfg.androidSound,
    ...(callCfg.androidChannelId ? { android_channel_id: callCfg.androidChannelId } : {}),
    android_visibility: 1,
    android_accent_color: callCfg.androidAccentColor,
    android_led_color: callCfg.androidAccentColor,
    android_vibration_pattern: [200, 300, 200, 300, 200],
    ios_category: callCfg.iosCategory,
    ios_interruption_level: callCfg.iosInterruptionLevel,
});

// Build an absolute URL when APP_URL is configured, otherwise return the
// path as-is (OneSignal accepts relative paths but they only resolve from
// the currently open tab — so prefer absolute when possible).
export function absoluteUrl(path) {
    if (!path) return undefined;
    if (/^https?:\/\//i.test(path)) return path;
    if (!callCfg.appUrl) return path;
    return callCfg.appUrl.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

export const NotificationPresets = {
    /**
     * Initial incoming-call notification.
     * Caller must supply: headings, contents, data, url, buttons.
     */
    incomingCall: Object.freeze({
        ...callBase,
        android_group: "incoming_calls",
        android_group_message: { en: "$[notif_count] incoming calls" },
    }),

    /**
     * Call transferred to this agent.
     */
    transferredCall: Object.freeze({
        ...callBase,
        android_group: "transferred_calls",
        android_group_message: { en: "$[notif_count] transferred calls" },
    }),
};

export const NotificationIcons = Object.freeze({
    call: callCfg.icon,
});
