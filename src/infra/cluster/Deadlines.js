// src/infra/cluster/Deadlines.js
// Per-call timers that outlive the worker that set them: a Redis sorted set
// (callio:deadlines, member `<kind>|<callId>`, score = when it's due). Every
// worker checks it twice a second; a due entry is claimed and removed in one
// script, so exactly one worker runs it. Used where an in-process setTimeout
// would vanish with its worker (an agent's reconnect window, a customer's
// network-loss grace period); the handlers must work from any worker.
import { redisBaseService } from '../redis/RedisBaseService.js';
import { logger, runWithLogContext } from '../logging/logger.js';

const log = logger('infra.cluster.Deadlines');

const KEY = 'callio:deadlines';
const TICK_MS = 500;
const BATCH = 50;
const CLAIM = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, m in ipairs(due) do redis.call('ZREM', KEYS[1], m) end
return due`;

const member = (kind, callId) => `${kind}|${callId}`;

class Deadlines {
    constructor() {
        this.handlers = new Map();   // kind → async (callId) => void
        this._timer = null;
        this._running = false;
    }

    // Registers what happens when a deadline of this kind is due.
    on(kind, handler) {
        this.handlers.set(kind, handler);
    }

    async set(kind, callId, inMs) {
        await redisBaseService.getClient().zadd(KEY, Date.now() + inMs, member(kind, callId));
    }

    async clear(kind, callId) {
        await redisBaseService.getClient().zrem(KEY, member(kind, callId));
    }

    // Every deadline of the call (it ended).
    async clearCall(callId) {
        const members = [...this.handlers.keys()].map((kind) => member(kind, callId));
        if (members.length) await redisBaseService.getClient().zrem(KEY, ...members);
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this._tick(), TICK_MS);
        this._timer.unref();
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    async _tick() {
        if (this._running) return;
        this._running = true;
        try {
            const due = await redisBaseService.getClient().eval(CLAIM, 1, KEY, Date.now(), BATCH);
            for (const m of due ?? []) {
                const [kind, callId] = String(m).split('|');
                const handler = this.handlers.get(kind);
                if (!handler) {
                    log.warn({ callId, kind }, 'Deadline with no handler on this worker');
                    continue;
                }
                runWithLogContext({ callId: Number(callId) }, () => Promise.resolve(handler(Number(callId))))
                    .catch((err) => log.error({ callId, kind, err }, 'Deadline handler failed'));
            }
        } catch (err) {
            log.warn({ err }, 'Deadline check failed');
        } finally {
            this._running = false;
        }
    }
}

export const deadlines = new Deadlines();
