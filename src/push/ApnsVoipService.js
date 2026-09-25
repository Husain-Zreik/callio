import apn from "@parse/node-apn";
import { config } from "../../config/envConfig.js";
import pushTokenRepository from "../persistence/PushTokenRepository.js";

// CallKit needs the call `id` as a UUID-shaped string; Callio's callId is an
// integer. Deterministic, so the agent app can derive the same UUID from the
// callId on its own side without it being passed back and forth. Documented
// in the push payload contract (PLATFORM_ARCHITECTURE.md §3E) — client SDKs
// must use the same mapping.
function callKitUuidFor(callId) {
    const digits = String(callId).padStart(12, "0");
    return `00000000-0000-0000-0000-${digits}`;
}

// Sends VoIP push notifications (Apple PushKit) directly to APNs — a
// separate channel from FcmService's regular FCM/APNs delivery. Firebase's
// messaging() API cannot send true `apns-push-type: voip` pushes; Apple
// requires these go straight to APNs, which is what flutter_callkit_incoming's
// native iOS side (PKPushRegistryDelegate) expects to receive.
class ApnsVoipService {
    constructor() {
        const { apnsKeyPath, apnsKeyId, apnsTeamId, production } = config.apple;
        if (!apnsKeyId || !apnsTeamId) {
            console.warn("[ApnsVoip] APNS_KEY_ID/APNS_TEAM_ID not configured — VoIP push sending disabled");
            this.provider = null;
            return;
        }

        try {
            this.provider = new apn.Provider({
                token: { key: apnsKeyPath, keyId: apnsKeyId, teamId: apnsTeamId },
                production,
                // Default is 5000ms — too slow for a live call ring: if Apple
                // hasn't responded by then it's already an anomaly, and every
                // ms spent waiting on a stalled request is ms not spent on a
                // retry within the ring window. 2500ms keeps 3 full attempts
                // comfortably within a few seconds total while cutting the
                // worst-case all-timeouts path from ~16s to ~8.5s.
                requestTimeout: 2500,
            });
            console.log(`[ApnsVoip] Provider initialized (production=${production})`);
        } catch (error) {
            console.error("[ApnsVoip] Initialization error:", error.message);
            this.provider = null;
        }
    }

