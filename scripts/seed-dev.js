// Development seed: one consumer ("dev"), one tenant ("demo") with two agents
// and a supervisor, a ROUND_ROBIN queue, and a WhatsApp and/or SIP channel.
// Idempotent on the tenant data; the consumer is created once. Prints the
// consumer's credentials when it creates them.
//
//   node scripts/seed-dev.js [--phone-number-id <meta id>] [--whatsapp-token <token>]
//                            [--whatsapp-number +9617...] [--sip-did +9611...]
//                            [--sip-trunk-host <host>] [--sip-trunk-port 5060]
//                            [--webhook-url <url>] [--lookup-url <url>]
import { createConsumer } from '../src/core/tenancy/ConsumerProvisioning.js';
import ConsumerRepository from '../src/persistence/ConsumerRepository.js';
import TenantRepository from '../src/persistence/TenantRepository.js';
import AgentRepository from '../src/persistence/AgentRepository.js';
import QueueRepository from '../src/persistence/QueueRepository.js';
import ChannelRepository from '../src/persistence/ChannelRepository.js';
import SipTrunkRepository from '../src/persistence/SipTrunkRepository.js';
import connection from '../config/dbConnection.js';

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
}

try {
    let consumer = await ConsumerRepository.findBySlug('dev');
    let credentials = null;
    if (!consumer) {
        credentials = await createConsumer({
            name: 'Development',
            slug: 'dev',
            eventWebhookUrl: arg('webhook-url'),
            lookupUrl: arg('lookup-url'),
        });
        consumer = await ConsumerRepository.findBySlug('dev');
    }

    const tenant = await TenantRepository.upsert(consumer.id, 'demo', {
        name: 'Demo tenant',
        settings: { auto_offline: { enabled: false, missed_threshold: 3 } },
    });
    const agents = [];
    for (const [ref, name, role] of [['agent-1', 'Agent One', 'AGENT'], ['agent-2', 'Agent Two', 'AGENT'], ['sup-1', 'Supervisor', 'SUPERVISOR']]) {
        agents.push(await AgentRepository.upsert(tenant.id, ref, { name, role }));
    }
    const queue = await QueueRepository.upsert(tenant.id, 'main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await QueueRepository.replaceMembers(queue.id, agents.filter((a) => a.role === 'AGENT').map((a) => ({ agentId: a.id, priority: 1 })));

    const channels = [];
    const phoneNumberId = arg('phone-number-id');
    if (phoneNumberId) {
        channels.push(await ChannelRepository.upsert(tenant.id, 'whatsapp-main', {
            type: 'WHATSAPP',
            display_name: 'WhatsApp line',
            address: arg('whatsapp-number', '+10000000000'),
            provider_account_id: phoneNumberId,
            credentials: arg('whatsapp-token') ? { access_token: arg('whatsapp-token') } : undefined,
            inbound_queue_id: queue.id,
            recording_enabled: false,
        }));
    }
    const did = arg('sip-did');
    if (did) {
        // A platform trunk; any source may send INVITEs (development).
        const trunk = await SipTrunkRepository.upsert({
            name: 'dev-trunk',
            host: arg('sip-trunk-host', '127.0.0.1'),
            port: Number(arg('sip-trunk-port', 5060)),
        });
        channels.push(await ChannelRepository.upsert(tenant.id, 'sip-main', {
            type: 'SIP', display_name: 'SIP line', address: did, sip_trunk_id: trunk.id, inbound_queue_id: queue.id,
        }));
    }

    console.log(JSON.stringify({
        consumer: { id: consumer.id, slug: consumer.slug },
        ...(credentials ? {
            api_key: credentials.apiKey,
            signing_key: credentials.signingKey,
            webhook_secret: credentials.webhookSecret,
        } : { note: 'Consumer "dev" already existed — credentials were issued when it was created.' }),
        tenant: { id: tenant.id, ref: tenant.external_ref },
        agents: agents.map((a) => ({ id: a.id, ref: a.external_ref, role: a.role })),
        queue: { id: queue.id, ref: queue.external_ref, strategy: queue.strategy },
        channels: channels.map((c) => ({ id: c.id, ref: c.external_ref, type: c.type, address: c.address })),
    }, null, 2));
} catch (err) {
    console.error('Seed failed:', err);
    process.exitCode = 1;
} finally {
    await connection.end();
}
