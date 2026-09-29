// src/infra/redis/RedisPubSubService.js
import { redisClient } from './RedisClient.js';
import { config } from '../../../config/envConfig.js';
import { logger, runWithLogContext } from '../logging/logger.js';

const log = logger('infra.redis.RedisPubSubService');

/**
 * Manages Redis pub/sub for cross-worker communication.
 * Also provides clients for Socket.IO Redis adapter.
 */
class RedisPubSubService {
    constructor() {
        this.subscriberClient = null;
        this.publisherClient = null;   // dedicated: call event PUBLISH
        this.adapterPubClient = null;  // dedicated: Socket.IO adapter pub
        this.adapterSubClient = null;  // dedicated: Socket.IO adapter sub
        this.subscriptions = new Map();
        this.channelPrefix = 'callmanager';
        this.workerId = config.runtime.workerId;
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
            // Each pub path gets its own dedicated connection so call event
            // publishes, Socket.IO adapter broadcasts, and base ops never
            // compete on the same TCP pipe.
            this.publisherClient = redisClient.createClient('PubSub-Publisher');
            this.adapterPubClient = redisClient.createClient('Adapter-Publisher');
            this.adapterSubClient = redisClient.createClient('Adapter-Subscriber');
            this.subscriberClient = redisClient.createClient('PubSub-Subscriber');

            await Promise.all([
                waitReady(this.publisherClient, 'PubSub-Publisher'),
                waitReady(this.adapterPubClient, 'Adapter-Publisher'),
                waitReady(this.adapterSubClient, 'Adapter-Subscriber'),
                waitReady(this.subscriberClient, 'PubSub-Subscriber'),
            ]);

            // Handle incoming call event messages
            this.subscriberClient.on('message', (channel, message) => {
                this.handleMessage(channel, message);
            });

            this.isInitialized = true;
            log.debug(`Worker ${this.workerId} initialized`);
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

    // Build channel name for a call — all event types share one channel per call.
    buildChannel(callId) {
        return `${this.channelPrefix}:${callId}`;
    }

    // Handle incoming pub/sub messages
    handleMessage(channel, message) {
        const parts = channel.split(':');

        if (parts.length < 2 || parts[0] !== this.channelPrefix) {
            return;
        }

        let callId, eventType, data;
        try {
            callId = parseInt(parts[1], 10);
            data = JSON.parse(message);
            eventType = data.eventType;
            data.callId = callId;
        } catch (parseError) {
            log.error({ err: parseError }, `Failed to parse message on channel ${channel}`);
            return;
        }

        const handler = this.subscriptions.get(callId);
        if (!handler) return; // No handler registered on this worker

        log.debug({ callId }, `Worker ${this.workerId} processing ${eventType}`);

        // handler is async — await the promise and catch rejections so they are
        // always logged and never become silent unhandled promise rejections.
        // Everything logged while handling it carries the call id.
        runWithLogContext({ callId }, () => Promise.resolve(handler(eventType, data))).catch(err => {
            log.error({ callId, err }, `Unhandled error in handler for event '${eventType}'`);
        });
    }

    // Publish an event for a call
    async publishCallEvent(callId, eventType, data) {
        if (!this.isInitialized) {
            log.warn('Cannot publish - not initialized');
            return 0;
        }

        const channel = this.buildChannel(callId);

        try {
            const message = JSON.stringify({
                ...data,
                callId,
                eventType,
                workerId: this.workerId,
                timestamp: Date.now()
            });

            const subscriberCount = await this.publisherClient.publish(channel, message);
            log.debug({ callId }, `Worker ${this.workerId} published ${eventType} (${subscriberCount} subscriber(s))`);

            return subscriberCount;
        } catch (error) {
            log.error({ callId, err: error }, `Error publishing ${eventType}`);
            return 0;
        }
    }

    // Subscribe to all events for a call
    async subscribeToCallEvents(callId, handler) {
        if (!this.isInitialized) {
            log.warn('Cannot subscribe - not initialized');
            return false;
        }

        if (this.subscriptions.has(callId)) {
            log.debug({ callId }, `Worker ${this.workerId} already subscribed`);
            return true;
        }

        try {
            const channel = this.buildChannel(callId);
            await this.subscriberClient.subscribe(channel);
            this.subscriptions.set(callId, handler);

            log.debug({ callId }, `Worker ${this.workerId} subscribed`);
            return true;

        } catch (error) {
            log.error({ callId, err: error }, 'Error subscribing');
            return false;
        }
    }

    // Unsubscribe from a call's events
    async unsubscribeFromCall(callId) {
        if (!this.isInitialized || !this.subscriptions.has(callId)) {
            return true;
        }

        try {
            const channel = this.buildChannel(callId);
            await this.subscriberClient.unsubscribe(channel);
            this.subscriptions.delete(callId);

            log.debug({ callId }, `Worker ${this.workerId} unsubscribed from call`);
            return true;

        } catch (error) {
            log.error({ callId, err: error }, 'Error unsubscribing from call');
            return false;
        }
    }

    // Unsubscribe from all calls
    async unsubscribeAll() {
        if (!this.isInitialized) return;

        const callIds = Array.from(this.subscriptions.keys());

        for (const callId of callIds) {
            await this.unsubscribeFromCall(callId);
        }

        log.info(`Worker ${this.workerId} unsubscribed from all calls`);
    }

    // Get active subscriptions
    getActiveSubscriptions() {
        return Array.from(this.subscriptions.keys());
    }

    // Get service status
    getStatus() {
        return {
            workerId: this.workerId,
            isInitialized: this.isInitialized,
            activeSubscriptions: this.subscriptions.size,
            channelPrefix: this.channelPrefix,
            hasPublisherClient: !!this.publisherClient,
            hasAdapterPubClient: !!this.adapterPubClient,
            hasAdapterSubClient: !!this.adapterSubClient,
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
            await this.unsubscribeAll();

            await closeClient(this.subscriberClient, 'PubSub-Subscriber');
            await closeClient(this.adapterSubClient, 'Adapter-Subscriber');
            await closeClient(this.adapterPubClient, 'Adapter-Publisher');
            await closeClient(this.publisherClient, 'PubSub-Publisher');

            this.subscriberClient = null;
            this.adapterSubClient = null;
            this.adapterPubClient = null;
            this.publisherClient = null;
            this.subscriptions.clear();
            this.isInitialized = false;

            log.info(`Worker ${this.workerId} closed`);
        } catch (error) {
            log.error({ err: error }, 'Error during close');
        }
    }
}

export const redisPubSubService = new RedisPubSubService();
