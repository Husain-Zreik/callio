// src/core/events/handlers/CustomerEventHandler.js
// Events from the customer leg's side — currently the provider's SDP answer to
// an outbound call we dialed, reported by its channel adapter through ChannelIngress.
import { sdpCoordinator } from '../../../media/webrtc/SDPCoordinator.js';
import { ConnectionType } from '../../constants/CallConstants.js';
import { customerChannels } from '../../channels/CustomerChannels.js';

export class CustomerEventHandler {

    async handleCustomerAnswerReceived(data) {
        const { callId, sdpAnswer } = data;

        console.log(`[CustomerEventHandler] Processing customer SDP answer for call ${callId}`);

        try {
            const { channel } = await customerChannels.forCall(callId);
            await sdpCoordinator.processSDPAnswer(callId, sdpAnswer, ConnectionType.CUSTOMER, { sdpProfile: channel.sdp });
            console.log(`[CustomerEventHandler] ✅ Customer leg connected for call ${callId}`);
        } catch (error) {
            console.error(`[CustomerEventHandler] Failed to process customer answer for call ${callId}:`, error.message);
            throw error;
        }
    }
}
