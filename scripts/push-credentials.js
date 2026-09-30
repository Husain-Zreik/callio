// Sets a consumer's push credentials (operator-side; consumers can do the same
// with PUT /v1/push-credentials/{provider}). Pushes to that consumer's agents
// then go out with these instead of the platform credentials from env.
// Workers pick a change up within a minute.
//
//   npm run push:credentials -- --consumer midlr-dev --show
//   npm run push:credentials -- --consumer midlr-dev --fcm /path/to/firebase-service-account.json
//   npm run push:credentials -- --consumer midlr-dev --apns /path/to/AuthKey_ABC123.p8 --key-id ABC123 \
//                               --team-id TEAM123 --bundle-id com.example.app [--production]
//   npm run push:credentials -- --consumer midlr-dev --onesignal-app-id <id> --onesignal-key <rest api key>
//   npm run push:credentials -- --consumer midlr-dev --remove fcm|apns|onesignal
import { readFileSync } from 'fs';
import ConsumerRepository from '../src/persistence/ConsumerRepository.js';
import { pushCredentials, PushProviders } from '../src/push/PushCredentials.js';
import connection from '../config/dbConnection.js';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(`--${name}`);

const show = (stored) => {
    for (const p of PushProviders) {
        const d = pushCredentials.describe(p, stored?.[p]);
        process.stdout.write(`${p.padEnd(10)} ${d ? JSON.stringify(d) : '(not set — platform credentials from env)'}\n`);
    }
};

try {
    const slug = arg('consumer');
    if (!slug) throw new Error('--consumer is required');
    const consumer = await ConsumerRepository.findBySlug(slug);
    if (!consumer) throw new Error(`No consumer "${slug}"`);

    let provider = null;
    let section;
    if (arg('fcm')) {
        provider = 'fcm';
        section = pushCredentials.validate('fcm', { service_account: JSON.parse(readFileSync(arg('fcm'), 'utf8')) });
    } else if (arg('apns')) {
        provider = 'apns';
        section = pushCredentials.validate('apns', {
            key_p8: readFileSync(arg('apns'), 'utf8'), key_id: arg('key-id'), team_id: arg('team-id'),
            bundle_id: arg('bundle-id'), production: has('production'),
        });
    } else if (arg('onesignal-app-id')) {
        provider = 'onesignal';
        section = pushCredentials.validate('onesignal', { app_id: arg('onesignal-app-id'), rest_api_key: arg('onesignal-key') });
    } else if (arg('remove')) {
        provider = arg('remove');
        if (!PushProviders.includes(provider)) throw new Error(`--remove takes one of ${PushProviders.join(', ')}`);
        section = null;
    } else if (!has('show')) {
        throw new Error('nothing to do: --show, --fcm, --apns, --onesignal-app-id or --remove');
    }

    const stored = provider
        ? await ConsumerRepository.setPushCredentials(consumer.id, provider, section)
        : await ConsumerRepository.getPushCredentials(consumer.id);
    if (provider) process.stdout.write(`${section ? 'Set' : 'Removed'} ${provider} for ${slug}.\n`);
    show(stored);
} catch (err) {
    process.stderr.write(`push:credentials failed: ${err.message}\n`);
    process.exitCode = 1;
} finally {
    await connection.end();
}
