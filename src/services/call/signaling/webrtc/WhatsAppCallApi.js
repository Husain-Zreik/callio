// services/call/signaling/webrtc/WhatsAppCallApi.js
// Pure WhatsApp Graph API adapter — no DB state updates.
// Fetches credentials internally; all business-logic DB writes belong in callers.
import https from 'https';
import CallRepository from '../../../../repositories/CallRepository.js';
import BusinessRepository from '../../../../repositories/BusinessRepository.js';
import { config } from '../../../../../config/envConfig.js';
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

// ── Outbound call ─────────────────────────────────────────────────────────────

export const initiateWhatsAppCall = async (callData, sdpOffer) => {
    try {
        const phoneNumberId = await BusinessRepository.getPhoneNumberId(callData.caller.id);
        if (!phoneNumberId) throw new Error('Invalid business number');

        const businessToken = await BusinessRepository.getBusinessToken(callData.businessId);
        if (!businessToken) throw new Error('Missing business token');

        const callee = callData.callee;
        if (!callee.number && !callee.bsuid) {
            throw new Error('Callee has neither phone number nor bsuid');
        }
        const payload = {
            messaging_product: 'whatsapp',
            action: 'connect',
            session: { sdp_type: 'offer', sdp: sdpOffer },
        };
        if (callee.number) payload.to = callee.number;
        if (callee.bsuid) payload.recipient = callee.bsuid;

        console.log(`[WhatsApp] Initiating call to=${payload.to ?? 'none'} recipient=${payload.recipient ?? 'none'}`);

        const response = await metaAxios.post(
            `${graphUrl()}/${phoneNumberId}/calls`,
            payload,
            { headers: { Authorization: `Bearer ${businessToken}`, 'Content-Type': 'application/json' } }
        );

        console.log('[WhatsApp] ✅ API Response:', JSON.stringify(response.data, null, 2));

        const wacid = response.data.calls?.[0]?.id;
        if (!wacid) throw new Error('Missing wacid in WhatsApp response');

        return wacid;
    } catch (error) {
        throw formatApiError(error, 'Initiate call');
    }
};

// ── Accept inbound call ───────────────────────────────────────────────────────

export const acceptWhatsAppCall = async (callId, sdpAnswer) => {
    const call = await CallRepository.findById(callId);
    if (!call) throw new Error('Call not found');

    const phoneNumberId = await BusinessRepository.getPhoneNumberId(call.business_number_id);
    const businessToken = await BusinessRepository.getBusinessToken(call.business_id);

    const response = await _metaPost(
        `${graphUrl()}/${phoneNumberId}/calls`,
        {
            messaging_product: 'whatsapp',
            call_id: call.wacid,
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
        const call = await CallRepository.findById(callId);
        if (!call || !call.wacid) throw new Error('Call not found or missing wacid');

        const phoneNumberId = await BusinessRepository.getPhoneNumberId(call.business_number_id);
        const businessToken = await BusinessRepository.getBusinessToken(call.business_id);

        await metaAxios.post(
            `${graphUrl()}/${phoneNumberId}/calls`,
            { messaging_product: 'whatsapp', call_id: call.wacid, action: 'terminate' },
            { headers: { Authorization: `Bearer ${businessToken}`, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        throw formatApiError(error, 'Reject call');
    }
};

// ── Terminate call ────────────────────────────────────────────────────────────

export const terminateWhatsAppCall = async (callId) => {
    console.log('[WhatsApp] Terminating call:', callId);
    const call = await CallRepository.findById(callId);
    if (!call || !call.wacid) throw new Error('Call not found or missing wacid');

    const phoneNumberId = await BusinessRepository.getPhoneNumberId(call.business_number_id);
    const businessToken = await BusinessRepository.getBusinessToken(call.business_id);

    await _metaPost(
        `${graphUrl()}/${phoneNumberId}/calls`,
        {
            messaging_product: 'whatsapp',
            call_id: call.wacid,
            action: 'terminate',
        },
        { headers: { Authorization: `Bearer ${businessToken}`, 'Content-Type': 'application/json' }, timeout: 12000 },
        `Terminate call ${callId}`,
    );
    console.log('[WhatsApp] ✅ WhatsApp call terminated');
};
