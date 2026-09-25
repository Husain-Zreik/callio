// Operator CLI: create a consumer (an integrating product) and print its
// credentials. The API key, signing secret and webhook secret are shown once.
//
//   node scripts/create-consumer.js --name "Acme CRM" --slug acme \
//        [--webhook-url https://acme.example/callio/events] [--lookup-url https://acme.example/callio/lookup]
import { createConsumer } from '../src/core/tenancy/ConsumerProvisioning.js';
import connection from '../config/dbConnection.js';

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : null;
}

const name = arg('name');
const slug = arg('slug');
if (!name || !slug) {
    console.error('Usage: node scripts/create-consumer.js --name <name> --slug <slug> [--webhook-url <url>] [--lookup-url <url>]');
    process.exit(1);
}

try {
    const created = await createConsumer({ name, slug, eventWebhookUrl: arg('webhook-url'), lookupUrl: arg('lookup-url') });
    console.log(JSON.stringify({
        consumer: { id: created.consumerId, slug: created.slug },
        api_key: created.apiKey,
        signing_key: created.signingKey,
        webhook_secret: created.webhookSecret,
        note: 'Store these now — Callio keeps only hashes/ciphertext and cannot show them again.',
    }, null, 2));
} catch (err) {
    console.error('Failed to create consumer:', err.message);
    process.exitCode = 1;
} finally {
    await connection.end();
}
