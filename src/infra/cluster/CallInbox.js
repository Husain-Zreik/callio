// src/infra/cluster/CallInbox.js
// How a call's inputs reach the one worker that runs it (docs/media-architecture.md,
// "Call ownership and inputs").
//
//   lease   callio:call:<id>:lease   = the owner's boot id, PX 15 s, renewed every 5 s.
//           The worker that sets the call's media up takes it (own()); a worker
//           that dies stops renewing and the lease lapses.
//   inbox   callio:call:<id>:inbox   a Redis Stream. post() appends from any
//           worker; only the lease holder reads it. Unlike pub/sub, an entry
//           posted while nobody holds the lease (or while it changes hands)
//           waits for the next owner instead of being lost.
//   cursor  callio:call:<id>:cursor  the last entry the owner took, so the next
//           owner continues after it.
//
// One blocking XREAD per worker covers every call it owns, plus a per-worker
// wake stream that own()/release() poke so a new call is read at once.
// Handlers run as they did under pub/sub: concurrently, errors logged.
//
// request() is post() that waits for the owner's answer: the input carries
// this worker's reply channel (callio:worker:<boot>:replies, pub/sub — only a
// live requester cares), and the owner publishes what its handler returned.
// For work that must happen where the call's media is (an agent offer).
import { randomUUID } from 'crypto';
import { redisClient } from '../redis/RedisClient.js';
import { bootId } from './WorkerBoot.js';
import { config } from '../../../config/envConfig.js';
import { logger, runWithLogContext } from '../logging/logger.js';

const log = logger('infra.cluster.CallInbox');

const REQUEST_TIMEOUT_MS = 8_000;
const LEASE_MS = 15_000;
const RENEW_MS = 5_000;
const BLOCK_MS = 5_000;
const MAXLEN = 1000;
const KEY_TTL_S = 24 * 3600;

const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0";
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

const keys = (callId) => ({
    lease: `callio:call:${callId}:lease`,
    inbox: `callio:call:${callId}:inbox`,
    cursor: `callio:call:${callId}:cursor`,
});

class CallInbox {
    constructor() {
        this.owned = new Map();     // callId (string) → { lastId, handler }
        this.client = null;         // commands
        this.reader = null;         // the blocking XREAD
        this.replies = null;        // subscriber: answers to this worker's requests
        this.pending = new Map();   // requestId → { resolve, reject, timer }
        this.wakeKey = `callio:worker:${bootId}:wake`;
        this.replyChannel = `callio:worker:${bootId}:replies`;
        this._renewTimer = null;
        this._running = false;
        this._loop = null;
    }

    async init() {
        if (this.client) return;
        this.client = redisClient.createClient('CallInbox');
        this.reader = redisClient.createClient('CallInbox-Reader');
        this.replies = redisClient.createClient('CallInbox-Replies');
        const ready = (c, name) => new Promise((resolve, reject) => {
            if (c.status === 'ready') return resolve();
            c.once('ready', resolve);
            c.once('error', reject);
            setTimeout(() => reject(new Error(`${name} ready timeout`)), config.redis.connectTimeoutMs);
        });
        await Promise.all([
            ready(this.client, 'CallInbox'), ready(this.reader, 'CallInbox-Reader'), ready(this.replies, 'CallInbox-Replies'),
        ]);
        await this.replies.subscribe(this.replyChannel);
        this.replies.on('message', (_channel, message) => this._onReply(message));
        this._running = true;
        this._loop = this._readLoop();
        this._renewTimer = setInterval(() => this._renew().catch((err) => log.warn({ err }, 'Lease renewal failed')), RENEW_MS);
        this._renewTimer.unref();
        log.debug({ bootId }, 'Initialized');
    }

    // Appends an input for the call. Returns 1 if a worker holds the call's
    // lease (someone will act on it now), else 0 — the entry still waits.
    async post(callId, eventType, data = {}) {
        if (!this.client) {
            log.warn({ callId, eventType }, 'Cannot post - not initialized');
            return 0;
        }
        const k = keys(callId);
        const entry = JSON.stringify({ ...data, callId, eventType, workerId: config.runtime.workerId, timestamp: Date.now() });
        try {
            const res = await this.client.multi()
                .xadd(k.inbox, 'MAXLEN', '~', MAXLEN, '*', 'e', entry)
                .expire(k.inbox, KEY_TTL_S)
                .exists(k.lease)
                .exec();
            const held = Number(res?.[2]?.[1] ?? 0);
            log.debug({ callId, eventType, held }, 'Posted call input');
            return held ? 1 : 0;
        } catch (err) {
            log.error({ callId, err }, `Posting ${eventType} failed`);
            return 0;
        }
    }

