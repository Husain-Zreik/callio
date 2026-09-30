// src/http/v1/pushCredentialRoutes.js
// The calling consumer's push credentials (docs/management-api.md, Push
// credentials): the Firebase project, Apple key and OneSignal app its agents'
// apps are pushed with. Stored encrypted; reads never return a key.
import ConsumerRepository from '../../persistence/ConsumerRepository.js';
import { pushCredentials, PushProviders } from '../../push/PushCredentials.js';
import { badRequest, notFound } from '../errors.js';

const view = (stored) => Object.fromEntries(PushProviders.map((p) => [p, pushCredentials.describe(p, stored?.[p])]));

function provider(request) {
    const p = String(request.params.provider ?? '').toLowerCase();
    if (!PushProviders.includes(p)) throw notFound('Push provider');
    return p;
}

export default async function pushCredentialRoutes(fastify) {
    fastify.get('/push-credentials', async (request) => ({
        pushCredentials: view(await ConsumerRepository.getPushCredentials(request.consumer.id)),
    }));

    fastify.put('/push-credentials/:provider', async (request) => {
        const p = provider(request);
        let section;
        try {
            section = pushCredentials.validate(p, request.body ?? {});
        } catch (err) {
            throw badRequest(err.message);
        }
        await ConsumerRepository.setPushCredentials(request.consumer.id, p, section);
        pushCredentials.invalidate(request.consumer.id);
        return { [p]: pushCredentials.describe(p, section) };
    });

    fastify.delete('/push-credentials/:provider', async (request, reply) => {
        const p = provider(request);
        await ConsumerRepository.setPushCredentials(request.consumer.id, p, null);
        pushCredentials.invalidate(request.consumer.id);
        return reply.code(204).send();
    });
}
