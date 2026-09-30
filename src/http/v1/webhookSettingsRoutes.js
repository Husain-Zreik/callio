// src/http/v1/webhookSettingsRoutes.js
// The calling consumer's own webhook settings (docs/management-api.md#webhook):
// where events and lookup requests go, which event types it receives, and
// the secret that signs them. The secret is returned only when it is created
// or rotated, so those responses opt out of Idempotency-Key replay.
import ConsumerRepository from '../../persistence/ConsumerRepository.js';
import { rotateWebhookSecret } from '../../core/tenancy/ConsumerProvisioning.js';
import { EVENT_TYPES, forgetSubscription } from '../../core/events/ConsumerEventPublisher.js';
import { badRequest } from '../errors.js';
import { config } from '../../../config/envConfig.js';

const view = (s) => ({ url: s.url, lookupUrl: s.lookupUrl, eventTypes: s.eventTypes, secretSet: s.hasSecret });

// A URL Callio will POST to: https (http only when WEBHOOK_ALLOW_HTTP), ≤500 chars.
function optionalUrl(body, field) {
    const value = body?.[field];
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || value.length > 500) throw badRequest(`${field} must be a URL of at most 500 characters`);
    let url;
    try { url = new URL(value); } catch { throw badRequest(`${field} must be a URL`); }
    const allowed = config.webhooks.allowHttp ? ['https:', 'http:'] : ['https:'];
    if (!allowed.includes(url.protocol)) throw badRequest(`${field} must be an https:// URL`);
    return url.toString();
}

function eventTypesOf(body) {
    const value = body?.event_types;
    if (value == null) return null;   // every type
    if (!Array.isArray(value) || !value.length) throw badRequest('event_types must be a non-empty array, or omitted for every type');
    const unknown = value.filter((t) => !EVENT_TYPES.includes(t));
    if (unknown.length) throw badRequest(`Unknown event_types: ${unknown.join(', ')} (known: ${EVENT_TYPES.join(', ')})`);
    return [...new Set(value)];
}

export default async function webhookSettingsRoutes(fastify) {
    const noReplay = { config: { idempotent: false } };

    fastify.get('/webhook', async (request) => ({
        webhook: view(await ConsumerRepository.getWebhookSettings(request.consumer.id)),
    }));

    // Replaces the settings (an omitted URL is removed; omitted event_types =
    // every type). The first time a URL is set, a secret is created and
    // returned in this response only.
    fastify.put('/webhook', noReplay, async (request) => {
        const body = request.body ?? {};
        const settings = { url: optionalUrl(body, 'url'), lookupUrl: optionalUrl(body, 'lookup_url'), eventTypes: eventTypesOf(body) };
        await ConsumerRepository.updateWebhookSettings(request.consumer.id, settings);
        forgetSubscription(request.consumer.id);
        const current = await ConsumerRepository.getWebhookSettings(request.consumer.id);
        if ((settings.url || settings.lookupUrl) && !current.hasSecret) {
            const secret = await rotateWebhookSecret(request.consumer.id);
            return { webhook: { ...view(current), secretSet: true }, secret };
        }
        return { webhook: view(current) };
    });

    // A new signing secret, effective at once (the old one stops working).
    fastify.post('/webhook/secret', noReplay, async (request) => {
        const secret = await rotateWebhookSecret(request.consumer.id);
        return { secret };
    });
}
