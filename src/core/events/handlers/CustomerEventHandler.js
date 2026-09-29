// src/core/events/handlers/CustomerEventHandler.js
// Events from the customer leg's side — currently the provider's SDP answer to
// an outbound call we dialed, reported by its channel adapter through ChannelIngress.
import { sdpCoordinator } from '../../../media/webrtc/SDPCoordinator.js';
import { ConnectionType } from '../../constants/CallConstants.js';
import { customerChannels } from '../../channels/CustomerChannels.js';
import { logger } from '../../../infra/logging/logger.js';

const log = logger('core.events.CustomerEventHandler');

export class CustomerEventHandler {

    async handleCustomerAnswerReceived(data) {
        const { callId, sdpAnswer } = data;

        log.debug({ callId }, 'Processing customer SDP answer');

        try {
            const { channel } = await customerChannels.forCall(callId);
            await sdpCoordinator.processSDPAnswer(callId, sdpAnswer, ConnectionType.CUSTOMER, { sdpProfile: channel.sdp });
            log.info({ callId }, 'Customer leg connected');
        } catch (error) {
            log.error({ callId, err: error }, 'Failed to process customer answer');
            throw error;
        }
    }
}
