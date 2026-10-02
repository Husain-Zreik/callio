// src/media/rooms/FreeSwitch.js
// This worker's connection to the FreeSWITCH media server, through
// drachtio-fsmrf: an inbound event-socket connection for API commands, and a
// listener FreeSWITCH connects back to for each endpoint this worker creates
// (so an endpoint's events — DTMF, playback ends — reach the worker that
// made it). Endpoints are created with an INVITE sent through drachtio.
//
// Every leg this worker creates is tagged `callio.<bootId>.<callId>` (the
// endpoint's caller id, the rtpengine call-id prefix). The boot id is
// registered in Redis while this process runs, so the orphan sweep can tell a
// live worker's legs from a dead one's: FreeSWITCH keeps a channel up after
// the worker that controlled it is gone, and its RTP keeps flowing into
// rtpengine ports that get handed to new calls.
import { bootId } from '../../infra/cluster/WorkerBoot.js';
import Mrf from 'drachtio-fsmrf';
import { drachtio } from '../../infra/sip/Drachtio.js';
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.rooms.FreeSwitch');

const BOOT_KEY_PREFIX = 'media:boot:';
const BOOT_TTL_SECONDS = 30;
const HEARTBEAT_MS = 10_000;

class FreeSwitch {
    constructor() {
        this.bootId = bootId;
        this.ms = null;        // endpoints from the default profile (Opus first)
        this.msG711 = null;    // endpoints that offer G.711 only (to SIP carriers)
        this._mrf = null;
        this._heartbeat = null;
        this._connecting = null;
    }

    get enabled() {
        return Boolean(config.media.freeswitch.host) && drachtio.enabled;
    }

    get connected() {
        return Boolean(this.ms?.connected?.() && this.msG711?.connected?.());
    }

    tag(callId) {
        return `callio.${this.bootId}.${callId}`;
    }

    // Parses a tag back: { bootId, callId } or null.
    static parseTag(value) {
        const m = /^callio\.([0-9a-f]+)\.(\d+)/.exec(String(value ?? ''));
        return m ? { bootId: m[1], callId: Number(m[2]) } : null;
    }

    async start() {
        if (!this.enabled) {
            log.warn('FREESWITCH_HOST or DRACHTIO_HOST not set — calls have no media on this worker');
            return;
        }
        await this._beat();
        this._heartbeat = setInterval(() => this._beat(), HEARTBEAT_MS);
        this._heartbeat.unref();
        await this._connect();
    }

    async _beat() {
        await redisBaseService.set(`${BOOT_KEY_PREFIX}${this.bootId}`, String(process.pid), BOOT_TTL_SECONDS)
            .catch((err) => log.warn({ err }, 'Media boot heartbeat failed'));
    }

    async isBootAlive(bootId) {
        if (bootId === this.bootId) return true;
        try {
            return Boolean(await redisBaseService.get(`${BOOT_KEY_PREFIX}${bootId}`));
        } catch {
            return true;   // can't tell: keep it
        }
    }

    async _connect() {
        if (this._connecting) return this._connecting;
        this._connecting = (async () => {
            const fs = config.media.freeswitch;
            if (!await drachtio.ready()) throw new Error('drachtio-server is not connected');
            this._mrf = this._mrf ?? new Mrf(drachtio.srf);
            const listenPort = fs.listenPort ?? (config.node.port + 1000);
            const g711ListenPort = fs.g711ListenPort ?? (config.node.port + 2000);
            const open = async (current, profile, port) => {
                if (current?.connected?.()) return current;
                try { current?.disconnect(); } catch { /* already closed */ }
                const ms = await this._mrf.connect({
                    address: fs.host,
                    port: fs.port,
                    secret: fs.secret,
                    listenAddress: '0.0.0.0',
                    listenPort: port,
                    advertisedAddress: fs.advertisedAddress ?? '127.0.0.1',
                    profile,
                });
                ms.on('error', (err) => log.error({ err, profile }, 'FreeSWITCH connection error'));
                ms.on('end', () => log.warn({ profile }, 'FreeSWITCH event socket closed — reconnecting'));
                return ms;
            };
            this.ms = await open(this.ms, fs.sipProfile, listenPort);
            this.msG711 = await open(this.msG711, fs.g711SipProfile, g711ListenPort);
            log.info(`Connected to FreeSWITCH ${fs.host}:${fs.port} (callbacks on :${listenPort} and :${g711ListenPort}, boot ${this.bootId})`);
        })().catch((err) => {
            log.error({ err }, 'Connecting to FreeSWITCH failed');
            throw err;
        }).finally(() => { this._connecting = null; });
        return this._connecting;
    }

    async require() {
        if (this.connected) return this.ms;
        await this._connect();
        return this.ms;
    }

    // An endpoint for one leg. With `remoteSdp` FreeSWITCH answers it (the
    // endpoint's local.sdp is the answer); without, FreeSWITCH offers
    // (local.sdp is the offer; modify() later applies the answer). `g711`
    // makes that offer G.711 only (the drachtio_mrf_g711 profile).
    async createEndpoint(callId, remoteSdp = null, { g711 = false } = {}) {
        await this.require();
        const ms = g711 ? this.msG711 : this.ms;
        const ep = await ms.createEndpoint({
            ...(remoteSdp ? { remoteSdp } : {}),
            headers: { From: `<sip:${this.tag(callId)}@callio.invalid>` },
        });
        return ep;
    }

    async api(command) {
        const ms = await this.require();
        const res = await ms.api(command);
        return typeof res === 'string' ? res : (res?.getBody?.() ?? res?.body ?? String(res ?? ''));
    }

    // Channels on the media server: [{ uuid, cid_num, … }].
    async channels() {
        const body = await this.api('show channels as json');
        try {
            return JSON.parse(body).rows ?? [];
        } catch {
            return [];
        }
    }

    async stop() {
        clearInterval(this._heartbeat);
        this._heartbeat = null;
        await redisBaseService.del(`${BOOT_KEY_PREFIX}${this.bootId}`).catch(() => { });
        for (const ms of [this.ms, this.msG711]) {
            try { ms?.disconnect(); } catch { /* already closed */ }
        }
        this.ms = null;
        this.msG711 = null;
    }
}

export const freeSwitch = new FreeSwitch();
export { FreeSwitch };
