// src/infra/redis/RedisPubSubService.js
import { redisClient } from './RedisClient.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../logging/logger.js';

const log = logger('infra.redis.RedisPubSubService');

/**
 * The Socket.IO Redis adapter's connections (room emits across workers).
 * Call inputs between workers go through infra/cluster/CallInbox.js.
 */
class RedisPubSubService {
    constructor() {
        this.adapterPubClient = null;  // dedicated: Socket.IO adapter pub
        this.adapterSubClient = null;  // dedicated: Socket.IO adapter sub
        this.isInitialized = false;
    }

    // Initialize the service (call during app startup)
    async init() {
        if (this.isInitialized) return;

        const waitReady = (client, name) => new Promise((resolve, reject) => {
            client.once('ready', resolve);
            client.once('error', reject);
            setTimeout(() => reject(new Error(`${name} ready timeout`)), config.redis.connectTimeoutMs);
        });

        try {
            this.adapterPubClient = redisClient.createClient('Adapter-Publisher');
            this.adapterSubClient = redisClient.createClient('Adapter-Subscriber');
            await Promise.all([
                waitReady(this.adapterPubClient, 'Adapter-Publisher'),
                waitReady(this.adapterSubClient, 'Adapter-Subscriber'),
            ]);
            this.isInitialized = true;
            log.debug('Initialized');
        } catch (error) {
            log.error({ err: error }, 'Initialization failed');
            throw error;
        }
    }

    // Get Socket.IO adapter clients (call this in websocket/server.js)
    getAdapterClients() {
        if (!this.isInitialized) {
            throw new Error('RedisPubSubService not initialized. Call init() first.');
        }

        return {
            pubClient: this.adapterPubClient,
            subClient: this.adapterSubClient,
        };
    }

    // Close connections (called during graceful shutdown)
    async close() {
        const closeClient = async (client, name) => {
            if (!client) return;
            try {
                if (['reconnecting', 'connecting', 'wait'].includes(client.status)) {
                    client.disconnect();
                } else if (client.status !== 'end') {
                    await client.quit();
                }
                log.info(`${name} closed`);
            } catch (err) {
                log.warn({ err }, `${name} close error, forcing disconnect`);
                try { client.disconnect(); } catch { }
            } finally {
                // Closed here — untrack so RedisClient.closeAll() (called right after
                // this during shutdown) doesn't quit() it a second time.
                redisClient.untrackClient(client);
            }
        };

        try {
            await closeClient(this.adapterSubClient, 'Adapter-Subscriber');
            await closeClient(this.adapterPubClient, 'Adapter-Publisher');
            this.adapterSubClient = null;
            this.adapterPubClient = null;
            this.isInitialized = false;
            log.info('Closed');
        } catch (error) {
            log.error({ err: error }, 'Error during close');
        }
    }
}

export const redisPubSubService = new RedisPubSubService();
