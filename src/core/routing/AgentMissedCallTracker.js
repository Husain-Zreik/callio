// src/core/routing/AgentMissedCallTracker.js
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.routing.AgentMissedCallTracker');

/**
 * Per-agent counter of consecutive missed (NO_ANSWER) inbound calls.
 *
 * - Incremented on terminate of an unanswered queue assignment.
 * - Reset on any successful accept (the agent is engaged again) or after
 *   the auto-offline threshold flips them, so the next AVAILABLE session
 *   starts from zero.
 * - Keys auto-expire after 24h so a long quiet stretch doesn't leak old
 *   counts into the next active period — fresh shift, fresh counter.
 */
class AgentMissedCallTracker {
    constructor() {
        this.keyPrefix = 'agent:missed_streak:';
        this.ttlSeconds = 24 * 60 * 60;
    }

    _key(userId) {
        return `${this.keyPrefix}${userId}`;
    }

    async increment(userId) {
        if (!userId) return 0;
        try {
            const key = this._key(userId);
            const pipe = redisBaseService.getClient().pipeline();
            pipe.incr(key);
            // Refresh TTL on every bump so the key stays alive while the
            // streak is active. A long-quiet agent's stale count expires.
            pipe.expire(key, this.ttlSeconds);
            const results = await pipe.exec();
            if (!Array.isArray(results) || !results[0]) return 0;
            const [err, count] = results[0];
            if (err) throw err;
            return Number(count) || 0;
        } catch (err) {
            log.error({ agentId: userId, err }, 'increment failed');
            return 0;
        }
    }

    async reset(userId) {
        if (!userId) return false;
        try {
            await redisBaseService.del(this._key(userId));
            return true;
        } catch (err) {
            log.error({ agentId: userId, err }, 'reset failed');
            return false;
        }
    }

    async getCount(userId) {
        if (!userId) return 0;
        try {
            const v = await redisBaseService.get(this._key(userId));
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? n : 0;
        } catch (err) {
            log.error({ agentId: userId, err }, 'getCount failed');
            return 0;
        }
    }
}

export const agentMissedCallTracker = new AgentMissedCallTracker();
