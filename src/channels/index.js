// src/channels/index.js
// Registers every customer-channel adapter with the core (see
// core/channels/CustomerChannels.js). Adding a channel = a folder under
// src/channels/ plus one line here.
import { customerChannels } from '../core/channels/CustomerChannels.js';
import { whatsappChannel } from './whatsapp/WhatsAppChannel.js';
import { sipChannel } from './sip/SipChannel.js';

export function registerChannels() {
    customerChannels.register(whatsappChannel);
    customerChannels.register(sipChannel);
}
