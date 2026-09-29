// src/core/routing/QueueTimeoutService.js
// Enforces a queue's timers on the calls waiting in it:
//   ring_timeout_seconds  an offer to one agent that rings this long passes to
//                         the next member (ROUND_ROBIN / PRIORITY; RING_ALL
//                         rings everyone at once and has no per-agent timeout)
//   max_wait_seconds      a call unanswered this long after entering the queue
//                         moves to overflow_queue_id, or ends as TIMEOUT
// State lives in the calls row (offered_at, queued_at, overflow_count), so any
// worker can do this after a restart. One worker scans at a time (Redis lock).
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import CallRepository from '../../persistence/CallRepository.js';
import { agentAssignmentCoordinator } from './AgentAssignmentCoordinator.js';
import { queueRouter } from './QueueRouter.js';
import { callTerminator } from '../calls/CallTerminator.js';
import { TerminationReason, TerminatedBy, CallStatus } from '../constants/CallConstants.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.routing.QueueTimeoutService');

const TICK_MS = 2000;
const LOCK_KEY = 'callio:queue-timeouts:lock';
const LOCK_TTL_SECONDS = 30;
// Overflow chains can loop (A → B → A); each hop restarts the wait, so the
// number of hops bounds the total. After this many the call ends as TIMEOUT.
const MAX_OVERFLOWS = 3;

class QueueTimeoutService {
    constructor() {
        this._timer = null;
        this._running = false;
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this.tick(), TICK_MS);
        this._timer.unref();
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    async tick() {
        if (this._running) return;
        this._running = true;
        const token = `${config.runtime.workerId}:${Date.now()}`;
        let locked = false;
        try {
            locked = await redisBaseService.setnx(LOCK_KEY, token, LOCK_TTL_SECONDS);
            if (!locked) return;
            await this.#expireOffers();
            await this.#expireWaits();
        } catch (err) {
            log.error({ err }, 'Scan failed');
        } finally {
            if (locked) {
                await redisBaseService.getClient().eval(
                    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
                    1, LOCK_KEY, token
                ).catch(() => { });
            }
            this._running = false;
        }
    }

    async #expireOffers() {
        for (const call of await CallRepository.findExpiredOffers()) {
            try {
                // expiredBefore = the offer time this scan read: an offer made
                // again since (to the same agent, a new round) isn't withdrawn.
                await agentAssignmentCoordinator.passOffer(call, call.agent_id, 'missed', { expiredBefore: call.offered_at });
            } catch (err) {
                log.error({ callId: call.id, err }, 'Passing on the offer failed');
            }
        }
    }

    async #expireWaits() {
        for (const call of await CallRepository.findExpiredWaits()) {
            try {
                await this.#waitExpired(call);
            } catch (err) {
                log.error({ callId: call.id, err }, 'Max-wait handling failed');
            }
        }
    }

    async #waitExpired(call) {
        const overflow = call.overflow_queue_id
            && String(call.overflow_queue_id) !== String(call.queue_id)
            && call.overflow_count < MAX_OVERFLOWS
            ? await queueRouter.getQueue(call.overflow_queue_id)
            : null;

        if (overflow && String(overflow.tenant_id) === String(call.tenant_id)) {
            const moved = await CallRepository.overflowToQueue(call.id, call.queue_id, overflow.id, call.agent_id ?? null);
            if (moved) await agentAssignmentCoordinator.callOverflowed(call, overflow);
            return;
        }

        await callTerminator.end(call, {
            reason: TerminationReason.TIMEOUT,
            terminatedBy: TerminatedBy.SYSTEM,
            onlyIfStatus: CallStatus.RINGING,
            provider: 'end',
            source: 'queue_max_wait',
            log: { queue_id: call.queue_id, max_wait_seconds: call.max_wait_seconds, overflow_count: call.overflow_count },
        });
    }
}

export const queueTimeoutService = new QueueTimeoutService();
