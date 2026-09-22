// services/call/events/handlers/WhatsAppEventHandler.js
import { sdpCoordinator } from '../../signaling/webrtc/SDPCoordinator.js';
import { ConnectionType } from '../../constants/CallConstants.js';

export class WhatsAppEventHandler {

    async handleWhatsAppAnswerReceived(data) {
        const { callId, sdpAnswer } = data;

        console.log(`[WhatsAppEventHandler] Processing WhatsApp SDP answer for call ${callId}`);

        try {
            await sdpCoordinator.processSDPAnswer(callId, sdpAnswer, ConnectionType.WHATSAPP);
            console.log(`[WhatsAppEventHandler] ✅ WhatsApp connection established for call ${callId}`);
        } catch (error) {
            console.error(`[WhatsAppEventHandler] Failed to process WhatsApp answer for call ${callId}:`, error.message);
            throw error;
        }
    }
}
