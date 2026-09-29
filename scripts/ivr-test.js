// A test IVR menu on one channel, for checking key presses (DTMF) on a real
// line. The caller hears two beeps; 1 = the channel's inbound queue (agents),
// 9 = hang up; no key = the beeps again.
//
//   npm run ivr:test -- --consumer midlr-dev --tenant 103 --channel sip-digitalk
//   npm run ivr:test -- --consumer midlr-dev --tenant 103 --channel sip-digitalk --off
//
// Watch it with: npm run logs -- --follow --component core.ivr,media.dtmf
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import ConsumerRepository from '../src/persistence/ConsumerRepository.js';
import TenantRepository from '../src/persistence/TenantRepository.js';
import ChannelRepository from '../src/persistence/ChannelRepository.js';
import IvrRepository from '../src/persistence/IvrRepository.js';
import connection from '../config/dbConnection.js';
import { config } from '../config/envConfig.js';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const FLOW_REF = 'ivr-test';
const PROMPT_REF = 'ivr-test-prompt';
const PROMPT_KEY = 'ivr-test/prompt.wav';

// Two 0.3 s beeps (800 Hz) with a short gap, then 0.5 s of silence; 16 kHz mono.
function promptWav() {
    const rate = 16000;
    const parts = [[800, 0.3], [0, 0.2], [800, 0.3], [0, 0.5]];
    const n = parts.reduce((sum, [, s]) => sum + Math.round(rate * s), 0);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    let i = 0;
    for (const [freq, seconds] of parts) {
        for (let k = 0; k < Math.round(rate * seconds); k++, i++) {
            buf.writeInt16LE(freq ? Math.round(Math.sin((2 * Math.PI * freq * k) / rate) * 8000) : 0, 44 + i * 2);
        }
    }
    return buf;
}

try {
    for (const required of ['consumer', 'tenant', 'channel']) if (!arg(required)) throw new Error(`--${required} is required`);
    const consumer = await ConsumerRepository.findBySlug(arg('consumer'));
    if (!consumer) throw new Error(`No consumer "${arg('consumer')}"`);
    const tenant = await TenantRepository.findByExternalRef(consumer.id, arg('tenant'));
    if (!tenant) throw new Error(`No tenant "${arg('tenant')}" for ${arg('consumer')}`);
    const channel = await ChannelRepository.findByExternalRef(tenant.id, arg('channel'));
    if (!channel) throw new Error(`No channel "${arg('channel')}" in tenant ${arg('tenant')}`);

    if (args.includes('--off')) {
        const existing = await IvrRepository.findFlowByExternalRef(tenant.id, FLOW_REF);
        if (!existing) { console.log('No test IVR to switch off.'); process.exit(0); }
        await connection.execute('UPDATE ivr_flows SET status = ? WHERE id = ?', ['INACTIVE', existing.id]);
        console.log(`Test IVR switched off — calls to ${channel.address} go straight to the queue again.`);
        process.exit(0);
    }

    const dir = join(config.storage.local.root, 'ivr-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(config.storage.local.root, PROMPT_KEY), promptWav());
    let asset = (await IvrRepository.listAudioAssets(tenant.id)).find((a) => a.external_ref === PROMPT_REF);
    asset ??= await IvrRepository.createAudioAsset(tenant.id, {
        external_ref: PROMPT_REF, name: 'IVR test prompt (two beeps)', storage_provider: 'local', storage_key: PROMPT_KEY, mime_type: 'audio/wav',
    });

    const flow = await IvrRepository.upsertFlow(tenant.id, FLOW_REF, {
        channel_id: channel.id, name: 'Test menu (DTMF check)', status: 'ACTIVE', trigger_condition: 'ALWAYS', trigger_priority: -100,
        structure: {
            nodes: [
                { id: 'start', type: 'ivr_start', data: {} },
                { id: 'menu', type: 'ivr_menu', data: { label: 'Test menu', audioFileId: asset.id, timeoutSeconds: 10, noInputAction: 'replay' } },
                { id: 'agents', type: 'ivr_transfer', data: { targetType: 'queue' } },
                { id: 'bye', type: 'ivr_hangup', data: {} },
            ],
            edges: [
                { source: 'start', target: 'menu' },
                { source: 'menu', target: 'agents', sourceHandle: '1' },
                { source: 'menu', target: 'bye', sourceHandle: '9' },
            ],
        },
    });
    console.log(`Test IVR on ${channel.external_ref} (${channel.address}), flow id ${flow.id}:`);
    console.log('  call in → two beeps → press 1 = agents (queue), 9 = hang up; no key = beeps again');
    console.log('Switch it off afterwards with the same command plus --off.');
    process.exit(0);
} catch (err) {
    console.error('ivr:test failed:', err.message);
    process.exit(1);
}
