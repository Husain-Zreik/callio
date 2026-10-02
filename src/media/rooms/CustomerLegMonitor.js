// src/media/rooms/CustomerLegMonitor.js
// Watches the customer leg from rtpengine's side: what the customer sends.
//   - Their packets stop for 3 s → 'customer:media:state' drop; they come
//     back → active (CustomerNetworkLossPolicy decides what a drop means).
//     Packets, not sound: a muted customer still sends packets. rtpengine
//     counts RTP and (multiplexed) RTCP together, so it's a rate: audio is
//     ~50 packets/s, Opus DTX in silence ~2.5/s, RTCP alone ≤ 1 per few s —
//     under 4 packets in 3 s is a drop, 3 in a second is audio again.
//   - Every 4 s, the latest RTCP-derived report → 'call:network:quality:customer'
//     (4 bars = best), the same shape the agent UI always had.
import EventBus from '../../core/EventBus.js';
import { rtpLegs } from './RtpLegs.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.rooms.CustomerLegMonitor');

const POLL_MS = 1000;
const DROP_WINDOW_POLLS = 3;     // 3 s
const DROP_BELOW_PACKETS = 4;    // in the window
const ACTIVE_FROM_PACKETS = 3;   // in one poll
const QUALITY_EVERY = 4;         // polls

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

export class CustomerLegMonitor {
    constructor(callId, rtpKey) {
        this.callId = callId;
        this.rtpKey = rtpKey;
        this._timer = null;
        this._samples = [];        // packet counts, one per poll, newest last
        this._state = 'waiting';   // waiting (no audio yet) | active | drop
        this._polls = 0;
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this._poll().catch((err) =>
            log.debug({ callId: this.callId, err }, 'Customer leg poll failed')), POLL_MS);
        this._timer.unref();
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    async _poll() {
        const { packets, quality } = await rtpLegs.received(this.rtpKey);
        this._samples.push(packets);
        if (this._samples.length > DROP_WINDOW_POLLS + 1) this._samples.shift();
        const n = this._samples.length;
        const lastPoll = n >= 2 ? this._samples[n - 1] - this._samples[n - 2] : 0;
        const window = n > DROP_WINDOW_POLLS ? this._samples[n - 1] - this._samples[0] : null;

        if (this._state !== 'active' && lastPoll >= ACTIVE_FROM_PACKETS) {
            if (this._state === 'drop') this._set('active');
            else this._state = 'active';
        } else if (this._state === 'active' && window !== null && window < DROP_BELOW_PACKETS) {
            this._set('drop');
        }
        if (++this._polls % QUALITY_EVERY === 0 && this._state === 'active' && quality) {
            EventBus.emit('call:network:quality:customer', { callId: this.callId, ...qualityFrom(quality) });
        }
    }

    _set(state) {
        this._state = state;
        log.info({ callId: this.callId }, `Customer audio ${state === 'drop' ? 'stopped' : 'resumed'}`);
        EventBus.emit('customer:media:state', { callId: this.callId, state });
    }
}
