// src/channels/sip/SipDialogs.js
// The SIP legs this worker holds, by SIP Call-ID. A SIP transaction or dialog
// lives in the memory of the worker whose drachtio connection received (or
// sent) it — like a call's media — so actions from other workers (a queue
// timeout, cleanup, the API) are routed here: each leg records its owner in
// Redis, and every worker listens for commands on a channel of its own.
import { redisClient } from '../../infra/redis/RedisClient.js';
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('channels.sip.SipDialogs');

const OWNER_TTL_SECONDS = 86400;
const ownerKey = (providerCallId) => `callio:sip:owner:${providerCallId}`;
// An answered leg's drachtio dialog id: a worker taking the call over sends
// in-dialog requests (BYE, OPTIONS) by it.
const dialogKey = (providerCallId) => `callio:sip:dialog:${providerCallId}`;
const workerChannel = (workerId) => `callio:sip:worker:${workerId}`;

class SipDialogs {
    constructor() {
        this.workerId = String(config.runtime.workerId);
        this._legs = new Map();
        this._subscriber = null;
    }

    // onCommand({ action, providerCallId }) runs a command routed to this worker.
    async start(onCommand) {
        if (this._subscriber) return;
        this._subscriber = redisClient.createClient('SIP-Commands');
        this._subscriber.on('message', (_channel, message) => {
            let command;
            try { command = JSON.parse(message); } catch { return; }
            Promise.resolve(onCommand(command)).catch((err) =>
                log.error({ providerCallId: command?.providerCallId, action: command?.action, err }, 'Routed SIP action failed')
            );
        });
        await this._subscriber.subscribe(workerChannel(this.workerId));
    }

    async stop() {
        const sub = this._subscriber;
        this._subscriber = null;
        if (sub) await sub.quit().catch(() => sub.disconnect());
    }

    get(providerCallId) {
        return this._legs.get(providerCallId) ?? null;
    }

    all() {
        return [...this._legs.values()];
    }

    async add(providerCallId, leg) {
        this._legs.set(providerCallId, leg);
        await redisBaseService.set(ownerKey(providerCallId), this.workerId, OWNER_TTL_SECONDS);
    }

    async remove(providerCallId) {
        if (!this._legs.delete(providerCallId)) return;
        await redisBaseService.del(dialogKey(providerCallId));
        const owner = await redisBaseService.get(ownerKey(providerCallId));
        if (owner === this.workerId) await redisBaseService.del(ownerKey(providerCallId));
    }

    // Lets go of a leg without touching Redis: its dialog key and owner record
    // stay for the worker that takes the call over (shutdown hand-over).
    forget(providerCallId) {
        this._legs.delete(providerCallId);
    }

    async saveDialog(leg) {
        await redisBaseService.set(dialogKey(leg.providerCallId), JSON.stringify({
            dialogId: leg.dialog.id, direction: leg.direction, answeredAt: leg.answeredAt?.toISOString() ?? null,
        }), OWNER_TTL_SECONDS);
    }

    async loadDialog(providerCallId) {
        const raw = await redisBaseService.get(dialogKey(providerCallId));
        return raw ? JSON.parse(raw) : null;
    }

    // Sends a command to the worker holding the leg. False if nobody holds it.
    async sendToOwner(providerCallId, action) {
        const owner = await redisBaseService.get(ownerKey(providerCallId));
        if (!owner) return false;
        await redisBaseService.publish(workerChannel(owner), JSON.stringify({ action, providerCallId }));
        return true;
    }
}

export const sipDialogs = new SipDialogs();
