// src/websocket/middleware/authMiddleware.js
import jwt from "jsonwebtoken";
import { roomManager } from "../managers/RoomManager.js";
import NotificationRepository from "../../repositories/NotificationRepository.js";
import AgentRepository from "../../repositories/AgentRepository.js";
import BusinessRepository from "../../repositories/BusinessRepository.js";
import { redisBaseService } from "../../services/redis/RedisBaseService.js";
import { config } from "../../../config/envConfig.js";

const ROLE_CACHE_TTL = 5 * 60; // 5 minutes
const roleKey = (businessId, userId) => `auth:role:${businessId}:${userId}`;

function validateAndExtractToken(token) {
    if (!token) {
        throw new Error("No token provided");
    }

    const JWT_SECRET = config.jwt.secret;
    if (!JWT_SECRET) {
        throw new Error("JWT secret not set in environment");
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        throw new Error("Invalid or expired token");
    }

    const userId = decoded.user?.id || decoded.sub || decoded.uid || null;
    const userUUID = decoded.user?.uuid || null;
    const userName = decoded.user?.name || null;

    const businessId =
        decoded.business?.id ||
        decoded.businessId ||
        decoded.business_id ||
        null;
    const businessUUID = decoded.business?.uuid || null;

    if (!userId || !userUUID) throw new Error("Token missing user ID/UUID");

    // Tokens without a business belong to super-admin accounts.
    // Laravel's auth controller sets business: null for admin users.
    if (!businessId && !businessUUID) {
        return {
            user: { id: userId, uuid: userUUID, name: userName, isAdmin: true },
            business: { id: "SUPER_ADMIN", uuid: "SUPER_ADMIN" },
        };
    }

    return {
        user: { id: userId, uuid: userUUID, name: userName, isAdmin: false },
        business: { id: businessId, uuid: businessUUID },
    };
}

export async function authMiddleware(socket, next) {
    const token = socket.handshake.auth?.token;

    try {
        const { user, business } = validateAndExtractToken(token);
        const deviceId = socket.handshake.auth?.device_id || null;

        // Distinguishes a genuine app session from a throwaway/auxiliary
        // connection that authenticates with the same token/device_id but
        // has no business participating in presence tracking or
        // reconnect-redelivery semantics — see connectionHandler.js's own
        // use of this field for the bug class it closes (2026-08-24): the
        // mobile app opens short-lived auxiliary connections (CallkitWatch's
        // remote-resolution watcher, the native-decline reject socket — see
        // push_notification_service.dart's `_openAuxiliarySocket`) that
        // share this device's identity with its main SocketService
        // connection. Without this tag, the backend has no way to tell such
        // a connection apart from the main app reconnecting, and previously
        // treated it as one — up to and including resetting the call's
        // FRONTEND WebRTC peer on what it read as a fresh agent reconnect.
        // Defaults to 'session' (the main app's own connection) so every
        // caller that predates this field behaves exactly as before.
        const connectionPurpose = socket.handshake.auth?.purpose || 'session';

        // FCM token fetch — NotificationRepository handles in-process caching
        // to avoid repeated DB hits on rapid reconnects (e.g. PM2 restart).
        user.fcmToken = await NotificationRepository.getUserFcmToken(user.id, deviceId);
        user.deviceId = deviceId;

        socket.user = user;
        socket.business = business;
        socket.connectionPurpose = connectionPurpose;
        roomManager.joinBusinessRoom(socket, business.id);
        roomManager.joinUserRoom(socket, user.id);

        // Resolve the user's call-center role once at connect time and cache it on the
        // socket so per-request handlers (call:ongoing) can read it without a DB query.
        // Skip for SUPER_ADMIN — they have no business_id and no call-center permissions.
        socket.callCenterRole = 'system';
        if (business.id !== 'SUPER_ADMIN') {
            try {
                const cacheKey = roleKey(business.id, user.id);
                let role = await redisBaseService.get(cacheKey);
                if (!role) {
                    role = await AgentRepository.resolveTransferInitiatorType(business.id, user.id);
                    // Real bug found and fixed (2026-08-22): resolveTransferInitiatorType
                    // resolves purely from the user's PERSISTENT call_center_agent_access
                    // permission grant, regardless of whether the business's call-center
                    // *feature* is currently toggled on. With it off, an inbound call
                    // routes the "regular business" way (broadcast to everyone, user_id
                    // left NULL until someone actually accepts it) — but this socket
                    // still resolved as 'agent', so call:ongoing's handler
                    // (socketHandlers.js) still scoped this user's resync to
                    // CallRepository.getOngoingCallsForAgent's strict `user_id = ?`,
                    // which can never match that NULL row. A cold-start native accept
                    // (app killed, tapped Accept, app boots and reconnects to resync
                    // the still-ringing call) was therefore guaranteed to fail whenever
                    // this exact combination applied — deterministic, not a race.
                    // Forcing 'system' here (same as a role-less user already correctly
                    // gets) routes them through the unscoped getOngoingCallsForBusiness
                    // query instead, which needs no change of its own — a genuinely
                    // regular-business user already worked correctly, this just extends
                    // the same treatment to an agent-role user whose business happens
                    // to have the feature off right now. Manager resolution is
                    // deliberately left untouched — not implicated in this bug (a
                    // manager already resolves to the same unscoped query regardless),
                    // and forcing it to 'system' too would have unrelated, unverified
                    // effects on monitor/whisper access this fix isn't scoped to touch.
                    if (role === 'agent') {
                        const isCallCentered = await BusinessRepository.isCallCentered(business.id);
                        if (!isCallCentered) role = 'system';
                    }
                    if (role) await redisBaseService.set(cacheKey, role, ROLE_CACHE_TTL);
                }
                socket.callCenterRole = role || 'system';
                if (role === 'manager') {
                    roomManager.joinManagerRoom(socket, business.id);
                }
            } catch (err) {
                // Non-fatal — manager falls back to business-room events only.
                console.warn(`[Auth] Role resolution failed for user ${user.id}:`, err.message);
            }
        }

        next();
    } catch (err) {
        next(new Error(`Authentication failed: ${err.message}`));
    }
}
