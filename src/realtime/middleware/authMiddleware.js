// src/realtime/middleware/authMiddleware.js
// Agent socket authentication (PLATFORM_ARCHITECTURE.md §3C). The consumer's
// backend signs a short-lived HS256 JWT with one of its signing keys:
//   header  { alg: "HS256", kid }
//   payload { iss: <consumer slug>, sub: <agent_ref>, tnt: <tenant_ref>,
//             name?, role?: "AGENT"|"SUPERVISOR", exp }
// The agent is created on first connect (just-in-time provisioning); queue
// membership is still managed through the Management API.
import jwt from "jsonwebtoken";
import { roomManager } from "../managers/RoomManager.js";
import AgentRepository from "../../persistence/AgentRepository.js";
import ConsumerRepository from "../../persistence/ConsumerRepository.js";
import TenantRepository from "../../persistence/TenantRepository.js";
import { AgentRole } from "../../core/constants/CallConstants.js";
import { logger } from '../../infra/logging/logger.js';

const log = logger('realtime.authMiddleware');

export const AGENT_PROTOCOL_VERSION = 1;

// Signing secrets are looked up per connect; a short in-process cache absorbs
// reconnect storms (e.g. a worker restart) without a DB round trip each.
const SECRET_CACHE_TTL_MS = 60_000;
const secretCache = new Map(); // `${consumerId}:${kid}` → { secret, expiresAt }

async function signingSecret(consumerId, kid) {
    const key = `${consumerId}:${kid}`;
    const hit = secretCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.secret;
    const secret = await ConsumerRepository.getSigningSecret(consumerId, kid);
    if (secret) secretCache.set(key, { secret, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
    return secret;
}

export class AgentAuthError extends Error {}

/**
 * Verifies an agent token and resolves it to Callio's consumer, tenant and
 * agent rows. Throws AgentAuthError with a client-safe message.
 */
export async function authenticateAgentToken(token) {
    if (!token) throw new AgentAuthError("No token provided");

    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const iss = decoded?.payload?.iss;
    if (!kid || !iss) throw new AgentAuthError("Token is missing kid or iss");

    const consumer = await ConsumerRepository.findBySlug(iss);
    if (!consumer || consumer.status !== "ACTIVE") throw new AgentAuthError("Unknown or suspended consumer");

    const secret = await signingSecret(consumer.id, kid);
    if (!secret) throw new AgentAuthError("Unknown signing key");

    let claims;
    try {
        claims = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: iss });
    } catch {
        throw new AgentAuthError("Invalid or expired token");
    }
    if (!claims.sub || !claims.tnt) throw new AgentAuthError("Token is missing sub or tnt");
    if (!claims.exp) throw new AgentAuthError("Token must expire");

    const tenant = await TenantRepository.findByExternalRef(consumer.id, String(claims.tnt));
    if (!tenant || tenant.status !== "ACTIVE") throw new AgentAuthError("Unknown or suspended tenant");

    const role = Object.values(AgentRole).includes(claims.role) ? claims.role : null;
    const agent = await AgentRepository.upsert(tenant.id, String(claims.sub), {
        name: claims.name ? String(claims.name) : String(claims.sub),
        role,
    });
    if (!agent) throw new AgentAuthError("Agent could not be resolved");

    return { consumer, tenant, agent };
}

export async function authMiddleware(socket, next) {
    try {
        const protocol = socket.handshake.auth?.protocol;
        if (protocol != null && Number(protocol) !== AGENT_PROTOCOL_VERSION) {
            throw new AgentAuthError(`Unsupported protocol version ${protocol} (server speaks ${AGENT_PROTOCOL_VERSION})`);
        }

        const { tenant, agent } = await authenticateAgentToken(socket.handshake.auth?.token);

        socket.user = {
            id: agent.id,
            externalRef: agent.external_ref,
            name: agent.name,
            role: agent.role,
            deviceId: socket.handshake.auth?.device_id || null,
        };
        socket.tenant = { id: tenant.id, externalRef: tenant.external_ref };

        // A 'session' connection is the agent's main app connection. Anything
        // else (e.g. a mobile app's short-lived auxiliary socket used to decline
        // from the lock screen) shares the same identity but must not take part
        // in presence tracking or reconnect redelivery.
        socket.connectionPurpose = socket.handshake.auth?.purpose || "session";

        roomManager.joinTenantRoom(socket, tenant.id);
        roomManager.joinUserRoom(socket, agent.id);
        if (agent.role === AgentRole.SUPERVISOR) roomManager.joinSupervisorRoom(socket, tenant.id);

        next();
    } catch (err) {
        if (!(err instanceof AgentAuthError)) log.error({ err }, 'Socket authentication error');
        next(new Error(`Authentication failed: ${err instanceof AgentAuthError ? err.message : "internal error"}`));
    }
}
