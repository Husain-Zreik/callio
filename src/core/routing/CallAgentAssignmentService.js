// src/core/routing/CallAgentAssignmentService.js
// Redis-backed agent picking for a queue: a short per-queue lock so two
// workers never claim for the same queue at once, the round-robin cursor, and
// the "longest-available first" order used by ROUND_ROBIN.
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import CallRepository from '../../persistence/CallRepository.js';
import { AgentAvailability } from '../constants/CallConstants.js';
import { config } from '../../../config/envConfig.js';
import { presenceService } from '../agents/PresenceService.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.routing.CallAgentAssignmentService');

const isAvailable = (agent) => agent.availability === AgentAvailability.AVAILABLE;

class CallAgentAssignmentService {
    constructor() {
        this.workerId = config.runtime.workerId;
        this.lockTTLSeconds = 5;
        this.lockWaitMs = 1500;
        // Keep an agent's place in the order across a short disconnect (page refresh).
        this.queueReconnectHoldMs = 60000;
    }

    #lockKey(queueId) { return `callio:queue:${queueId}:lock`; }
    #lastKey(queueId) { return `callio:queue:${queueId}:last`; }
    #orderKey(queueId) { return `callio:queue:${queueId}:order`; }
    #metaKey(queueId) { return `callio:queue:${queueId}:meta`; }
    #seqKey(queueId) { return `callio:queue:${queueId}:seq`; }

