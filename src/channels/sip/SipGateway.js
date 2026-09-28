// src/channels/sip/SipGateway.js
// This worker's connections to the SIP gateway (deploy/sip-gateway): the
// drachtio-server control connection (SIP signaling) and the rtpengine ng
// client (media conversion). Every worker connects; drachtio-server spreads
// new INVITEs across the connected workers, and in-dialog requests (BYE) go
// back to the worker that owns the dialog.
import Srf from 'drachtio-srf';
import { RtpEngineClient } from './RtpEngineClient.js';
import { config } from '../../../config/envConfig.js';

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
                console.error('[SIP] drachtio connection failed:', err);
                return;
            }
            this.connected = true;
            console.log(`[SIP] Connected to drachtio-server (${hostport})`);
        });
        // drachtio-srf reconnects by itself; this only tracks the state.
        this.srf.on('error', (err) => {
            if (this.connected) console.warn(`[SIP] drachtio connection lost: ${err.message}`);
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