    /**
     * @param {string[]} tokens
     * @param {object} callData - { type, callId, tenantId, channel, customerName, customerAddress }
     */
    async sendVoipPush(tokens, callData) {
        if (!tokens || tokens.length === 0) return;

        if (!this.provider) {
            console.error("[ApnsVoip] Provider not initialized — skipping VoIP push to", tokens.length, "device(s)");
            return;
        }

        const validTokens = tokens.filter((t) => t && typeof t === "string" && t.length > 0);
        if (validTokens.length === 0) return;

        const note = new apn.Notification();
        note.pushType = "voip";
        // VoIP pushes require the bundle id with ".voip" appended, distinct
        // from the plain bundle-id topic used for alert/background pushes.
        note.topic = `${config.apple.bundleId}.voip`;
        note.priority = 10;
        // 0, not a future timestamp — a VoIP push has no value once it's
        // not immediately deliverable: either the call is live right now, or
        // it's already moot. 0 tells APNs "attempt exactly once, discard
        // immediately rather than storing and retrying" (Apple's documented
        // apns-expiration semantics), matching Apple's own recommendation
        // for VoIP specifically. Previously +30s asked APNs to hold and
        // retry delivery for up to 30 more seconds if the device wasn't
        // immediately reachable — closer to regular-notification semantics
        // than a live call ring. Independent of this service's own retry
        // loop below, which re-sends a fresh push from our side entirely and
        // isn't affected by this header either way.
        note.expiry = 0;
        // id/type/nameCaller/handle/isVideo are what a CallKit integration
        // reads to report (type=call.incoming) or end (type=call.cancelled) a
        // call; the rest is the generic push contract. handle stays a
        // phone-number-shaped value (or empty) — CallKit treats it as one.
        const isPhone = /^\+?\d+$/.test(String(callData.customerAddress ?? ""));
        note.payload = {
            id: callKitUuidFor(callData.callId),
            type: callData.type || "call.incoming",
            nameCaller: callData.customerName || callData.customerAddress || "Incoming call",
            handle: isPhone ? callData.customerAddress : "",
            isVideo: false,
            call_id: callData.callId,
            tenant_id: callData.tenantId ?? null,
            channel: callData.channel ?? null,
            customer_name: callData.customerName ?? null,
            customer_address: callData.customerAddress ?? null,
        };

        // Transport-level failures (e.g. "apn write timeout" — node-apn's
        // own per-request timeout firing with no response from Apple at
        // all, confirmed via node_modules/@parse/node-apn/lib/client.js's
        // request.setTimeout handler) say nothing about the token itself —
        // unlike "Unregistered"/"BadDeviceToken" (a real, permanent
        // rejection from Apple), a bare network/timeout blip is exactly the
        // class of transient failure worth retrying. Each retry below is a
        // fresh provider.send() call, independent of note.expiry above —
        // that header only governs what APNs does with a single already-sent
        // push if the device isn't immediately reachable, not whether we can
        // send another one moments later. Live-observed in production: a
        // single such timeout previously dropped that call's only VoIP push
        // with no recovery at all.
        const maxAttempts = 3;
        const retryDelayMs = 500;
        const sent = [];
        const invalidTokens = [];
        let pendingTokens = validTokens;
        // callId tag on every line below — previously none of this logging
        // identified which call a send/failure/retry belonged to, making it
        // impossible to correlate against a specific ring's outcome when
        // multiple calls are in flight. startedAt lets the final summary
        // report total wall-clock spent across all attempts, so it's visible
        // whether retries are costing meaningful ring time.
        const logTag = `[ApnsVoip] [callId=${callData.callId}]`;
        const startedAt = Date.now();

        for (let attempt = 1; attempt <= maxAttempts && pendingTokens.length > 0; attempt++) {
            let result;
            try {
                result = await this.provider.send(note, pendingTokens);
            } catch (error) {
                // Deliberately non-retrying, unlike the per-token loop below —
                // node-apn's Provider.send() resolves per-token failures
                // (including "apn write timeout") into result.failed via its
                // own internal Promise.allSettled, so THIS catch only fires
                // for a genuinely catastrophic provider-level error (e.g.
                // malformed note, provider misconfiguration). Retrying that
                // class of error would just repeat the same failure 3x.
                console.error(`${logTag} Error sending VoIP push on attempt ${attempt}/${maxAttempts}:`, error.message);
                return { sent };
            }

            sent.push(...result.sent);
            // Unconditional — this is the only line that confirms Apple
            // actually accepted the push for delivery, so it can't be
            // gated behind a debug flag without making every successful
            // send (including a recovered retry) invisible in the logs.
            for (const success of result.sent) {
                console.log(`${logTag} APNs accepted push for token ${success.device?.substring(0, 10)}... on attempt ${attempt}/${maxAttempts}`);
            }

            if (result.failed.length === 0) break;

            const retryableTokens = [];
            for (const failure of result.failed) {
                const reason = failure.response?.reason;
                const reasonOrMessage = reason || failure.error?.message;
                const tokenPreview = failure.device?.substring(0, 10);
                // "Unregistered"/"BadDeviceToken" are the documented APNs
                // rejection reasons meaning the token is permanently dead —
                // never worth retrying.
                if (reason === "Unregistered" || reason === "BadDeviceToken") {
                    invalidTokens.push(failure.device);
                    console.warn(`${logTag} Invalid VoIP token ${tokenPreview}... (${reason}) — removing from DB`);
                    pushTokenRepository.removeToken("APNS_VOIP", failure.device).then((removed) => {
                        console.warn(`${logTag} Removed ${removed} VoIP token row(s) (reason: ${reason})`);
                    }).catch((err) =>
                        console.error(`${logTag} Failed to remove stale VoIP token from DB: ${err.message}`)
                    );
                } else if (reason === "TooManyRequests") {
                    // Apple's documented reason for HTTP 429 on this token
                    // specifically ("too many requests were made consecutively
                    // to the same device token") — the token itself is still
                    // valid, not pruned, but retrying it again within this
                    // same call attempt would make the throttling worse, not
                    // better. node-apn strips any Retry-After header before
                    // it reaches us (confirmed in its own source), so there's
                    // no real wait time to honor — the safest response is to
                    // not retry this token for THIS call at all and let the
                    // next genuinely new call (naturally spaced apart in
                    // time) try again, rather than hammering it again in ~500ms.
                    console.warn(`${logTag} Rate-limited (429) for token ${tokenPreview}... — not retrying this call, token left valid for next call`);
                } else if (attempt < maxAttempts) {
                    retryableTokens.push(failure.device);
                    console.warn(`${logTag} Transient delivery failure for token ${tokenPreview}... on attempt ${attempt}/${maxAttempts}, will retry: ${reasonOrMessage}`);
                } else {
                    console.warn(`${logTag} Giving up on token ${tokenPreview}... after ${attempt} attempt(s), last error: ${reasonOrMessage}`);
                }
            }

            pendingTokens = retryableTokens;
            if (pendingTokens.length > 0) {
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
        }

        const durationMs = Date.now() - startedAt;
        const undelivered = validTokens.length - sent.length - invalidTokens.length;
        if (sent.length === validTokens.length) {
            console.log(`${logTag} VoIP push delivered to all ${sent.length} token(s) in ${durationMs}ms`);
        } else {
            console.warn(`${logTag} VoIP push finished: ${sent.length}/${validTokens.length} delivered, ${invalidTokens.length} invalid, ${undelivered} undelivered, in ${durationMs}ms`);
        }

        return { sent };
    }
}

export const apnsVoipService = new ApnsVoipService();