    async acquireLock(lockKey) {
        const token = `${this.workerId}:${Date.now()}:${Math.random()}`;
        const startedAt = Date.now();
        while (Date.now() - startedAt < this.lockWaitMs) {
            if (await redisBaseService.setnx(lockKey, token, this.lockTTLSeconds)) return token;
            await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 30)));
        }
        return null;
    }

    async releaseLock(lockKey, token) {
        try {
            await redisBaseService.getClient().eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
                1, lockKey, token
            );
        } catch (error) {
            log.error({ err: error }, `Failed to release lock ${lockKey}`);
        }
    }

    #parseOrder(raw) {
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }

    #parseMeta(raw) {
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return {
                enteredAt: Number(parsed.enteredAt) || Date.now(),
                joinSequence: Number(parsed.joinSequence) || null,
                unavailableSince: parsed.unavailableSince ? Number(parsed.unavailableSince) : null,
            };
        } catch {
            return null;
        }
    }

    // Maintains the order in which members became available: members keep their
    // place while available (or briefly offline), newcomers join at the tail.
    // Returns the currently available members in that order.
    async reconcileQueueOrder(queueId, members = []) {
        const now = Date.now();
        const byId = new Map(members.map((a) => [String(a.id), a]));
        const available = new Map(members.filter(isAvailable).map((a) => [String(a.id), a]));

        const orderKey = this.#orderKey(queueId);
        const metaKey = this.#metaKey(queueId);
        const previousOrder = [...new Set(this.#parseOrder(await redisBaseService.get(orderKey)))];
        const currentMeta = await redisBaseService.hgetall(metaKey) || {};

        const nextOrder = [];
        const nextMeta = {};

        for (const id of previousOrder) {
            const meta = this.#parseMeta(currentMeta[id]) || { enteredAt: now, joinSequence: null, unavailableSince: null };
            if (available.has(id)) {
                nextOrder.push(id);
                nextMeta[id] = { enteredAt: meta.enteredAt || now, joinSequence: meta.joinSequence, unavailableSince: null };
                continue;
            }
            const unavailableSince = meta.unavailableSince || now;
            const holdPosition = byId.get(id)?.availability === AgentAvailability.OFFLINE
                && (now - unavailableSince) <= this.queueReconnectHoldMs;
            if (holdPosition) {
                nextOrder.push(id);
                nextMeta[id] = { enteredAt: meta.enteredAt || now, joinSequence: meta.joinSequence, unavailableSince };
            }
        }

        const placed = new Set(nextOrder);
        const newcomers = [...available.keys()].filter((id) => !placed.has(id)).sort((a, b) => Number(a) - Number(b));
        for (const id of newcomers) {
            nextOrder.push(id);
            const joinSequence = await redisBaseService.incr(this.#seqKey(queueId));
            nextMeta[id] = { enteredAt: now, joinSequence: Number(joinSequence), unavailableSince: null };
        }

        await redisBaseService.set(orderKey, JSON.stringify(nextOrder));
        const stale = Object.keys(currentMeta).filter((field) => !nextMeta[field]);
        if (stale.length) await redisBaseService.hdel(metaKey, ...stale);
        const metaArgs = Object.entries(nextMeta).flatMap(([id, meta]) => [id, JSON.stringify(meta)]);
        if (metaArgs.length) await redisBaseService.hset(metaKey, ...metaArgs);

        return nextOrder.map((id) => available.get(id)).filter(Boolean);
    }

    // Tries `orderedCandidates` in order under the queue lock until claimFn
    // succeeds. Without the lock (Redis contention), the DB claim is still the
    // source of truth, so it proceeds lock-free rather than failing the call.
    async #claimInOrder(queueId, orderedCandidates, claimFn) {
        if (!orderedCandidates.length) return null;
        const lockKey = this.#lockKey(queueId);
        const token = await this.acquireLock(lockKey);
        if (!token) log.warn(`Could not acquire assignment lock for queue ${queueId} — claiming without it`);
        try {
            for (const candidate of orderedCandidates) {
                if (await claimFn(candidate.id)) {
                    await redisBaseService.set(this.#lastKey(queueId), String(candidate.id));
                    return candidate;
                }
            }
            return null;
        } finally {
            if (token) await this.releaseLock(lockKey, token);
        }
    }

    // ROUND_ROBIN: the member who has been available longest goes first.
    async pickRoundRobin(queueId, members, claimFn) {
        if (!members.some(isAvailable)) return null;
        const ordered = await this.reconcileQueueOrder(queueId, members);
        return this.#claimInOrder(queueId, ordered, claimFn);
    }

    // PRIORITY: lowest priority value first, then agent id (members arrive
    // already sorted that way from QueueRepository.getMembers).
    async pickPriority(queueId, members, claimFn) {
        const ordered = members.filter(isAvailable)
            .sort((a, b) => (Number(a.priority ?? 1) - Number(b.priority ?? 1)) || (Number(a.id) - Number(b.id)));
        return this.#claimInOrder(queueId, ordered, claimFn);
    }

    async buildQueueSnapshot(queue, members = []) {
        const queueId = queue.id;
        const lastAssignedId = await redisBaseService.get(this.#lastKey(queueId));
        const lastAssigned = lastAssignedId ? members.find((a) => String(a.id) === String(lastAssignedId)) : null;

        const order = queue.strategy === 'PRIORITY'
            ? members.filter(isAvailable)
            : await this.reconcileQueueOrder(queueId, members);
        const meta = await redisBaseService.hgetall(this.#metaKey(queueId)) || {};
        const socketCounts = await Promise.all(members.map((a) => presenceService.getUserSocketCount(a.id)));
        const connectedById = new Map(members.map((a, i) => [String(a.id), socketCounts[i] > 0]));

        // Isolated: a failed count must not break the snapshot the queue UI relies on.
        const waitingCount = await CallRepository.countUnassignedCalls(queueId).catch((err) => {
            log.error({ err }, `countUnassignedCalls failed for queue ${queueId}`);
            return 0;
        });

        return {
            tenantId: queue.tenant_id,
            queueId,
            queueName: queue.name,
            strategy: queue.strategy,
            lastAssignedAgentId: lastAssignedId ? Number(lastAssignedId) : null,
            lastAssignedAgentName: lastAssigned?.name || null,
            nextAgentId: order[0]?.id ?? null,
            nextAgentName: order[0]?.name ?? null,
            order: order.map((agent, index) => {
                const m = this.#parseMeta(meta[String(agent.id)]);
                return {
                    position: index + 1,
                    agentId: agent.id,
                    name: agent.name || null,
                    availability: agent.availability,
                    connected: connectedById.get(String(agent.id)) ?? false,
                    availableSince: m?.enteredAt || null,
                };
            }),
            members: members.map((agent) => ({
                agentId: agent.id,
                name: agent.name || null,
                priority: agent.priority ?? 1,
                availability: agent.availability,
                connected: connectedById.get(String(agent.id)) ?? false,
            })),
            availableCount: members.filter(isAvailable).length,
            memberCount: members.length,
            waitingCount,
            updatedAt: new Date().toISOString(),
        };
    }
}

export const callAgentAssignmentService = new CallAgentAssignmentService();
