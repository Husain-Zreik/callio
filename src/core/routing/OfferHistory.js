// src/core/routing/OfferHistory.js
// Who has already had a waiting call offered and passed on it, so the queue
// offers it to someone else next:
//   declined  pressed decline — never offered this call again
//   missed    let it ring out (ring timeout) — skipped until every other
//             available member has had it too; then a new round starts
// Kept in Redis for the call's lifetime (TTL), shared by all workers.
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { AgentAvailability } from '../constants/CallConstants.js';

const TTL_SECONDS = 3600;
const isAvailable = (agent) => agent.availability === AgentAvailability.AVAILABLE;

class OfferHistory {
    #key(callId, kind) { return `callio:call:${callId}:offers:${kind}`; }

    async record(callId, agentId, kind) {
        const key = this.#key(callId, kind);
        await redisBaseService.sadd(key, String(agentId));
        await redisBaseService.expire(key, TTL_SECONDS);
    }

    // A new queue (overflow) is a new round.
    async clearMissed(callId) {
        await redisBaseService.del(this.#key(callId, 'missed'));
    }

    // The members this call may be offered to now.
    async eligible(callId, members) {
        const [declined, missed] = await Promise.all([
            redisBaseService.smembers(this.#key(callId, 'declined')),
            redisBaseService.smembers(this.#key(callId, 'missed')),
        ]).then((sets) => sets.map((s) => new Set((s ?? []).map(String))));
        if (!declined.size && !missed.size) return members;

        const notDeclined = members.filter((a) => !declined.has(String(a.id)));
        const fresh = notDeclined.filter((a) => !missed.has(String(a.id)));
        if (!missed.size || fresh.some(isAvailable)) return fresh;

        // Everyone available has missed it this round: start the next one.
        if (notDeclined.some(isAvailable)) await this.clearMissed(callId);
        return notDeclined;
    }
}

export const offerHistory = new OfferHistory();
