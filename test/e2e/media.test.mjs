// Media features the media-plane migration must keep (docs/media-architecture.md,
// Feature parity), heard or read back for real: the stereo recording's content,
// the customer-quality events, the reconnect tone when the agent drops (and the
// call coming back on reconnect), and queue hold music after an IVR transfer.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import {
    testDb, sleep, makeChecks, waitFor, newPeer, listen, hear, gathered, fakeMeta,
    connectAgent, accept, nextIncoming, api as makeApi, wav, oggOpusPackets, toneEnergy,
} from './lib.mjs';

const require = createRequire(import.meta.url);
const { OpusEncoder } = require('@discordjs/opus');

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 3901);
const CALLIO = `http://127.0.0.1:${PORT}`;
const STORAGE = process.env.STORAGE_LOCAL_ROOT;
const { check, summary } = makeChecks();
const api = makeApi(CALLIO, seed.api_key);
const meta = fakeMeta({ callioUrl: CALLIO, apiKey: seed.api_key, phoneNumberId: '111222333' });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const callByProvider = (pid) => waitFor(async () => (await q('SELECT * FROM calls WHERE provider_call_id = ?', [pid]))[0], 5000, `call ${pid}`);
const availability = async (ref) => (await q('SELECT availability FROM agents WHERE external_ref = ?', [ref]))[0]?.availability;
const setAvailable = async (agent) => {
    agent.socket.emit('agent:availability:set', { availability: 'AVAILABLE' });
    await waitFor(async () => (await availability(agent.ref)) === 'AVAILABLE', 8000, `${agent.ref} available`);
};
const endByAgent = async (agent, callId) => {
    agent.socket.emit('call:terminate', { callId });
    await waitFor(async () => (await callRow(callId)).status === 'TERMINATED', 10000, `call ${callId} ended`);
    agent.peer?.close(); agent.peer = null;
};
const whatsapp = seed.channels.find((c) => c.type === 'WHATSAPP');
const channel = (recording) => api('PUT', `/v1/tenants/demo/channels/${whatsapp.ref}`, {
    type: 'WHATSAPP', display_name: 'WhatsApp line', address: whatsapp.address, provider_account_id: '111222333',
    inbound_queue_ref: seed.queue.ref, recording_enabled: recording,
});
const RECONNECT_TONE = [600, 750, 900];   // PlaceholderTrackFactory's reconnecting tone
const HOLD = 520;

await meta.listen();
let exitCode = 0;

