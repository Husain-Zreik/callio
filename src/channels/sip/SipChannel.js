// src/channels/sip/SipChannel.js
// SIP trunks as a customer channel (the port is documented in
// core/channels/CustomerChannels.js). drachtio-server carries the signaling
// and rtpengine converts the media between the carrier's plain RTP and the
// WebRTC session Callio's media engine terminates — so inside Callio a SIP
// customer leg is an ordinary WebRTC peer, like a WhatsApp one.
//
// Inbound calls arrive through SipIngress. A leg (SIP transaction/dialog)
// lives on the worker that received or placed it; accept runs there (it's
// where the call's media is), and reject/terminate from any other worker are
// routed there through SipDialogs.
import ChannelRepository from '../../persistence/ChannelRepository.js';
import SipTrunkRepository from '../../persistence/SipTrunkRepository.js';
import CallRepository from '../../persistence/CallRepository.js';
import { channelIngress } from '../../core/channels/ChannelIngress.js';
import { Channel, CustomerAddressType } from '../../core/constants/CallConstants.js';
import { sipGateway } from './SipGateway.js';
import { sipDialogs } from './SipDialogs.js';
import { finishLeg } from './sipLegs.js';
import { handleInvite } from './SipIngress.js';
import { sipSdpProfile } from './sipSdp.js';
import { toE164, userPart } from './sipAddress.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('channels.sip.SipChannel');

// A carrier's final response to our INVITE, as the core sees it.
const REJECTED_STATUSES = new Set([486, 600, 603]);

// Answering the carrier: the leg's pending INVITE becomes a dialog.
async function acceptLeg(leg, sdpAnswer) {
    const { srf, rtpengine } = sipGateway.require();
    const carrierSdp = await rtpengine.webrtcAnswerToCarrier({ callId: leg.rtpKey, sdp: sdpAnswer });
    const { req, res } = leg;
    leg.res = null;
    leg.dialog = await srf.createUAS(req, res, { localSdp: carrierSdp });
    leg.answeredAt = new Date();
    leg.dialog.on('destroy', () => finishLeg(leg, { providerStatus: 'COMPLETED' })
        .catch((err) => log.error({ providerCallId: leg.providerCallId, err }, 'Ending the call after BYE failed')));
}

// Ends a leg from our side, whatever state it is in.
async function endLeg(leg, { status = 480 } = {}) {
    if (leg.dialog) {
        const dialog = leg.dialog;
        leg.dialog = null;
        dialog.destroy();              // BYE; a local destroy emits no 'destroy'
    } else if (leg.res) {
        const res = leg.res;
        leg.res = null;
        res.send(status);              // unanswered inbound: final error response
    } else if (leg.uacRequest) {
        const request = leg.uacRequest;
        leg.uacRequest = null;
        leg.cancelled = true;
        request.cancel();              // unanswered outbound: CANCEL
    }
    await finishLeg(leg, { providerStatus: 'COMPLETED' });
}

async function runOnOwner(call, action, local) {
    const leg = sipDialogs.get(call.provider_call_id);
    if (leg) return local(leg);
    if (!call.provider_call_id || !await sipDialogs.sendToOwner(call.provider_call_id, action)) {
        log.warn({ callId: call.id, providerCallId: call.provider_call_id, action }, 'No worker holds the SIP leg — action skipped');
    }
}

// A command routed from another worker (SipDialogs).
async function onCommand({ action, providerCallId }) {
    const leg = sipDialogs.get(providerCallId);
    if (!leg) return;
    log.debug({ providerCallId, action }, 'Routed action to the owning worker');
    await endLeg(leg);
}

