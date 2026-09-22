import { redisBaseService } from './RedisBaseService.js';
import AgentRepository from '../../repositories/AgentRepository.js';
import BusinessRepository from '../../repositories/BusinessRepository.js';
import CallRepository from '../../repositories/CallRepository.js';
import { AgentAvailability } from '../call/constants/CallConstants.js';
import { config } from '../../../config/envConfig.js';
import { presenceService } from './PresenceService.js';

class CallAgentAssignmentService {
    constructor() {
        this.workerId = config.runtime.workerId;
        this.lockPrefix = 'call:agent:lock:';
        this.roundRobinPrefix = 'call:agent:last:';
        this.queueOrderPrefix = 'call:agent:queue:order:';
        this.queueMetaPrefix = 'call:agent:queue:meta:';
        this.queueSeqPrefix = 'call:agent:queue:seq:';
        this.groupLockPrefix = 'call:group:agent:lock:';
        this.groupRoundRobinPrefix = 'call:group:agent:last:';
        this.lockTTLSeconds = 5;
        this.lockWaitMs = 1500;
        // Keep queue position for short disconnect/reconnect windows (e.g. page refresh).
        this.queueReconnectHoldMs = 60000;
    }

    getLockKey(businessId) {
        return `${this.lockPrefix}${businessId}`;
    }

    getRoundRobinKey(businessId) {
        return `${this.roundRobinPrefix}${businessId}`;
    }

    getQueueOrderKey(businessId) {
        return `${this.queueOrderPrefix}${businessId}`;
    }

    getQueueMetaKey(businessId) {
        return `${this.queueMetaPrefix}${businessId}`;
    }

    getQueueSeqKey(businessId) {
        return `${this.queueSeqPrefix}${businessId}`;
    }

    getGroupLockKey(businessId, groupId) {
        return `${this.groupLockPrefix}${businessId}:${groupId}`;
    }

    getGroupRoundRobinKey(businessId, groupId) {
        return `${this.groupRoundRobinPrefix}${businessId}:${groupId}`;
    }

    async acquireLock(lockKey) {
        const token = `${this.workerId}:${Date.now()}:${Math.random()}`;
        const startedAt = Date.now();

        while (Date.now() - startedAt < this.lockWaitMs) {
            const locked = await redisBaseService.setnx(lockKey, token, this.lockTTLSeconds);
            if (locked) {
                return token;
            }

            const retryDelay = 25 + Math.floor(Math.random() * 30);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }

        return null;
    }

