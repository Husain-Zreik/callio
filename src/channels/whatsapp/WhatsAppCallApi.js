// src/channels/whatsapp/WhatsAppCallApi.js
// Pure WhatsApp Graph API adapter — no DB state updates.
// Credentials come from the call's channel (channels.provider_account_id is
// Meta's phone_number_id, channels.credentials holds the access token); all
// call-state DB writes belong in callers.
import https from 'https';
import CallRepository from '../../persistence/CallRepository.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import { config } from '../../../config/envConfig.js';
import axios from 'axios';

const _WHATSAPP_API_URL = config.whatsapp.apiUrl;

function graphUrl(version) {
    if (version) return `https://graph.facebook.com/${version}/`;
    if (_WHATSAPP_API_URL) return _WHATSAPP_API_URL;
    return 'https://graph.facebook.com/v22.0/';
}

// Shared HTTPS agent so all Meta API calls reuse TCP connections.
// Eliminates per-call TLS handshake overhead across accept/terminate/reject/initiate.
const _metaAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const metaAxios = axios.create({ httpsAgent: _metaAgent });

const formatApiError = (error, context = '') => {
    const apiError = {
        status: error.response?.status || null,
        statusText: error.response?.statusText || null,
        data: error.response?.data?.error || null,
        message: error.response?.data?.error?.message || error.message,
    };
    console.error(`[WhatsApp] ❌ ${context} failed:`, apiError);
    return new Error(`${context} failed: ${apiError.message}`);
};

const _RETRYABLE = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']);

// Retry once on fast connection errors before any response arrives.
// HTTP errors with a response body are not retried — Meta's error already describes the outcome.
// The 12 s timeout on the caller's config ensures we don't hold the slot for a full retry cycle.
async function _metaPost(url, payload, axiosConfig, label) {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return await metaAxios.post(url, payload, axiosConfig);
        } catch (err) {
            lastErr = err;
            if (attempt === 1 && !err.response && _RETRYABLE.has(err.code)) {
                console.warn(`[WhatsApp] ${label} ${err.code} — retrying (attempt 2)`);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            break;
        }
    }
    throw formatApiError(lastErr, label);
}

// Meta's phone_number_id and access token for a channel.
async function channelAuth(channelId) {
    const channel = await ChannelRepository.findById(channelId);
    if (!channel || channel.type !== 'WHATSAPP') throw new Error(`Channel ${channelId} is not a WhatsApp channel`);
    if (!channel.provider_account_id) throw new Error(`Channel ${channelId} has no phone_number_id`);
    const credentials = await ChannelRepository.getCredentials(channelId);
    if (!credentials?.access_token) throw new Error(`Channel ${channelId} has no access token`);
    return { phoneNumberId: channel.provider_account_id, token: credentials.access_token };
}

async function callAuth(callId) {
    const call = await CallRepository.findById(callId);
    if (!call) throw new Error('Call not found');
    return { call, ...(await channelAuth(call.channel_id)) };
}

// ── Outbound call ─────────────────────────────────────────────────────────────

// callData: { channelId, customer: { address, addressType } }
export const initiateWhatsAppCall = async (callData, sdpOffer) => {
    try {
        const { phoneNumberId, token: businessToken } = await channelAuth(callData.channelId);

        const { address, addressType } = callData.customer ?? {};
        if (!address) throw new Error('Customer has no address');
        const payload = {
            messaging_product: 'whatsapp',
            action: 'connect',
            session: { sdp_type: 'offer', sdp: sdpOffer },
        };
        // Phone numbers go as digits; customers without one are addressed by
        // their business-scoped user id.
        if (addressType === 'WHATSAPP_USER') payload.recipient = address;
        else payload.to = String(address).replace(/[^d]/g, '');

        console.log(`[WhatsApp] Initiating call to=${payload.to ?? 'none'} recipient=${payload.recipient ?? 'none'}`);

        const response = await metaAxios.post(
            `${graphUrl()}/${phoneNumberId}/calls`,
            payload,
            { headers: { Authorization: `Bearer ${businessToken}`, 'Content-Type': 'application/json' } }
        );

        console.log('[WhatsApp] ✅ API Response:', JSON.stringify(response.data, null, 2));

        const providerCallId = response.data.calls?.[0]?.id;
        if (!providerCallId) throw new Error('Missing providerCallId in WhatsApp response');

        return providerCallId;
    } catch (error) {
        throw formatApiError(error, 'Initiate call');
    }
};

// ── Accept inbound call ───────────────────────────────────────────────────────

export const acceptWhatsAppCall = async (callId, sdpAnswer) => {
    const { call, phoneNumberId, token: businessToken } = await callAuth(callId);

    const response = await _metaPost(
        `${graphUrl()}/${phoneNumberId}/calls`,
        {
            messaging_product: 'whatsapp',
            call_id: call.provider_call_id,
            action: 'accept',
            session: { sdp_type: 'answer', sdp: sdpAnswer },
        },
        { headers: { Authorization: `Bearer ${businessToken}`, 'Content-Type': 'application/json' }, timeout: 12000 },
        `Accept call ${callId}`,
    );
    return response.data;
};

// ── Reject call ───────────────────────────────────────────────────────────────

export const rejectWhatsAppCall = async (callId) => {
    try {
        const { call, phoneNumberId, token: businessToken } = await callAuth(callId);
        if (!call.provider_call_id) throw new Error('Call has no provider call id');

        await metaAxios.post(
            `${graphUrl()}/${phoneNumberId}/calls`,
            { messaging_product: 'whatsapp', call_id: call.provider_call_id, action: 'terminate' },
            { headers: { Authorization: `Bearer ${businessToken}`, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        throw formatApiError(error, 'Reject call');
    }
};

// ── Terminate call ────────────────────────────────────────────────────────────

export const terminateWhatsAppCall = async (callId) => {
    console.log('[WhatsApp] Terminating call:', callId);
    const { call, phoneNumberId, token: businessToken } = await callAuth(callId);
    if (!call.provider_call_id) throw new Error('Call has no provider call id');

    await _metaPost(
        `${graphUrl()}/${phoneNumberId}/calls`,
        {
            messaging_product: 'whatsapp',
            call_id: call.provider_call_id,
            action: 'terminate',
        },
        { headers: { Authorization: `Bearer ${businessToken}`, 'Content-Type': 'application/json' }, timeout: 12000 },
        `Terminate call ${callId}`,
    );
    console.log('[WhatsApp] ✅ WhatsApp call terminated');
};
