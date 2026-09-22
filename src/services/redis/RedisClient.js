// src/services/redis/RedisClient.js
import Redis from "ioredis";
import { config } from "../../../config/envConfig.js";

/**
 * Singleton Redis client manager.
 * Tracks all created clients to prevent memory leaks.
 */
class RedisClient {
    constructor() {
        this.config = {
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            db: config.redis.db,
            keepAlive: 5000,
            retryStrategy: (times) => Math.min(times * 50, 2000),
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: false,
        };

        this.mainClient = null;
        this.createdClients = []; // Track all created clients
        this.isConnected = false;
        this._closing = false;
    }

    // Get or create the main Redis client (singleton)
    getClient() {
        if (!this.mainClient) {
            this.mainClient = new Redis(this.config);
            this.setupClientEvents(this.mainClient, 'Main');
        }
        return this.mainClient;
    }

    // Create a new Redis client and track it
    createClient(name = 'Client') {
        const client = new Redis(this.config);
        this.setupClientEvents(client, name);

        // Track created client
        this.createdClients.push({ name, client });
        console.log(`[Redis] Created client "${name}" (Total tracked: ${this.createdClients.length})`);

        return client;
    }

    // Setup event handlers for a client
    setupClientEvents(client, clientName) {
        client.on("connect", () => {
            if (this._closing) return;
            console.log(`[Redis] ${clientName} connected`);
            if (clientName === 'Main') this.isConnected = true;
        });

        client.on("ready", () => {
            if (this._closing) return;
            console.log(`[Redis] ${clientName} ready`);
        });

        client.on("error", (err) => {
            if (this._closing) return;
            console.error(`[Redis] ${clientName} error:`, err.message);
            if (clientName === 'Main') this.isConnected = false;
        });

        client.on("close", () => {
            if (clientName === 'Main') this.isConnected = false;
            if (this._closing) return;
            console.log(`[Redis] ${clientName} closed`);
        });

        client.on("reconnecting", () => {
            if (this._closing) return;
            console.log(`[Redis] ${clientName} reconnecting...`);
        });
    }

    // Stop tracking a client that was already closed via another path (e.g.
    // RedisPubSubService.close() runs before closeAll() during shutdown).
    // Without this, closeAll() calls quit() a second time on a client whose
    // "end" status transition is still in flight, which throws "Connection
    // is closed." — harmless but logs a misleading error on every shutdown.
    untrackClient(client) {
        this.createdClients = this.createdClients.filter((c) => c.client !== client);
    }

    // Get connection status
    getConnectionStatus() {
        return {
            isConnected: this.isConnected,
            config: {
                host: this.config.host,
                port: this.config.port,
            },
            trackedClients: this.createdClients.length
        };
    }

    // Close main client
    async close() {
        if (this.mainClient) {
            try {
                if (this.mainClient.status !== 'end' && this.mainClient.status !== 'close') {
                    await this.mainClient.quit();
                }
                console.log('[Redis] Main client closed gracefully');
            } catch (error) {
                console.error('[Redis] Error during quit, forcing disconnect:', error.message);
                try { this.mainClient.disconnect(); } catch { }
            } finally {
                this.mainClient = null;
                this.isConnected = false;
            }
        }
    }

    // Close all tracked clients (call during graceful shutdown)
    async closeAll() {
        this._closing = true;
        console.log(`[Redis] Closing all clients (${this.createdClients.length} tracked)...`);

        for (const { name, client } of this.createdClients) {
            try {
                if (client.status === 'end') {
                    // Already fully closed — skip
                } else if (['reconnecting', 'connecting', 'wait'].includes(client.status)) {
                    client.disconnect();
                } else {
                    await client.quit();
                }
                console.log(`[Redis] Closed client "${name}"`);
            } catch (error) {
                console.error(`[Redis] Error closing client "${name}":`, error.message);
                try { client.disconnect(); } catch { }
            }
        }

        this.createdClients = [];

        // Close main client
        await this.close();

        console.log('[Redis] All clients closed');
    }
}

export const redisClient = new RedisClient();
