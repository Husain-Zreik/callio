// src/channels/sip/SipChannel.js
// SIP trunks as a customer channel (the port is documented in
// core/channels/CustomerChannels.js). drachtio-server carries the signaling;
// the carrier's SDP goes to the media plane as it is (sdpProfile transport
// 'rtp'), which anchors it on rtpengine and answers or offers for it.
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
import { drachtio } from '../../infra/sip/Drachtio.js';
import { sipDialogs } from './SipDialogs.js';
import { finishLeg } from './sipLegs.js';
import { handleInvite } from './SipIngress.js';
import { sipSdpProfile } from './sipSdp.js';
import { toE164, userPart } from './sipAddress.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('channels.sip.SipChannel');

// A carrier's final response to our INVITE, as the core sees it.
const REJECTED_STATUSES = new Set([486, 600, 603]);
const PROBE_MS = 5000;

// A carrier dialog taken over from a worker that died: its drachtio object
// died with that worker; requests inside it go by dialog id.
function remoteDialog(dialogId) {
    return {
        id: dialogId,
        remote: {},
        destroy() {
            drachtio.requestInDialog(dialogId, { method: 'BYE' })
                .catch((err) => log.debug({ err }, 'BYE on a taken-over dialog failed'));
        },
    };
}

// The carrier's BYE for a taken-over dialog goes to the dead worker's
// drachtio connection, so this worker asks instead: an in-dialog OPTIONS
// every few seconds. 481/408 (or two failures in a row: drachtio no longer
// has the dialog) means the customer hung up.
function probeDialog(leg) {
    let failures = 0;
    leg.probe = setInterval(async () => {
        if (leg.finished || !leg.dialog) { clearInterval(leg.probe); return; }
        let gone = false;
        try {
            const res = await drachtio.requestInDialog(leg.dialog.id, { method: 'OPTIONS' }, PROBE_MS - 1000);
            gone = res.status === 481 || res.status === 408;
            failures = 0;
        } catch {
            gone = ++failures >= 2;
        }
        if (!gone || leg.finished) return;
        clearInterval(leg.probe);
        log.info({ providerCallId: leg.providerCallId }, 'The carrier no longer has the dialog — the customer hung up');
        await finishLeg(leg, { providerStatus: 'COMPLETED' })
            .catch((err) => log.error({ providerCallId: leg.providerCallId, err }, 'Ending the call after the dialog went failed'));
    }, PROBE_MS);
    leg.probe.unref();
}

// Answering the carrier: the leg's pending INVITE becomes a dialog.
async function acceptLeg(leg, sdpAnswer) {
    const srf = drachtio.require();
    const { req, res } = leg;
    leg.res = null;
    leg.dialog = await srf.createUAS(req, res, { localSdp: sdpAnswer });
    leg.answeredAt = new Date();
    await sipDialogs.saveDialog(leg).catch((err) => log.warn({ providerCallId: leg.providerCallId, err }, 'Saving the SIP dialog failed'));
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
    const srf = drachtio.require();
    const channel = await ChannelRepository.findById(call.channel_id);
    const trunk = channel ? await SipTrunkRepository.findById(channel.sip_trunk_id) : null;
    if (!trunk || trunk.status !== 'ACTIVE') throw new Error(`Channel ${call.channel_id} has no active SIP trunk`);
    const credentials = await SipTrunkRepository.getCredentials(trunk.id);

    const target = `sip:${userPart(call.customer_address)}@${trunk.host}:${trunk.port};transport=${trunk.transport.toLowerCase()}`;
    const from = `<sip:${userPart(channel.address)}@${trunk.host}>`;

    return new Promise((resolve, reject) => {
        let leg = null;
        srf.createUAC(target, {
            localSdp: sdpOffer,
            headers: { From: from },
            ...(credentials?.username ? { auth: { username: credentials.username, password: credentials.password } } : {}),
        }, {
            cbRequest: async (err, request) => {
                if (err) { reject(err); return; }
                const providerCallId = request.get('Call-ID');
                leg = { providerCallId, channel, direction: 'OUTBOUND', uacRequest: request, dialog: null, answeredAt: null };
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
            await sipDialogs.saveDialog(leg).catch((err) => log.warn({ providerCallId: leg.providerCallId, err }, 'Saving the SIP dialog failed'));
            dialog.on('destroy', () => finishLeg(leg, { providerStatus: 'COMPLETED' })
                .catch((err) => log.error({ providerCallId: leg.providerCallId, err }, 'Ending the call after BYE failed')));
            await channelIngress.outboundAnswered(channel, { providerCallId: leg.providerCallId, sdpAnswer: dialog.remote.sdp });
            await channelIngress.statusChanged(channel, { providerCallId: leg.providerCallId, status: 'ACCEPTED', at: leg.answeredAt });
        }).catch(async (err) => {
            if (!leg) { reject(err); return; }
            leg.uacRequest = null;
            if (leg.cancelled || leg.finished) return;   // we ended it ourselves
            const status = Number(err.status) || null;
            // A SIP final response is an outcome, not a fault: log the status; keep the stack for real errors.
            log.info({ providerCallId: leg.providerCallId, ...(status ? { sipStatus: status } : { err }) }, 'Outbound SIP call not answered');
            if (status && REJECTED_STATUSES.has(status)) {
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

    // Takes over the answered carrier leg of a call whose worker died
    // (core/calls/CallAdoption). A leg still ringing can't be: its pending
    // INVITE transaction died with that worker.
    async adopt(call) {
        if (!call.provider_call_id || sipDialogs.get(call.provider_call_id)) return;
        const saved = await sipDialogs.loadDialog(call.provider_call_id);
        if (!saved?.dialogId) {
            log.warn({ callId: call.id, providerCallId: call.provider_call_id }, 'No answered SIP dialog to take over');
            return;
        }
        const channel = await ChannelRepository.findById(call.channel_id);
        const leg = {
            providerCallId: call.provider_call_id, channel, direction: saved.direction,
            dialog: remoteDialog(saved.dialogId), answeredAt: saved.answeredAt ? new Date(saved.answeredAt) : null, adopted: true,
        };
        await sipDialogs.add(call.provider_call_id, leg);
        probeDialog(leg);
    },

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
        if (!drachtio.enabled) {
            log.info('DRACHTIO_HOST not set — SIP channel disabled on this worker');
            return;
        }
        await sipDialogs.start(onCommand);
        drachtio.onInvite((req, res) => handleInvite(req, res).catch((err) => {
            log.error({ providerCallId: req.get('Call-ID'), err }, 'Handling INVITE failed');
            try { res.send(500); } catch { /* already answered */ }
        }));
    },

    async stop() {
        // Answered legs are handed over: the worker that takes the call over
        // drives the dialog by its id. A leg still ringing can't move (its
        // pending transaction is this worker's), so it's ended.
        for (const leg of sipDialogs.all()) {
            if (leg.dialog) {
                if (leg.probe) clearInterval(leg.probe);
                sipDialogs.forget(leg.providerCallId);
                continue;
            }
            await endLeg(leg).catch(() => { });
        }
        await sipDialogs.stop();
        drachtio.onInvite(null);
    },
});
