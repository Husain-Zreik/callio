// src/core/events/handlers/CustomerEventHandler.js
// Events from the customer leg's side — currently the provider's SDP answer to
// an outbound call we dialed, reported by its channel adapter through ChannelIngress.
import { callMedia } from '../../media/CallMedia.js';
import { mediaLegs } from '../../media/MediaLegs.js';
import { customerChannels } from '../../channels/CustomerChannels.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.CustomerEventHandler');

export class CustomerEventHandler {

    async handleCustomerAnswerReceived(data) {
        const { callId, sdpAnswer } = data;

        log.debug({ callId }, 'Processing customer SDP answer');

        try {
            const { call, channel } = await customerChannels.forCall(callId);
            await mediaLegs.customerAnswered(call, sdpAnswer, channel.sdp);
            // The agent is already up (outbound starts with them): into the room.
            await callMedia.bridge(call);
            log.info({ callId }, 'Customer leg connected');
        } catch (error) {
            log.error({ callId, err: error }, 'Failed to process customer answer');
            throw error;
        }
    }
}
