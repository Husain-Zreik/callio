// src/channels/sip/SipIngress.js
// Inbound SIP → core/channels/ChannelIngress.js. The only code that knows
// how a carrier call arrives: the dialled number resolves the channel, the
// channel's trunk vouches for the source, rtpengine turns the carrier's offer
// into a WebRTC offer for Callio's customer peer, and CANCEL / BYE become the
// provider's end of the call. Every call decision is the ingress's.
import ChannelRepository from '../../persistence/ChannelRepository.js';
import SipTrunkRepository from '../../persistence/SipTrunkRepository.js';
import CallRepository from '../../persistence/CallRepository.js';
import { channelIngress } from '../../core/channels/ChannelIngress.js';
import { Channel, CallStatus } from '../../core/constants/CallConstants.js';
import { sipGateway } from './SipGateway.js';
import { sipDialogs } from './SipDialogs.js';
import { finishLeg } from './sipLegs.js';
import { dialledNumber, callerOf, sourceAllowed } from './sipAddress.js';
import { logger, throttle } from '../../infra/logging/logger.js';

const log = logger('channels.sip.SipIngress');

const TERMINAL = new Set([CallStatus.TERMINATED, CallStatus.FAILED, CallStatus.CANCELLED]);

export async function handleInvite(req, res) {
    const providerCallId = req.get('Call-ID');
    const did = dialledNumber(req);
    const source = req.source_address;
    log.debug({ providerCallId, did, source }, 'INVITE received');

    // Refusals are rate-limited per source: an internet scanner sends many a second.
    const refuse = (status, msg, fields) => {
        const repeated = throttle(`sip-refuse:${source}:${status}`, 60_000);
        if (repeated !== null) log.warn({ source, did, uri: req.uri, ...fields, ...(repeated ? { repeated } : {}) }, msg);
        return res.send(status);
    };
    const channel = did ? await ChannelRepository.findActiveByAddress(Channel.SIP, did) : null;
    if (!channel) return refuse(404, 'INVITE for a number with no active SIP channel — 404');
    const trunk = await SipTrunkRepository.findById(channel.sip_trunk_id);
    if (!trunk || trunk.status !== 'ACTIVE' || !sourceAllowed(trunk, source)) {
        return refuse(403, 'INVITE from a source the trunk does not allow — 403', { channelId: channel.id });
    }
    log.info({ providerCallId, did, source, channelId: channel.id }, 'INVITE accepted');

    let sdpOffer;
    try {
        sdpOffer = await sipGateway.rtpengine.carrierOfferToWebrtc({ callId: providerCallId, sdp: req.body });
    } catch (err) {
        log.error({ err }, `rtpengine refused the offer for ${providerCallId}`);
        return res.send(488);
    }

    const leg = { providerCallId, channel, direction: 'INBOUND', rtpKey: providerCallId, req, res, dialog: null, answeredAt: null };
    await sipDialogs.add(providerCallId, leg);

    // The caller hangs up before anyone answers.
    req.on('cancel', () => {
        leg.res = null;
        finishLeg(leg, { providerStatus: 'CANCELLED' })
            .catch((err) => log.error({ err }, `Ending cancelled call ${providerCallId} failed`));
    });

    res.send(180);
    await channelIngress.inboundCall(channel, {
        providerCallId,
        customer: callerOf(req),
        sdpOffer,
        offeredAt: new Date(),
        providerMetadata: {
            from: req.get('From'),
            to: req.get('To'),
            source: `${req.source_address}:${req.source_port}`,
        },
    });

    // The ingress may have finished the call without answering it (a
    // duplicate of a call already up, a failure) — never leave the carrier
    // ringing.
    const call = await CallRepository.findByProviderCallId(providerCallId, Channel.SIP);
    if (leg.res && (!call || TERMINAL.has(call.status))) {
        leg.res.send(480);
        leg.res = null;
        await finishLeg(leg, { providerStatus: 'NOT_ACCEPTED' });
    }
}
