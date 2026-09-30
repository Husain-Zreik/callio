// Management API housekeeping: deleting queues, channels, IVR flows and audio
// assets — refused (409 in_use, with what uses it) while something depends on
// them, including a live call; history kept after.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { testDb, makeChecks, waitFor, fakeMeta, wav, api as makeApi } from './lib.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 3901);
const CALLIO = `http://127.0.0.1:${PORT}`;
const { check, summary } = makeChecks();
const api = makeApi(CALLIO, seed.api_key);
const meta = fakeMeta({ callioUrl: CALLIO, apiKey: seed.api_key, phoneNumberId: '111222333' });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const callByProvider = (id) => waitFor(async () => (await q('SELECT * FROM calls WHERE provider_call_id = ?', [id]))[0], 8000, `call ${id}`);
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const T = '/v1/tenants/demo';

await meta.listen();
let exitCode = 0;

try {
    // ── Something to delete, wired together ──
    const STORAGE = process.env.STORAGE_LOCAL_ROOT ?? join(tmpdir(), 'callio-mgmt');
    mkdirSync(STORAGE, { recursive: true });
    writeFileSync(join(STORAGE, 'side.wav'), wav(500, 1));
    const asset = (await api('POST', `${T}/audio-assets`, { name: 'Side prompt', storage_provider: 'LOCAL', storage_key: 'side.wav', mime_type: 'audio/wav' })).body.audioAsset;
    const side = (await api('PUT', `${T}/queues/side`, { name: 'Side', hold_audio_asset_id: asset.id })).body.queue;
    await api('PUT', `${T}/queues/spill`, { name: 'Spill', overflow_queue_ref: 'side' });
    const line = await api('PUT', `${T}/channels/side-line`, { type: 'WHATSAPP', address: '+96170000077', provider_account_id: '777000777', inbound_queue_ref: 'side' });
    await api('PUT', `${T}/ivr-flows/side-menu`, {
        name: 'Side menu', channel_ref: 'side-line', status: 'INACTIVE',
        structure: {
            nodes: [
                { id: 'start', type: 'ivr_start', data: {} },
                { id: 'menu', type: 'ivr_menu', data: { audioFileId: asset.id, timeoutSeconds: 5 } },
                { id: 'to-side', type: 'ivr_transfer', data: { targetType: 'queue', targetId: side.id } },
            ],
            edges: [{ source: 'start', target: 'menu' }, { source: 'menu', target: 'to-side', sourceHandle: '1' }],
        },
    });
    check('a queue, channel, IVR flow and audio asset are set up', Boolean(asset?.id && side?.id) && line.status === 200, `channel HTTP ${line.status}`);

    // ── Refused while in use ──
    const qDel = await api('DELETE', `${T}/queues/side`);
    const qd = qDel.body?.error?.details ?? {};
    check('a queue in use is not deleted, and the answer says by what',
        qDel.status === 409 && qDel.body.error.code === 'in_use' && qd.channels?.[0] === 'side-line'
        && qd.overflowQueues?.[0] === 'spill' && qd.ivrFlows?.[0] === 'side-menu',
        `${qDel.status} ${JSON.stringify(qDel.body?.error)}`);
    const aDel = await api('DELETE', `${T}/audio-assets/${asset.id}`);
    const ad = aDel.body?.error?.details ?? {};
    check('an audio asset a queue holds with and a flow plays is not deleted',
        aDel.status === 409 && ad.queues?.[0] === 'side' && ad.ivrFlows?.[0] === 'side-menu', `${aDel.status} ${JSON.stringify(aDel.body?.error)}`);

    // ── A live call blocks deleting its channel ──
    const c1 = await meta.callIn('wacid.m.1');
    const row1 = await callByProvider(c1.id);
    const live = await api('DELETE', `${T}/channels/whatsapp-main`);
    check('a channel with a live call is not deleted', live.status === 409 && live.body?.error?.details?.liveCalls === true,
        `${live.status} ${JSON.stringify(live.body?.error)}`);
    await meta.hangUp(c1.id);
    await waitFor(async () => (await callRow(row1.id)).status === 'TERMINATED', 10000, 'call 1 ended');

    // ── Deleted once nothing depends on them ──
    const chDel = await api('DELETE', `${T}/channels/side-line`);
    const flows = (await api('GET', `${T}/ivr-flows`)).body.ivrFlows.map((f) => f.ref);
    check('a channel is deleted, and its IVR flows with it', chDel.status === 204 && !flows.includes('side-menu'), `HTTP ${chDel.status} flows=${flows}`);
    await api('PUT', `${T}/queues/spill`, { name: 'Spill' });
    const qOk = await api('DELETE', `${T}/queues/side`);
    const queues = (await api('GET', `${T}/queues`)).body.queues.map((x) => x.ref);
    check('the queue is deleted once nothing routes into it', qOk.status === 204 && !queues.includes('side'), `HTTP ${qOk.status} queues=${queues}`);
    const aOk = await api('DELETE', `${T}/audio-assets/${asset.id}`);
    check('the audio asset is deleted once nothing plays it', aOk.status === 204, `HTTP ${aOk.status}`);
    const again = await api('DELETE', `${T}/queues/side`);
    check('deleting it again is 404', again.status === 404, `HTTP ${again.status}`);

    // A flow on its own, and history after a delete.
    await api('PUT', `${T}/ivr-flows/lonely`, { name: 'Lonely', structure: { nodes: [{ id: 'start', type: 'ivr_start', data: {} }], edges: [] } });
    const fDel = await api('DELETE', `${T}/ivr-flows/lonely`);
    check('an unused IVR flow is deleted', fDel.status === 204, `HTTP ${fDel.status}`);
    const kept = await callRow(row1.id);
    check('call history is kept', kept?.status === 'TERMINATED' && kept.channel_address != null);
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    meta.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
