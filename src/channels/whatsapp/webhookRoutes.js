// src/channels/whatsapp/webhookRoutes.js
// WhatsApp Calling ingress (PLATFORM_ARCHITECTURE.md §3D).
//   GET  /webhooks/whatsapp          Meta's subscription verification
//   POST /webhooks/whatsapp          Meta posts directly; X-Hub-Signature-256 verified
//   POST /v1/webhooks/whatsapp/forward  a consumer forwards Meta's payload
//                                     (API key; only its own lines accepted)
// Both POSTs accept Meta's envelope { entry: [{ changes: [{ value }] }] }; the
// forward endpoint also accepts a bare { value }.
import { createHmac, timingSafeEqual } from 'crypto';
import { whatsappWebhookTranslator } from './WhatsAppWebhookTranslator.js';
import { isShuttingDown } from '../../server/shutdown.js';
import { config } from '../../../config/envConfig.js';
import { apiKeyAuth } from '../../http/auth/apiKeyAuth.js';
import { sendError } from '../../http/errors.js';

// Call-related change values in a payload (calls and call statuses).
function callValues(body) {
    if (body?.value) return [body.value];
    const values = [];
    for (const entry of body?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
            const value = change?.value;
            const hasCalls = Array.isArray(value?.calls) && value.calls.length > 0;
            const hasCallStatuses = Array.isArray(value?.statuses) && value.statuses.some((s) => s?.type === 'call');
            if (hasCalls || hasCallStatuses) values.push(value);
        }
    }
    return values;
}

function validMetaSignature(rawBody, header) {
    const secret = config.whatsapp.appSecret;
    if (!secret || !header?.startsWith('sha256=')) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
    const provided = Buffer.from(header.slice('sha256='.length));
    return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// Acknowledge fast, process after — the provider retries on anything but 2xx,
// and processing can take longer than its timeout. During shutdown a 503 makes
// it redeliver to a worker that will see the call through.
async function ackAndProcess(reply, values, options) {
    if (isShuttingDown) return reply.code(503).send();
    reply.code(200).send({ received: values.length });
    for (const value of values) {
        console.log(`[WhatsApp:webhook] phone_number_id=${value?.metadata?.phone_number_id ?? 'UNKNOWN'} calls=${value?.calls?.length ?? 0} statuses=${value?.statuses?.length ?? 0}`);
        await whatsappWebhookTranslator.process(value, options).catch((err) =>
            console.error('[WhatsApp:webhook] Processing failed:', err)
        );
    }
}

export default async function whatsappWebhookRoutes(fastify) {
    // Keep the raw body for signature verification.
    fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
        request.rawBody = body;
        try {
            done(null, body.length ? JSON.parse(body) : {});
        } catch (err) {
            err.statusCode = 400;
            done(err);
        }
    });

    fastify.get('/webhooks/whatsapp', async (request, reply) => {
        const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query ?? {};
        if (mode === 'subscribe' && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
            return reply.type('text/plain').send(challenge ?? '');
        }
        return reply.code(403).send();
    });

    fastify.post('/webhooks/whatsapp', async (request, reply) => {
        if (!config.whatsapp.appSecret) {
            return sendError(reply, 404, 'not_enabled', 'Direct Meta ingress is not configured');
        }
        if (!validMetaSignature(request.rawBody ?? '', request.headers['x-hub-signature-256'])) {
            console.warn('[WhatsApp:webhook] Rejected Meta webhook with an invalid signature');
            return reply.code(401).send();
        }
        return ackAndProcess(reply, callValues(request.body), {});
    });

    fastify.post('/v1/webhooks/whatsapp/forward', { preHandler: apiKeyAuth }, async (request, reply) => {
        return ackAndProcess(reply, callValues(request.body), { consumerId: request.consumer.id });
    });
}
