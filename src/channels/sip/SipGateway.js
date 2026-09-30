// src/channels/sip/SipGateway.js
// This worker's connections to the SIP gateway (deploy/sip-gateway): the
// drachtio-server control connection (SIP signaling) and the rtpengine ng
// client (media conversion). Every worker connects; drachtio-server spreads
// new INVITEs across the connected workers, and in-dialog requests (BYE) go
// back to the worker that owns the dialog.
import Srf from 'drachtio-srf';
import { RtpEngineClient } from './RtpEngineClient.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('channels.sip.SipGateway');

class SipGateway {
    constructor() {
        this.srf = null;
        this.rtpengine = null;
        this.connected = false;
    }

    get enabled() {
        return Boolean(config.sip.drachtio.host);
    }

    start(onInvite) {
        if (!this.enabled || this.srf) return;
        const { drachtio, rtpengine } = config.sip;

        this.rtpengine = new RtpEngineClient(rtpengine);
        this.srf = new Srf();
        this.srf.invite(onInvite);
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

    stop() {
        try { this.srf?.disconnect(); } catch { /* already closed */ }
        this.rtpengine?.close();
        this.srf = null;
        this.rtpengine = null;
        this.connected = false;
    }

    require() {
        if (!this.srf || !this.connected) throw new Error('The SIP gateway is not connected');
        return { srf: this.srf, rtpengine: this.rtpengine };
    }
}

export const sipGateway = new SipGateway();