async function initiate(call, sdpOffer) {
    const { srf, rtpengine } = sipGateway.require();
    const channel = await ChannelRepository.findById(call.channel_id);
    const trunk = channel ? await SipTrunkRepository.findById(channel.sip_trunk_id) : null;
    if (!trunk || trunk.status !== 'ACTIVE') throw new Error(`Channel ${call.channel_id} has no active SIP trunk`);
    const credentials = await SipTrunkRepository.getCredentials(trunk.id);

    const rtpKey = `callio-out-${call.id}`;
    const carrierOffer = await rtpengine.webrtcOfferToCarrier({ callId: rtpKey, sdp: sdpOffer });
    const target = `sip:${userPart(call.customer_address)}@${trunk.host}:${trunk.port};transport=${trunk.transport.toLowerCase()}`;
    const from = `<sip:${userPart(channel.address)}@${trunk.host}>`;

    return new Promise((resolve, reject) => {
        let leg = null;
        srf.createUAC(target, {
            localSdp: carrierOffer,
            headers: { From: from },
            ...(credentials?.username ? { auth: { username: credentials.username, password: credentials.password } } : {}),
        }, {
            cbRequest: async (err, request) => {
                if (err) { reject(err); return; }
                const providerCallId = request.get('Call-ID');
                leg = { providerCallId, channel, direction: 'OUTBOUND', rtpKey, uacRequest: request, dialog: null, answeredAt: null };
                await sipDialogs.add(providerCallId, leg);
                // Stored before the carrier can ring or answer, so its events find the call.
                await CallRepository.updateProviderCallId(call.id, providerCallId);
                resolve(providerCallId);
            },
            cbProvisional: (provisional) => {
                if (!leg || ![180, 183].includes(provisional.status)) return;
                channelIngress.statusChanged(channel, { providerCallId: leg.providerCallId, status: 'RINGING', at: new Date() })
                    .catch((err) => log.error({ providerCallId: leg.providerCallId, err }, 'Reporting RINGING failed'));
            },
        }).then(async (dialog) => {
            leg.uacRequest = null;
            leg.dialog = dialog;
            leg.answeredAt = new Date();
            dialog.on('destroy', () => finishLeg(leg, { providerStatus: 'COMPLETED' })
                .catch((err) => log.error({ providerCallId: leg.providerCallId, err }, 'Ending the call after BYE failed')));
            const sdpAnswer = await rtpengine.carrierAnswerToWebrtc({ callId: rtpKey, sdp: dialog.remote.sdp });
            await channelIngress.outboundAnswered(channel, { providerCallId: leg.providerCallId, sdpAnswer });
            await channelIngress.statusChanged(channel, { providerCallId: leg.providerCallId, status: 'ACCEPTED', at: leg.answeredAt });
        }).catch(async (err) => {
            if (!leg) { reject(err); return; }
            leg.uacRequest = null;
            if (leg.cancelled || leg.finished) return;   // we ended it ourselves
            const status = Number(err.status) || null;
            // A SIP final response is an outcome, not a fault: log the status; keep the stack for real errors.
            log.info({ providerCallId: leg.providerCallId, ...(status ? { sipStatus: status } : { err }) }, 'Outbound SIP call not answered');
            if (status && REJECTED_STATUSES.has(status)) {
                await sipGateway.rtpengine?.delete(rtpKey);
                await sipDialogs.remove(leg.providerCallId);
                leg.finished = true;
                await channelIngress.statusChanged(channel, { providerCallId: leg.providerCallId, status: 'REJECTED', at: new Date() });
                return;
            }
            await finishLeg(leg, {
                providerStatus: status === 408 || status === 480 ? 'NO_ANSWER' : 'FAILED',
                failed: !(status === 408 || status === 480),
                errors: [{ code: status ?? 'SIP_ERROR', title: err.reason ?? err.message }],
            });
        });
    });
}

export const sipChannel = Object.freeze({
    type: Channel.SIP,
    supportsOutbound: true,
    sdp: sipSdpProfile,

    async accept(call, sdpAnswer) {
        const leg = sipDialogs.get(call.provider_call_id);
        if (!leg?.res) throw new Error(`SIP call ${call.provider_call_id} is not ringing on this worker`);
        await acceptLeg(leg, sdpAnswer);
    },

    async reject(call) {
        await runOnOwner(call, 'reject', (leg) => endLeg(leg, { status: 480 }));
    },

    async terminate(call) {
        await runOnOwner(call, 'terminate', (leg) => endLeg(leg));
    },

    initiate,

    normalizeCustomerAddress({ address, addressType }) {
        const e164 = toE164(address);
        if (addressType === CustomerAddressType.SIP_URI || (!e164 && /^sips?:/i.test(String(address)))) {
            return { address: String(address), addressType: CustomerAddressType.SIP_URI };
        }
        if (!e164) throw new Error('A SIP call needs an E.164 number or a sip: URI');
        return { address: e164, addressType: CustomerAddressType.E164 };
    },

    validateChannelConfig(body) {
        if (!toE164(body.address)) return 'address must be the DID in E.164 form for SIP channels';
        if (body.sip_trunk_id == null) return 'sip_trunk_id is required for SIP channels';
        return null;
    },

    async start() {
        if (!sipGateway.enabled) {
            log.info('DRACHTIO_HOST not set — SIP channel disabled on this worker');
            return;
        }
        await sipDialogs.start(onCommand);
        sipGateway.start((req, res) => handleInvite(req, res).catch((err) => {
            log.error({ providerCallId: req.get('Call-ID'), err }, 'Handling INVITE failed');
            try { res.send(500); } catch { /* already answered */ }
        }));
    },

    async stop() {
        for (const leg of sipDialogs.all()) {
            await endLeg(leg).catch(() => { });
        }
        await sipDialogs.stop();
        sipGateway.stop();
    },
});
