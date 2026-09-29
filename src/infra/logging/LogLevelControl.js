// src/infra/logging/LogLevelControl.js
// Log levels changed at runtime, on every worker at once, without a restart.
//
// The override lives in Redis (LOG_LEVELS_KEY, JSON { level?, levels, expiresAt })
// and each change is announced on LOG_LEVELS_CHANNEL. Every worker applies it
// on the announcement and at startup (so a worker that restarts keeps it), and
// drops it when it expires. `npm run log-level` is the way to set it.
//
// Worker threads keep the levels they started with.
import { redisClient } from '../redis/RedisClient.js';
import { logger, resetLogLevels, setLogLevels } from './logger.js';
import { COMPONENTS, LOG_LEVELS_CHANNEL, LOG_LEVELS_KEY } from './policy.js';

const log = logger(COMPONENTS.logging);

class LogLevelControl {
    #subscriber = null;
    #expiryTimer = null;

    async start() {
        if (this.#subscriber) return;
        this.#subscriber = redisClient.createClient('LogLevels-Subscriber');
        this.#subscriber.on('message', (channel) => {
            if (channel === LOG_LEVELS_CHANNEL) this.#load().catch((err) => log.warn({ err }, 'Reading the log-level override failed'));
        });
        await this.#subscriber.subscribe(LOG_LEVELS_CHANNEL);
        await this.#load();
    }

    async #load() {
        const raw = await redisClient.getClient().get(LOG_LEVELS_KEY);
        clearTimeout(this.#expiryTimer);
        resetLogLevels();
        if (!raw) return;

        let override;
        try { override = JSON.parse(raw); } catch { return; }
        if (override.expiresAt && Date.parse(override.expiresAt) <= Date.now()) return;
        setLogLevels(override);
        log.info({ override }, 'Log-level override applied');
        if (override.expiresAt) {
            this.#expiryTimer = setTimeout(() => {
                resetLogLevels();
                log.info('Log-level override expired — back to the configured levels');
            }, Date.parse(override.expiresAt) - Date.now());
            this.#expiryTimer.unref();
        }
    }

    stop() {
        clearTimeout(this.#expiryTimer);
        this.#subscriber = null;   // the connection is closed with the other tracked clients
    }
}

export const logLevelControl = new LogLevelControl();
