// src/channels/whatsapp/WhatsAppChannel.js
// WhatsApp Calling as a customer channel (the port is documented in
// core/channels/CustomerChannels.js). Outbound actions go through the Graph
// API client; inbound webhooks come in through webhookRoutes.js and are
// translated for core/channels/ChannelIngress.js by WhatsAppWebhookTranslator.
import { Channel, CustomerAddressType } from '../../core/constants/CallConstants.js';
import { acceptCall, rejectCall, terminateCall, initiateCall } from './WhatsAppCallApi.js';
import { whatsappSdpProfile } from './whatsappSdp.js';
import whatsappWebhookRoutes from './webhookRoutes.js';

export const whatsappChannel = Object.freeze({
    type: Channel.WHATSAPP,
    supportsOutbound: true,
    sdp: whatsappSdpProfile,

    accept: acceptCall,
    reject: rejectCall,
    terminate: terminateCall,
    initiate: initiateCall,

    // A customer is a phone number, or — for customers who call without
    // sharing one — Meta's business-scoped user id.
    normalizeCustomerAddress({ address, addressType }) {
        const type = addressType
            ?? (/^\+?\d{6,15}$/.test(String(address)) ? CustomerAddressType.E164 : CustomerAddressType.WHATSAPP_USER);
        if (type === CustomerAddressType.E164) {
            return { address: `+${String(address).replace(/[^\d]/g, '')}`, addressType: type };
        }
        if (type !== CustomerAddressType.WHATSAPP_USER) {
            throw new Error(`WhatsApp cannot reach a ${type} address`);
        }
        return { address: String(address), addressType: type };
    },

    validateChannelConfig(body) {
        if (!body.provider_account_id) return 'provider_account_id (Meta phone_number_id) is required for WHATSAPP channels';
        return null;
    },

    async registerRoutes(fastify) {
        await fastify.register(whatsappWebhookRoutes);
    },
});