    async releaseLock(lockKey, token) {
        const client = redisBaseService.getClient();

        try {
            await client.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
                1,
                lockKey,
                token
            );
        } catch (error) {
            console.error(`[AgentAssignment] Failed to release lock ${lockKey}:`, error.message);
        }
    }

    async acquireBusinessLock(businessId) {
        return this.acquireLock(this.getLockKey(businessId));
    }

    async releaseBusinessLock(businessId, token) {
        return this.releaseLock(this.getLockKey(businessId), token);
    }

    selectNextAgent(availableAgents, lastAssignedId) {
        if (!availableAgents.length) {
            return null;
        }

        if (!lastAssignedId) {
            return availableAgents[0];
        }

        const currentIndex = availableAgents.findIndex((agent) => String(agent.id) === String(lastAssignedId));
        if (currentIndex === -1) {
            return availableAgents[0];
        }

        return availableAgents[(currentIndex + 1) % availableAgents.length];
    }

    sortAgentsForFairness(agents = []) {
        return [...agents].sort((a, b) => Number(a.id) - Number(b.id));
    }

    parseQueueOrder(raw) {
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.map((id) => String(id));
        } catch {
            return [];
        }
    }

    parseQueueMetaValue(raw) {
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

    async reconcileBusinessQueueOrder(businessId, agents = []) {
        const now = Date.now();
        const availableAgents = agents.filter(
            (agent) => agent.call_availability === AgentAvailability.AVAILABLE
        );
        const allAgentsById = new Map(
            agents.map((agent) => [String(agent.id), agent])
        );
        const availableById = new Map(
            availableAgents.map((agent) => [String(agent.id), agent])
        );
        const availableIds = new Set(availableById.keys());

        const orderKey = this.getQueueOrderKey(businessId);
        const metaKey = this.getQueueMetaKey(businessId);
        const seqKey = this.getQueueSeqKey(businessId);

        const rawOrder = await redisBaseService.get(orderKey);
        const currentMetaRaw = await redisBaseService.hgetall(metaKey) || {};
        const previousOrder = this.parseQueueOrder(rawOrder);
        const seen = new Set();
        const dedupedOrder = previousOrder.filter((id) => {
            const normalized = String(id);
            if (seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });

        const nextOrder = [];
        const nextMeta = {};

        for (const id of dedupedOrder) {
            const normalized = String(id);
            const parsed = this.parseQueueMetaValue(currentMetaRaw[normalized]) || {
                enteredAt: now,
                joinSequence: null,
                unavailableSince: null,
            };

            if (availableIds.has(normalized)) {
                nextOrder.push(normalized);
                nextMeta[normalized] = {
                    enteredAt: parsed.enteredAt || now,
                    joinSequence: parsed.joinSequence || null,
                    unavailableSince: null,
                };
                continue;
            }

            const currentAvailability = String(
                allAgentsById.get(normalized)?.call_availability || ''
            ).toUpperCase();
            const unavailableSince = parsed.unavailableSince || now;
            const shouldKeepPosition = (
                currentAvailability === AgentAvailability.OFFLINE
                && (now - unavailableSince) <= this.queueReconnectHoldMs
            );
            if (shouldKeepPosition) {
                nextOrder.push(normalized);
                nextMeta[normalized] = {
                    enteredAt: parsed.enteredAt || now,
                    joinSequence: parsed.joinSequence || null,
                    unavailableSince,
                };
            }
        }

        const nextOrderSet = new Set(nextOrder.map((id) => String(id)));
        const newcomers = [...availableById.keys()]
            .filter((id) => !nextOrderSet.has(String(id)))
            .sort((a, b) => Number(a) - Number(b));

        // Append newcomers to tail with fresh queue-enter timestamp and sequence.
        for (const id of newcomers) {
            nextOrder.push(String(id));
            const joinSequence = await redisBaseService.incr(seqKey);
            nextMeta[String(id)] = {
                enteredAt: now,
                joinSequence: Number(joinSequence),
                unavailableSince: null,
            };
        }

        // Persist current live queue order.
        await redisBaseService.set(orderKey, JSON.stringify(nextOrder));

        // Replace meta hash fields for current live queue only.
        const staleMetaFields = Object.keys(currentMetaRaw)
            .filter((field) => !nextMeta[String(field)]);
        if (staleMetaFields.length) {
            await redisBaseService.hdel(metaKey, ...staleMetaFields);
        }
        if (Object.keys(nextMeta).length > 0) {
            const metaArgs = [];
            for (const [id, meta] of Object.entries(nextMeta)) {
                metaArgs.push(id, JSON.stringify(meta));
            }
            await redisBaseService.hset(metaKey, ...metaArgs);
        }

        return nextOrder
            .map((id) => availableById.get(String(id)))
            .filter(Boolean);
    }

    buildRoundRobinOrder(availableAgents, lastAssignedId) {
        if (!availableAgents.length) {
            return [];
        }

        const nextAgent = this.selectNextAgent(availableAgents, lastAssignedId);
        if (!nextAgent) {
            return [...availableAgents];
        }

        const startIndex = availableAgents.findIndex((agent) => String(agent.id) === String(nextAgent.id));
        if (startIndex < 0) {
            return [...availableAgents];
        }

        return [
            ...availableAgents.slice(startIndex),
            ...availableAgents.slice(0, startIndex)
        ];
    }

    async buildQueueSnapshot(businessId, agents = []) {
        const rrKey = this.getRoundRobinKey(businessId);
        const lastAssignedId = await redisBaseService.get(rrKey);
        const lastAssignedAgent = lastAssignedId
            ? agents.find((agent) => String(agent.id) === String(lastAssignedId))
            : null;

        const queueOrder = await this.reconcileBusinessQueueOrder(businessId, agents);
        const currentTurnAgent = queueOrder[0] || null;
        const metaKey = this.getQueueMetaKey(businessId);
        const queueMetaRaw = await redisBaseService.hgetall(metaKey) || {};

        const socketCounts = await Promise.all(
            queueOrder.map((agent) => presenceService.getUserSocketCount(agent.id))
        );

        // A plain agent otherwise has no visibility into calls unassigned to
        // anyone — calls:list is scoped server-side to their own userId only
        // (see CallQueryService.getOngoingCalls). Riding this count on the
        // existing, already-business-scoped call:agent_queue event (re-emitted
        // at every relevant lifecycle point — webhook-incoming, termination,
        // availability change) avoids needing a new event entirely. Failure
        // here must not break the rest of the snapshot the queue UI depends
        // on, so it's isolated and defaults to 0 rather than rejecting.
        const pendingUnassignedCount = await CallRepository.countUnassignedCalls(businessId).catch((err) => {
            console.error(`[CallAgentAssignmentService] countUnassignedCalls failed for business ${businessId}:`, err.message);
            return 0;
        });

        return {
            businessId,
            lastAssignedAgentId: lastAssignedId ? Number(lastAssignedId) : null,
            lastAssignedAgentName: lastAssignedAgent?.name || null,
            currentTurnAgentId: currentTurnAgent?.id || null,
            currentTurnAgentName: currentTurnAgent?.name || null,
            queue: queueOrder.map((agent, index) => {
                const meta = this.parseQueueMetaValue(queueMetaRaw[String(agent.id)]);
                return {
                    position: index + 1,
                    agentId: agent.id,
                    name: agent.name || null,
                    email: agent.email || null,
                    availability: agent.call_availability,
                    connected: socketCounts[index] > 0,
                    queueEnteredAt: meta?.enteredAt || null,
                    queueJoinSequence: meta?.joinSequence || null,
                };
            }),
            availableCount: queueOrder.length,
            totalAgentsCount: agents.length,
            pendingUnassignedCount,
            updatedAt: new Date().toISOString(),
        };
    }

    async resolveBusinessId(requestedBusinessId = null, socketBusinessId = null, userId = null) {
        if (requestedBusinessId && requestedBusinessId !== 'SUPER_ADMIN') {
            return requestedBusinessId;
        }

        if (socketBusinessId && socketBusinessId !== 'SUPER_ADMIN') {
            return socketBusinessId;
        }

        if (!userId) return null;
        return await AgentRepository.getUserBusinessId(userId);
    }

    async getQueueSnapshotForBusiness(businessId) {
        if (!businessId) return null;

        const isCallCenter = await BusinessRepository.isCallCentered(businessId);
        if (!isCallCenter) return null;

        const agents = await AgentRepository.getCallCenterAgents(businessId);
        return await this.buildQueueSnapshot(businessId, agents);
    }

    async _pickAgentForScope({ lockKey, roundRobinKey, scopeLabel, agents, claimAgentFn, queueBusinessId = null }) {
        const availableAgents = this.sortAgentsForFairness(
            agents.filter((agent) => agent.call_availability === AgentAvailability.AVAILABLE)
        );
        if (!availableAgents.length) {
            return null;
        }

        const orderedCandidates = queueBusinessId
            ? await this.reconcileBusinessQueueOrder(queueBusinessId, agents)
            : availableAgents;

        const token = await this.acquireLock(lockKey);
        if (!token) {
            console.warn(`[AgentAssignment] Could not acquire assignment lock for ${scopeLabel}`);
            // Fallback mode: DB is source of truth, pick deterministically.
            for (const candidate of orderedCandidates) {
                const claimed = await claimAgentFn(candidate.id);
                if (claimed) {
                    await redisBaseService.set(roundRobinKey, String(candidate.id));
                    return candidate;
                }
            }
            return null;
        }

        try {
            if (queueBusinessId) {
                for (const candidate of orderedCandidates) {
                    const claimed = await claimAgentFn(candidate.id);
                    if (claimed) {
                        await redisBaseService.set(roundRobinKey, String(candidate.id));
                        return candidate;
                    }
                }
                return null;
            }

            const lastAssignedId = await redisBaseService.get(roundRobinKey);
            const remainingAgents = [...availableAgents];

            while (remainingAgents.length) {
                const candidate = this.selectNextAgent(remainingAgents, lastAssignedId);
                if (!candidate) {
                    return null;
                }

                const claimed = await claimAgentFn(candidate.id);
                if (claimed) {
                    await redisBaseService.set(roundRobinKey, String(candidate.id));
                    return candidate;
                }

                const idx = remainingAgents.findIndex((agent) => String(agent.id) === String(candidate.id));
                if (idx >= 0) {
                    remainingAgents.splice(idx, 1);
                } else {
                    break;
                }
            }

            return null;
        } finally {
            await this.releaseLock(lockKey, token);
        }
    }

    async pickAgentForBusiness(businessId, agents, claimAgentFn) {
        return this._pickAgentForScope({
            lockKey: this.getLockKey(businessId),
            roundRobinKey: this.getRoundRobinKey(businessId),
            scopeLabel: `business ${businessId}`,
            agents,
            claimAgentFn,
            queueBusinessId: businessId,
        });
    }

    async pickAgentForGroup(businessId, groupId, agents, claimAgentFn) {
        return this._pickAgentForScope({
            lockKey: this.getGroupLockKey(businessId, groupId),
            roundRobinKey: this.getGroupRoundRobinKey(businessId, groupId),
            scopeLabel: `business ${businessId}, group ${groupId}`,
            agents,
            claimAgentFn,
        });
    }

    async pickPriorityAgentForBusiness(businessId, agents, claimAgentFn) {
        const availableAgents = this.sortAgentsForFairness(
            agents.filter((agent) => agent.call_availability === AgentAvailability.AVAILABLE)
        );
        return this.pickPriorityAgentForBusinessByOrder(
            businessId,
            availableAgents.map((agent) => agent.id),
            availableAgents,
            claimAgentFn
        );
    }

    buildPriorityOrderedAgents(availableAgents, preferredIds = []) {
        const idSet = new Set(availableAgents.map((agent) => String(agent.id)));
        const preferredUnique = [];
        const seen = new Set();

        for (const id of preferredIds || []) {
            const normalized = String(id);
            if (!idSet.has(normalized) || seen.has(normalized)) continue;
            seen.add(normalized);
            preferredUnique.push(normalized);
        }

        const orderedFromPreferred = preferredUnique
            .map((id) => availableAgents.find((agent) => String(agent.id) === id))
            .filter(Boolean);

        const remainder = availableAgents
            .filter((agent) => !seen.has(String(agent.id)))
            .sort((a, b) => Number(a.id) - Number(b.id));

        return [...orderedFromPreferred, ...remainder];
    }

    async pickPriorityAgentForBusinessByOrder(businessId, preferredIds, agents, claimAgentFn) {
        const availableAgents = this.sortAgentsForFairness(
            agents.filter((agent) => agent.call_availability === AgentAvailability.AVAILABLE)
        );
        const orderedAgents = this.buildPriorityOrderedAgents(availableAgents, preferredIds);

        if (!availableAgents.length) {
            return null;
        }

        const lockKey = this.getLockKey(businessId);
        const token = await this.acquireLock(lockKey);
        if (!token) {
            console.warn(`[AgentAssignment] Could not acquire priority assignment lock for business ${businessId}`);
            for (const candidate of availableAgents) {
                const claimed = await claimAgentFn(candidate.id);
                if (claimed) return candidate;
            }
            return null;
        }

        try {
            // Priority mode always tries the same deterministic order (lowest ID first).
            for (const candidate of orderedAgents) {
                const claimed = await claimAgentFn(candidate.id);
                if (claimed) return candidate;
            }
            return null;
        } finally {
            await this.releaseLock(lockKey, token);
        }
    }

    async markAgentAsLastAssigned(businessId, agentId) {
        if (!businessId || !agentId) return false;
        const rrKey = this.getRoundRobinKey(businessId);
        await redisBaseService.set(rrKey, String(agentId));
        return true;
    }
}

export const callAgentAssignmentService = new CallAgentAssignmentService();
