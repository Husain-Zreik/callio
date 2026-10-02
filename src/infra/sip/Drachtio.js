// src/infra/sip/Drachtio.js
// This worker's control connection to drachtio-server (deploy/sip-gateway).
// Two users: the SIP channel (carrier calls; drachtio spreads new INVITEs
// across connected workers, and sends in-dialog requests back to the worker
// that owns the dialog), and the media plane, whose FreeSWITCH endpoints are
// created by INVITEs sent through it (drachtio-fsmrf). Every worker connects.
import Srf from 'drachtio-srf';
import { config } from '../../../config/envConfig.js';
import { logger } from '../logging/logger.js';

const log = logger('infra.sip.Drachtio');

class Drachtio {
    constructor() {
        this.srf = null;
        this.connected = false;
        this._onInvite = null;
        this._waiters = [];
    }

    get enabled() {
        return Boolean(config.sip.drachtio.host);
    }

    // Inbound INVITEs (the SIP channel). Set before or after start().
    onInvite(handler) {
        this._onInvite = handler;
    }

    start() {
        if (!this.enabled || this.srf) return;
        const { drachtio } = config.sip;
        this.srf = new Srf();
        this.srf.invite((req, res) => {
            if (this._onInvite) return this._onInvite(req, res);
            res.send(503);
        });
        this.srf.on('connect', (err, hostport) => {
            if (err) {
                // drachtio-srf's errors are often plain objects that log as {}.
                const reason = err.message ?? err.code ?? (typeof err === 'string' ? err : JSON.stringify(err, Object.getOwnPropertyNames(err)));
                const key = String(reason);
                if (key !== this._lastError) {
                    this._lastError = key;
                    log.error(`drachtio connection to ${drachtio.host}:${drachtio.port} failed: ${reason} — check that the gateway is running and DRACHTIO_SECRET equals DRACHTIO_SECRET in deploy/sip-gateway/.env`);
                }
                return;
            }
            this._lastError = null;
            this.connected = true;
            log.info(`Connected to drachtio-server (${hostport})`);
            for (const resolve of this._waiters.splice(0)) resolve();
        });
        // drachtio-srf reconnects by itself; this only tracks the state.
        this.srf.on('error', (err) => {
            const reason = err?.message ?? err?.code ?? String(err);
            if (this.connected) {
                log.warn(`drachtio connection lost: ${reason}`);
            } else if (reason !== this._lastError) {
                // Not reachable at all (e.g. ECONNREFUSED: the gateway isn't running).
                this._lastError = reason;
                log.error(`drachtio at ${drachtio.host}:${drachtio.port} unreachable: ${reason} — is the SIP gateway running?`);
            }
            this.connected = false;
        });
        this.srf.connect({ host: drachtio.host, port: drachtio.port, secret: drachtio.secret });
    }

    // Resolves once connected (or after timeoutMs, false).
    async ready(timeoutMs = 10_000) {
        if (this.connected) return true;
        if (!this.srf) return false;
        return Promise.race([
            new Promise((resolve) => this._waiters.push(() => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs).unref()),
        ]);
    }

    stop() {
        try { this.srf?.disconnect(); } catch { /* already closed */ }
        this.srf = null;
        this.connected = false;
    }

    require() {
        if (!this.srf || !this.connected) throw new Error('drachtio-server is not connected');
        return this.srf;
    }
}

export const drachtio = new Drachtio();
