// src/core/channels/CustomerChannels.js
// The customer-channel port. A channel is how a customer's call reaches Callio
// (WhatsApp Calling, SIP); the core never talks to a provider directly — it
// looks up the adapter for a call's `channel` here and calls the port.
//
// Adapters live in src/channels/<name>/ and are registered at startup
// (src/channels/index.js). Inbound provider events go the other way: an
// adapter translates its provider's payloads and reports them to
// core/channels/ChannelIngress.js.
//
// A CustomerChannel adapter:
//   type               'WHATSAPP' | 'SIP' — matches channels.type / calls.channel
//   supportsOutbound   whether initiate() is implemented
//   sdp                { transport, localOffer(sdp), remoteOffer(sdp), remoteAnswer(sdp) }
//                      how the customer leg is carried — transport 'webrtc'
//                      (ICE + DTLS-SRTP) or 'rtp' (plain RTP) — and rewrites for
//                      its SDP (provider quirks); each hook returns the SDP to
//                      use. Missing hooks = unchanged.
//   accept(call, sdpAnswer)      answer a ringing inbound call with our SDP
//   reject(call)                 decline a ringing inbound call
//   terminate(call)              end the call at the provider (any state)
//   initiate(call, sdpOffer)     dial the customer for an outbound call row;
//                                returns the provider's call id
//   normalizeCustomerAddress({ address, addressType })
//                                → { address, addressType } for outbound intents
//   validateChannelConfig(body)  → error message or null, for channel provisioning
//   registerRoutes(fastify)      optional HTTP ingress (webhooks)
//   adopt(call)                  optional: take over the provider side of a call
//                                whose worker died (core/calls/CallAdoption), for a
//                                channel whose legs live in a worker's memory (SIP)
//   start() / stop()             optional: connect to the provider at startup
//                                (e.g. SIP's drachtio connection), disconnect at shutdown
// `call` is a calls row. Adapters read their credentials from the call's channel.
import CallRepository from '../../persistence/CallRepository.js';

class CustomerChannels {
    constructor() {
        this._adapters = new Map();
    }

    register(adapter) {
        if (!adapter?.type) throw new Error('CustomerChannel adapter needs a type');
        this._adapters.set(adapter.type, adapter);
    }

    types() {
        return [...this._adapters.keys()];
    }

    all() {
        return [...this._adapters.values()];
    }

    get(type) {
        const adapter = this._adapters.get(type);
        if (!adapter) throw new Error(`No customer channel registered for ${type}`);
        return adapter;
    }

    has(type) {
        return this._adapters.has(type);
    }

    // The call row and its channel's adapter.
    async forCall(callOrId) {
        const call = typeof callOrId === 'object' && callOrId !== null
            ? callOrId
            : await CallRepository.findById(callOrId);
        if (!call) throw new Error(`Call ${callOrId} not found`);
        return { call, channel: this.get(call.channel) };
    }

    // ── Shortcuts for the common one-step actions ─────────────────────────────

    async accept(callOrId, sdpAnswer) {
        const { call, channel } = await this.forCall(callOrId);
        return channel.accept(call, sdpAnswer);
    }

    async reject(callOrId) {
        const { call, channel } = await this.forCall(callOrId);
        return channel.reject(call);
    }

    async terminate(callOrId) {
        const { call, channel } = await this.forCall(callOrId);
        return channel.terminate(call);
    }
}

export const customerChannels = new CustomerChannels();
