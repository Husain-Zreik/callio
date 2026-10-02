// src/media/rooms/CustomerLegMonitor.js
// Watches the customer leg from rtpengine's side: what the customer sends.
//   - Their packets stop for 3 s → 'customer:media:state' drop; they come
//     back → active (CustomerNetworkLossPolicy decides what a drop means).
//     Packets, not sound: a muted customer still sends packets. rtpengine
//     counts RTP and (multiplexed) RTCP together, so it's a rate: audio is
//     ~50 packets/s, Opus DTX in silence ~2.5/s, RTCP alone ≤ 1 per few s —
//     under 4 packets in 3 s is a drop, 3 a second is audio again.
//   - Every 4 s, the latest RTCP-derived report → 'call:network:quality:customer'
//     (4 bars = best), the same shape the agent UI always had.
//
// One poller per worker drives every monitor: each call's poll is spread
// over the second (no burst when many calls started together), a call never
// has two queries in flight (a slow rtpengine isn't sent more work), and at
// most MAX_IN_FLIGHT queries run at once. rtpengine's ng protocol has no
// multi-call query, so this is as batched as it gets.
import EventBus from '../../core/EventBus.js';
import { rtpLegs } from './RtpLegs.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.rooms.CustomerLegMonitor');

const POLL_MS = 1000;
const TICK_MS = 100;
const MAX_IN_FLIGHT = 32;
const DROP_WINDOW_MS = 3000;
const DROP_BELOW_PACKETS = 4;    // in the window
const ACTIVE_FROM_PACKETS = 3;   // a second
const QUALITY_MS = 4000;

function qualityFrom({ packetLoss, jitter }) {
    const lossPct = Number(packetLoss ?? 0);
    const j = Number(jitter ?? 0);
    let bars, label;
    if (lossPct < 1 && j < 20) { bars = 4; label = 'Excellent'; }
    else if (lossPct < 3 && j < 40) { bars = 3; label = 'Good'; }
    else if (lossPct < 8 && j < 80) { bars = 2; label = 'Fair'; }
    else { bars = 1; label = 'Poor'; }
    const score = Math.max(0, Math.min(100, Math.round(100 - j * 0.8 - lossPct * 4)));
    return { bars, label, score, packetLoss: +lossPct.toFixed(1), jitter: Math.round(j) };
}

class LegPoller {
    constructor() {
        this.monitors = new Set();
        this.inFlight = 0;
        this._timer = null;
    }

    add(monitor) {
        monitor._nextAt = Date.now() + Math.floor(Math.random() * POLL_MS);
        this.monitors.add(monitor);
        if (!this._timer) {
            this._timer = setInterval(() => this._tick(), TICK_MS);
            this._timer.unref();
        }
    }

    remove(monitor) {
        this.monitors.delete(monitor);
        if (!this.monitors.size && this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    _tick() {
        const now = Date.now();
        for (const m of this.monitors) {
            if (this.inFlight >= MAX_IN_FLIGHT) return;
            if (m._busy || now < m._nextAt) continue;
            // Late (rtpengine slow, cap reached): next poll a period from now,
            // not a catch-up burst.
            m._nextAt = Math.max(m._nextAt + POLL_MS, now + POLL_MS / 2);
            m._busy = true;
            this.inFlight++;
            m._poll()
                .catch((err) => log.debug({ callId: m.callId, err }, 'Customer leg poll failed'))
                .finally(() => { m._busy = false; this.inFlight--; });
        }
    }
}

const poller = new LegPoller();

export class CustomerLegMonitor {
    constructor(callId, rtpKey) {
        this.callId = callId;
        this.rtpKey = rtpKey;
        this._samples = [];        // { at, packets }, oldest first
        this._state = 'waiting';   // waiting (no audio yet) | active | drop
        this._qualityAt = 0;
        this._busy = false;
        this._nextAt = 0;
        this._stopped = false;
    }

    start() {
        this._stopped = false;
        poller.add(this);
    }

    stop() {
        this._stopped = true;
        poller.remove(this);
    }

    async _poll() {
        const { packets, quality } = await rtpLegs.received(this.rtpKey);
        if (this._stopped) return;
        const now = Date.now();
        const samples = this._samples;
        samples.push({ at: now, packets });
        // Keep exactly one sample at or beyond the window's start.
        while (samples.length > 2 && now - samples[1].at >= DROP_WINDOW_MS) samples.shift();

        const n = samples.length;
        const prev = n >= 2 ? samples[n - 2] : null;
        const sinceLast = prev ? packets - prev.packets : 0;
        const perSecond = prev ? (sinceLast * 1000) / Math.max(1, now - prev.at) : 0;
        const first = samples[0];
        const windowFull = now - first.at >= DROP_WINDOW_MS;

        if (this._state !== 'active' && perSecond >= ACTIVE_FROM_PACKETS) {
            if (this._state === 'drop') this._set('active');
            else this._state = 'active';
        } else if (this._state === 'active' && windowFull && packets - first.packets < DROP_BELOW_PACKETS) {
            this._set('drop');
        }
        if (this._state === 'active' && quality && now - this._qualityAt >= QUALITY_MS) {
            this._qualityAt = now;
            EventBus.emit('call:network:quality:customer', { callId: this.callId, ...qualityFrom(quality) });
        }
    }

    _set(state) {
        this._state = state;
        log.info({ callId: this.callId }, `Customer audio ${state === 'drop' ? 'stopped' : 'resumed'}`);
        EventBus.emit('customer:media:state', { callId: this.callId, state });
    }
}