try {
    await api('PUT', `/v1/tenants/demo/queues/${seed.queue.ref}`, { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', `/v1/tenants/demo/queues/${seed.queue.ref}/members`, { members: [{ agent_ref: 'agent-1' }] });
    let a1 = await connectAgent(CALLIO, seed, 'agent-1');
    await setAvailable(a1);

    // ── 1. A recorded call: quality events, then the recording's content ──
    const rec = await channel(true);
    check('recording is switched on for the line', rec.status === 200 && rec.body.channel?.recordingEnabled === true, `HTTP ${rec.status}`);
    const c1 = await meta.callIn('wacid.m.1');
    const row1 = await callByProvider(c1.id);
    await accept(a1, await nextIncoming(a1, row1.id), 880);
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 15000, 'call 1 answered');
    const heard1 = await hear(await c1.customer.received);
    check('the recorded call is bridged', heard1.dominant() === 880, `tone=${heard1.dominant()}`);
    await sleep(4000);   // ~6 s of talk in the file, and a couple of quality polls (every 4 s)

    const quality = a1.events.filter((e) => e.event === 'call:network:quality:customer' && String(e.payload.callId) === String(row1.id)).map((e) => e.payload);
    const q1 = quality.at(-1);
    check('the agent gets customer-quality events with bars, a label and a score',
        quality.length >= 1 && q1.bars >= 1 && q1.bars <= 4 && typeof q1.label === 'string' && q1.score >= 0 && q1.score <= 100,
        JSON.stringify(q1 ?? null));
    check('a clean local line reports good quality (3 or 4 bars)', q1?.bars >= 3, JSON.stringify(q1 ?? null));

    await endByAgent(a1, row1.id);
    const recording = await waitFor(async () => {
        const r = await api('GET', `/v1/calls/${row1.id}/recording`);
        return r.status === 200 ? r.body : null;
    }, 30000, 'recording completed').catch(() => null);
    check('the recording is saved and the API gives a download URL', Boolean(recording?.url), JSON.stringify(recording ?? null));
    if (recording?.url) {
        const file = Buffer.from(await (await fetch(recording.url)).arrayBuffer());
        const decoder = new OpusEncoder(48000, 2);
        const packets = oggOpusPackets(file);
        const pcm = Buffer.concat(packets.map((p) => decoder.decode(p)));
        const seconds = pcm.length / (48000 * 2 * 2);
        check('the recording is Ogg Opus stereo of about the call length',
            recording.format === 'ogg' && file.toString('ascii', 0, 4) === 'OggS' && seconds >= 4 && seconds <= 30,
            `format=${recording.format} packets=${packets.length} seconds=${seconds.toFixed(1)}`);
        const map = Object.fromEntries(String(recording.channelMap || 'left=customer,right=agent').split(',').map((kv) => kv.split('=').reverse()));
        const side = (who) => toneEnergy(pcm, { channels: 2, channel: map[who] === 'right' ? 1 : 0, rate: 48000, freqs: [440, 880] });
        const cust = side('customer');
        const agent = side('agent');
        check('the customer channel holds the customer (440 Hz), the agent channel the agent (880 Hz)',
            cust[440] > 10 * cust[880] && agent[880] > 10 * agent[440],
            `map=${recording.channelMap} customer 440/880=${(cust[440] / (cust[880] || 1)).toFixed(1)} agent 880/440=${(agent[880] / (agent[440] || 1)).toFixed(1)}`);
    }
    await channel(false);
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 8000, 'agent-1 released');

    // ── 2. The agent drops: the customer hears the reconnect tone, then the agent again ──
    const c2 = await meta.callIn('wacid.m.2');
    const row2 = await callByProvider(c2.id);
    // The listeners measure 10 ms windows, so tones closer than ~100 Hz blur
    // together: the agent sends 300 Hz here, well away from the tone's 600�900.
    await accept(a1, await nextIncoming(a1, row2.id), 300);
    await waitFor(async () => (await callRow(row2.id)).status === 'IN_PROGRESS', 15000, 'call 2 answered');
    const cust2 = await c2.customer.received;
    const toneEar = listen(cust2.track, [300, ...RECONNECT_TONE]);
    await hear(toneEar);
    check('the call is bridged before the drop', toneEar.dominant() === 300, `tone=${toneEar.dominant()}`);

    a1.peer.close(); a1.peer = null;
    a1.socket.disconnect();
    await hear(toneEar, 3000, 1500);
    const toneBins = toneEar.stats.bins;
    const toneTotal = RECONNECT_TONE.reduce((sum, f) => sum + toneBins[f], 0);
    check('after the agent drops the customer hears the reconnect tone, not the agent',
        toneTotal > 10 * toneBins[300] && RECONNECT_TONE.every((f) => toneBins[f] > 0) && toneEar.rms() > 0,
        `600/750/900 vs 300 = ${(toneTotal / (toneBins[300] || 1)).toFixed(1)} rms=${toneEar.rms()}`);
    check('the call stays up while the agent is away', (await callRow(row2.id)).status === 'IN_PROGRESS');
    toneEar.stop();

    a1 = await connectAgent(CALLIO, seed, 'agent-1');
    a1.peer = newPeer(660);
    await a1.peer.pc.setLocalDescription(await a1.peer.pc.createOffer());
    await gathered(a1.peer.pc);
    a1.socket.emit('call:reconnect', { callId: row2.id, sdpOffer: a1.peer.pc.localDescription.sdp });
    const back = await waitFor(() => a1.events.find((e) => e.event === 'call:reconnected')?.payload, 10000, 'call:reconnected').catch(() => null);
    if (back) {
        await a1.peer.pc.setRemoteDescription({ type: 'answer', sdp: back.sdpAnswer });
        for (const c of a1.pendingCandidates.splice(0)) await a1.peer.pc.addIceCandidate(c).catch(() => { });
    }
    await hear(cust2);
    check('after reconnecting the customer hears the agent again, not the tone', Boolean(back) && cust2.dominant() === 660, `tone=${cust2.dominant()}`);
    await endByAgent(a1, row2.id);
    await waitFor(async () => ['AVAILABLE', 'OFFLINE'].includes(await availability('agent-1')), 8000, 'agent-1 released');
    await setAvailable(a1);

    // ── 3. Hold music after an IVR transfer, until the agent answers ──
    mkdirSync(STORAGE, { recursive: true });
    writeFileSync(`${STORAGE}/media-prompt.wav`, wav(300, 1));
    writeFileSync(`${STORAGE}/media-hold.wav`, wav(HOLD, 3));
    const prompt = await api('POST', '/v1/tenants/demo/audio-assets', { name: 'Media prompt', storage_provider: 'LOCAL', storage_key: 'media-prompt.wav', mime_type: 'audio/wav' });
    const hold = await api('POST', '/v1/tenants/demo/audio-assets', { name: 'Media hold', storage_provider: 'LOCAL', storage_key: 'media-hold.wav', mime_type: 'audio/wav' });
    await api('PUT', `/v1/tenants/demo/queues/${seed.queue.ref}`, { name: 'Main queue', strategy: 'ROUND_ROBIN', hold_audio_asset_id: hold.body.audioAsset.id });
    const flow = await api('PUT', '/v1/tenants/demo/ivr-flows/media-hold', {
        name: 'Hold music', channel_ref: whatsapp.ref, status: 'ACTIVE', trigger_condition: 'ALWAYS',
        structure: {
            nodes: [
                { id: 'start', type: 'ivr_start', data: {} },
                { id: 'hello', type: 'ivr_play', data: { audioFileId: prompt.body.audioAsset.id } },
                { id: 'agents', type: 'ivr_transfer', data: { targetType: 'queue' } },
            ],
            edges: [{ source: 'start', target: 'hello' }, { source: 'hello', target: 'agents' }],
        },
    });
    check('an IVR flow that plays a prompt then transfers to the queue', flow.status === 200, `HTTP ${flow.status}`);

    const c3 = await meta.callIn('wacid.m.3');
    const row3 = await callByProvider(c3.id);
    const offer3 = await nextIncoming(a1, row3.id, 20000, (p) => Boolean(p.sdpOffer));
    const holdEar = listen((await c3.customer.received).track, [HOLD, 300, 750, 880])   // 750: the interim tone, if the file never loads;
    await hear(holdEar, 2500, 1000);
    check('while the agent rings the customer hears the queue hold music', holdEar.dominant() === HOLD,
        `tone=${holdEar.dominant()} bins=${JSON.stringify(Object.fromEntries(Object.entries(holdEar.stats.bins).map(([f, e]) => [f, Math.round(Math.log10(e + 1))])))}`);
    await accept(a1, offer3, 880);
    await waitFor(async () => (await callRow(row3.id)).status === 'IN_PROGRESS', 15000, 'call 3 answered');
    await hear(holdEar);
    check('once the agent answers the hold music stops and the customer hears the agent', holdEar.dominant() === 880, `tone=${holdEar.dominant()}`);
    holdEar.stop();
    await endByAgent(a1, row3.id);

    await api('PUT', '/v1/tenants/demo/ivr-flows/media-hold', { name: 'Hold music', channel_ref: whatsapp.ref, status: 'INACTIVE', trigger_condition: 'ALWAYS',
        structure: { nodes: [{ id: 'start', type: 'ivr_start', data: {} }], edges: [] } });
    await api('PUT', `/v1/tenants/demo/queues/${seed.queue.ref}`, { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    a1.socket.close();
} catch (err) {
    console.log(`FAIL  suite crashed — ${err.stack || err.message}`);
    exitCode = 1;
} finally {
    meta.close();
    await db.end();
}

const failed = summary();
process.exit(exitCode || (failed ? 1 : 0));
