// src/channels/sip/sipLegs.js
// Ending a SIP leg: forget it, and tell the core the provider-side timing
// (its media leg is the media plane's, closed with the call). The core's own end (an agent hanging up, a queue
// timeout) has usually already committed the call — reporting the end anyway
// fills in the durations only the channel knows, the way WhatsApp's end
// webhook does after Callio terminates.
import { channelIngress } from '../../core/channels/ChannelIngress.js';
import { sipDialogs } from './SipDialogs.js';

/**
 * @param {object} leg
 * @param {object} end
 *   providerStatus  e.g. 'COMPLETED', 'CANCELLED', 'BUSY'
 *   failed, errors  a carrier failure ({ code: SIP status, title: reason })
 */
export async function finishLeg(leg, { providerStatus = 'COMPLETED', failed = false, errors = null } = {}) {
    if (leg.finished) return;
    leg.finished = true;
    const endedAt = new Date();

    await sipDialogs.remove(leg.providerCallId);

    await channelIngress.callEnded(leg.channel, {
        providerCallId: leg.providerCallId,
        providerStatus,
        failed,
        answeredAt: leg.answeredAt ?? null,
        endedAt,
        durationSec: leg.answeredAt ? Math.max(0, Math.round((endedAt - leg.answeredAt) / 1000)) : null,
        errors,
        failureTerminatedBy: 'PROVIDER',
    });
}
