// src/outbox/OutboxDispatcher.js
// Delivers webhook_deliveries to consumers' event_webhook_url. At-least-once:
// a delivery is retried with backoff until the consumer answers 2xx, then
// given up after MAX_ATTEMPTS. One worker at a time holds the dispatcher lease
// (Redis), so N PM2 workers don't deliver the same events N times.
//
// Request: POST <event_webhook_url>
//   X-Callio-Event: <event_type>   X-Callio-Event-Id: <uuid, stable across retries>
//   X-Callio-Signature: t=<ts>,v1=<HMAC-SHA256(secret, "<ts>.<body>")>
//   body: { event_id, event_type, api_version, occurred_at, tenant_ref, data }
import axios from 'axios';
import OutboxRepository from '../persistence/OutboxRepository.js';
import ConsumerRepository from '../persistence/ConsumerRepository.js';
import { redisBaseService } from '../infra/redis/RedisBaseService.js';
import { signPayload } from './signing.js';
import { config } from '../../config/envConfig.js';

const POLL_INTERVAL_MS = 2000;
const LEASE_KEY = 'callio:outbox:dispatcher';
const LEASE_TTL_SECONDS = 15;
const REQUEST_TIMEOUT_MS = 10000;
const BATCH_SIZE = 50;
// Seconds until the next attempt, by attempts made so far.
const BACKOFF_SECONDS = [5, 15, 60, 300, 900, 1800, 3600, 3600, 3600, 3600, 3600];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

class OutboxDispatcher {
    constructor() {
        this.workerId = String(config.runtime.workerId);
        this._timer = null;
        this._running = false;
        this._stopped = false;
    }

    start() {
        this._stopped = false;
        this._timer = setInterval(() => this.#tick(), POLL_INTERVAL_MS);
        this._timer.unref?.();
    }

    async stop() {
        this._stopped = true;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        try {
            await redisBaseService.getClient().eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
                1, LEASE_KEY, this.workerId
            );
        } catch { /* best effort */ }
    }

    // Holds or renews the lease; true when this worker is the dispatcher.
    async #holdLease() {
        const client = redisBaseService.getClient();
        const renewed = await client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) end return 0",
            1, LEASE_KEY, this.workerId, LEASE_TTL_SECONDS
        );
        if (Number(renewed) === 1) return true;
        return Boolean(await redisBaseService.setnx(LEASE_KEY, this.workerId, LEASE_TTL_SECONDS));
    }

    async #tick() {
        if (this._running || this._stopped) return;
        this._running = true;
        try {
            if (!await this.#holdLease()) return;
            const due = await OutboxRepository.findDue(BATCH_SIZE);
            const configs = new Map();
            for (const delivery of due) {
                if (this._stopped) break;
                if (!configs.has(delivery.consumer_id)) {
                    configs.set(delivery.consumer_id, await ConsumerRepository.getWebhookConfig(delivery.consumer_id));
                }
                await this.#deliver(delivery, configs.get(delivery.consumer_id));
            }
        } catch (err) {
            console.error('[Outbox] Dispatch cycle failed:', err);
        } finally {
            this._running = false;
        }
    }

    async #deliver(delivery, webhook) {
        if (!webhook?.url) return;
        const payload = typeof delivery.payload === 'string' ? JSON.parse(delivery.payload) : delivery.payload;
        const body = JSON.stringify({ event_id: delivery.event_id, ...payload });
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Callio-Webhooks/1',
            'X-Callio-Event': delivery.event_type,
            'X-Callio-Event-Id': delivery.event_id,
        };
        if (webhook.secret) headers['X-Callio-Signature'] = signPayload(webhook.secret, body);

        let status = null;
        try {
            const response = await axios.post(webhook.url, body, {
                headers,
                timeout: REQUEST_TIMEOUT_MS,
                maxRedirects: 0,
                validateStatus: () => true,
            });
            status = response.status;
            if (status >= 200 && status < 300) {
                await OutboxRepository.markDelivered(delivery.id, status);
                return;
            }
            await this.#failed(delivery, status, `HTTP ${status}`);
        } catch (err) {
            await this.#failed(delivery, status, err.code || err.message);
        }
    }

    async #failed(delivery, status, error) {
        const attemptsMade = Number(delivery.attempts) + 1;
        const giveUp = attemptsMade >= MAX_ATTEMPTS;
        await OutboxRepository.markAttemptFailed(delivery.id, {
            responseStatus: status,
            error,
            nextAttemptInSeconds: giveUp ? null : BACKOFF_SECONDS[attemptsMade - 1],
        });
        const msg = `[Outbox] ${delivery.event_type} ${delivery.event_id} to consumer ${delivery.consumer_id}: ${error}`;
        if (giveUp) console.error(`${msg} — giving up after ${attemptsMade} attempts`);
        else console.warn(`${msg} — retry #${attemptsMade + 1} in ${BACKOFF_SECONDS[attemptsMade - 1]}s`);
    }
}

export const outboxDispatcher = new OutboxDispatcher();
