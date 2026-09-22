// services/call/audio/bridge/CustomerNetworkMonitor.js
//
// Polls the WhatsApp WebRTC peer connection's getStats() every POLL_MS and
// derives a 4-level signal quality for the customer's audio stream.
//
// Metrics used:
//   inbound-rtp.jitter       — timestamp-smoothed jitter (seconds → ms)
//   inbound-rtp.packetsLost  — cumulative; delta over each interval gives loss%
//   inbound-rtp.packetsReceived — denominator for loss%
//
// Quality → bars + score mapping (4 bars / 100 score = best):
//   Excellent  jitter <  20 ms  &&  loss < 1 %   →  4 bars
//   Good       jitter <  40 ms  &&  loss < 3 %   →  3 bars
//   Fair       jitter <  80 ms  &&  loss < 8 %   →  2 bars
//   Poor       anything worse                    →  1 bar
//
// score (0-100) is a continuous value used for the line-graph Y-axis:
//   score = clamp(100 - jitter_ms * 0.8 - packet_loss_pct * 4, 0, 100)

const POLL_MS = 4000;

function qualityFromMetrics(packetLossFraction, jitterMs) {
    const loss = packetLossFraction ?? 0;
    const j = jitterMs ?? 0;
    const lossPct = loss * 100;

    let bars, label;
    if (loss < 0.01 && j < 20)      { bars = 4; label = 'Excellent'; }
    else if (loss < 0.03 && j < 40) { bars = 3; label = 'Good'; }
    else if (loss < 0.08 && j < 80) { bars = 2; label = 'Fair'; }
    else                             { bars = 1; label = 'Poor'; }

    const score = Math.max(0, Math.min(100, Math.round(100 - j * 0.8 - lossPct * 4)));
    return { bars, label, score };
}

export class CustomerNetworkMonitor {
    constructor(pc, callId, onQuality) {
        this._pc = pc;
        this._callId = callId;
        this._onQuality = onQuality;
        this._timer = null;
        this._prevReceived = 0;
        this._prevLost = 0;
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this._poll(), POLL_MS);
        console.log(`[CustomerNetworkMonitor] Started for call ${this._callId}`);
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        console.log(`[CustomerNetworkMonitor] Stopped for call ${this._callId}`);
    }

    async _poll() {
        if (!this._pc || this._pc.connectionState === 'closed') return;
        try {
            const stats = await this._pc.getStats();
            let jitterMs = null;
            let packetLossFraction = null;

            stats.forEach(report => {
                if (report.type !== 'inbound-rtp' || report.kind !== 'audio') return;

                if (typeof report.jitter === 'number') {
                    jitterMs = report.jitter * 1000; // seconds → ms
                }

                const nowReceived = report.packetsReceived ?? 0;
                const nowLost = Math.max(report.packetsLost ?? 0, 0);
                const dRx = nowReceived - this._prevReceived;
                const dLost = Math.max(nowLost - this._prevLost, 0);
                this._prevReceived = nowReceived;
                this._prevLost = nowLost;

                if (dRx + dLost > 0) {
                    packetLossFraction = dLost / (dRx + dLost);
                }
            });

            if (jitterMs === null && packetLossFraction === null) return;

            const quality = qualityFromMetrics(packetLossFraction, jitterMs);
            const packetLoss = packetLossFraction !== null ? +(packetLossFraction * 100).toFixed(1) : null;
            const jitter = jitterMs !== null ? Math.round(jitterMs) : null;
            this._onQuality(this._callId, { ...quality, packetLoss, jitter });
        } catch (err) {
            if (this._pc?.connectionState !== 'closed' && this._pc?.connectionState !== 'closing') {
                console.warn(`[CustomerNetworkMonitor] getStats error for call ${this._callId}: ${err.message}`);
            }
        }
    }
}