    // Posts an input and resolves with what the owner's handler returned.
    // Rejects if no worker holds the lease or none answers in time.
    async request(callId, eventType, data = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        const id = randomUUID();
        const answer = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`No answer to ${eventType} from the worker that owns call ${callId}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        const held = await this.post(callId, eventType, { ...data, _request: { id, replyTo: this.replyChannel } });
        if (!held) {
            const p = this.pending.get(id);
            if (p) { clearTimeout(p.timer); this.pending.delete(id); }
            throw new Error(`No worker owns call ${callId}`);
        }
        return answer;
    }

    _onReply(message) {
        let reply;
        try { reply = JSON.parse(message); } catch { return; }
        const p = this.pending.get(reply.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(reply.id);
        if (reply.ok) p.resolve(reply.value);
        else p.reject(new Error(reply.error || 'The owning worker failed the request'));
    }

    // Takes the call's lease and starts reading its inbox. False if another
    // live worker holds it.
    async own(callId, handler) {
        const id = String(callId);
        if (this.owned.has(id)) return true;
        const k = keys(id);
        const taken = await this.client.set(k.lease, bootId, 'PX', LEASE_MS, 'NX');
        if (!taken && (await this.client.get(k.lease)) !== bootId) {
            log.debug({ callId }, 'Call is owned by another worker');
            return false;
        }
        const cursor = (await this.client.get(k.cursor)) ?? '0';
        this.owned.set(id, { lastId: cursor, handler });
        await this._wake();
        log.debug({ callId }, 'Owning call');
        return true;
    }

    owns(callId) {
        return this.owned.has(String(callId));
    }

    // Gives the call up; purge also drops its inbox and cursor (the call ended).
    async release(callId, { purge = false } = {}) {
        const id = String(callId);
        const had = this.owned.delete(id);
        const k = keys(id);
        try {
            if (had) await this.client.eval(RELEASE, 1, k.lease, bootId);
            if (purge) await this.client.del(k.inbox, k.cursor);
            if (had) await this._wake();
        } catch (err) {
            log.warn({ callId, err }, 'Releasing the call failed');
        }
    }

    stats() {
        return { owned: this.owned.size };
    }

    async _wake() {
        await this.client.xadd(this.wakeKey, 'MAXLEN', '~', 10, '*', 'w', '1').catch(() => { });
        await this.client.expire(this.wakeKey, KEY_TTL_S).catch(() => { });
    }

    async _renew() {
        for (const id of [...this.owned.keys()]) {
            const ok = await this.client.eval(RENEW, 1, keys(id).lease, bootId, LEASE_MS);
            if (!ok) {
                this.owned.delete(id);
                log.error({ callId: id }, 'Lost the call lease — another worker owns it now');
            }
        }
    }

    async _readLoop() {
        while (this._running) {
            const ids = [...this.owned.keys()];
            const streams = [this.wakeKey, ...ids.map((id) => keys(id).inbox)];
            const from = ['$', ...ids.map((id) => this.owned.get(id).lastId)];
            let res;
            try {
                res = await this.reader.xread('BLOCK', BLOCK_MS, 'STREAMS', ...streams, ...from);
            } catch (err) {
                if (!this._running) break;
                log.warn({ err }, 'Inbox read failed');
                await new Promise((r) => setTimeout(r, 500));
                continue;
            }
            for (const [stream, entries] of res ?? []) {
                if (stream === this.wakeKey) continue;
                const id = stream.split(':')[2];
                const own = this.owned.get(id);
                if (!own) continue;
                for (const [entryId, fields] of entries) {
                    own.lastId = entryId;
                    this._deliver(id, own.handler, fields);
                }
                this.client.set(keys(id).cursor, own.lastId, 'EX', KEY_TTL_S).catch(() => { });
            }
        }
    }

    _deliver(callId, handler, fields) {
        let data;
        try {
            data = JSON.parse(fields[fields.indexOf('e') + 1]);
        } catch (err) {
            log.error({ callId, err }, 'Unreadable call input');
            return;
        }
        data.callId = Number(callId);
        const { eventType, _request: request } = data;
        delete data._request;
        log.debug({ callId, eventType }, 'Processing call input');
        const run = runWithLogContext({ callId: data.callId }, () => Promise.resolve(handler(eventType, data)));
        if (!request) {
            run.catch((err) => log.error({ callId, err }, `Unhandled error in handler for '${eventType}'`));
            return;
        }
        run.then((value) => (value === undefined
            ? { id: request.id, ok: false, error: `${eventType} produced no result` }
            : { id: request.id, ok: true, value }))
            .catch((err) => ({ id: request.id, ok: false, error: err.message }))
            .then((reply) => this.client.publish(request.replyTo, JSON.stringify(reply)))
            .catch((err) => log.warn({ callId, err }, `Answering ${eventType} failed`));
    }

    // Shutdown: gives every call up (5.4 will hand them over instead).
    async close() {
        this._running = false;
        clearInterval(this._renewTimer);
        for (const id of [...this.owned.keys()]) await this.release(id);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Shutting down')); }
        this.pending.clear();
        for (const c of [this.reader, this.replies, this.client]) {
            try { c?.disconnect(); } catch { /* closed */ }
            if (c) redisClient.untrackClient(c);
        }
        this.client = null;
        this.reader = null;
        this.replies = null;
        log.info('Closed');
    }
}

export const callInbox = new CallInbox();
