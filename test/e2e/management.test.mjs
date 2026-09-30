// Management API housekeeping: deleting queues, channels, IVR flows and audio
// assets — refused (409 in_use, with what uses it) while something depends on
// them, including a live call; history kept after. Rotating API keys and
// agent-token signing keys: issue, switch over, revoke (not the last one);
// a revoked signing key's sockets are disconnected. Reports: calls over time,
// agents, the queues right now.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { testDb, makeChecks, waitFor, sleep, fakeMeta, wav, connectAgent, accept, nextIncoming, api as makeApi } from './lib.mjs';

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

    // ── Reports ──
    await api('PUT', `${T}/queues/main`, { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', `${T}/queues/main/members`, { members: [{ agent_ref: 'agent-1' }] });
    const agent = await connectAgent(CALLIO, seed, 'agent-1');
    const availability = async () => (await q("SELECT availability FROM agents WHERE external_ref = 'agent-1'"))[0]?.availability;
    agent.socket.emit('agent:availability:set', { availability: 'AVAILABLE' });
    await waitFor(async () => (await availability()) === 'AVAILABLE', 5000, 'agent-1 available');

    const cA = await meta.callIn('wacid.m.2', { from: '96181030872' });
    const rowA = await callByProvider(cA.id);
    await accept(agent, await nextIncoming(agent, rowA.id), 880);
    await waitFor(async () => (await callRow(rowA.id)).status === 'IN_PROGRESS', 10000, 'call A answered');
    await sleep(2200);
    await meta.hangUp(cA.id);
    await waitFor(async () => (await callRow(rowA.id)).status === 'TERMINATED', 10000, 'call A ended');
    agent.peer?.close(); agent.peer = null;

    await waitFor(async () => (await availability()) === 'AVAILABLE', 8000, 'agent-1 released');
    agent.socket.emit('agent:availability:set', { availability: 'OFFLINE' });
    await waitFor(async () => (await availability()) === 'OFFLINE', 5000, 'agent-1 offline');
    const cB = await meta.callIn('wacid.m.3', { from: '96181030873' });
    const rowB = await callByProvider(cB.id);
    await sleep(1200);
    const liveNow = await api('GET', `${T}/reports/live`);
    const mainLive = liveNow.body?.queues?.find((x) => x.queueRef === 'main');
    check('the live report shows the waiting call and the queue’s agents',
        liveNow.status === 200 && mainLive?.waiting === 1 && mainLive.longestWaitSeconds >= 1 && mainLive.agents.offline === 1 && liveNow.body.liveCalls >= 1,
        JSON.stringify(mainLive));
    await meta.hangUp(cB.id);
    await waitFor(async () => (await callRow(rowB.id)).status === 'TERMINATED', 10000, 'call B ended');

    const from = new Date(Date.now() - 3600_000).toISOString();
    const rep = await api('GET', `${T}/reports/calls?from=${from}&interval=hour&service_level_seconds=30`);
    const t = rep.body?.totals ?? {};
    // Calls in this suite: m.1 (hung up while waiting), A (answered), B (hung up while waiting).
    check('the calls report counts answered and abandoned calls, with wait and talk time',
        rep.status === 200 && t.inbound === 3 && t.answered === 1 && t.abandoned === 2 && t.missed === 0
        && t.talkSeconds >= 1 && t.avgWaitSeconds != null && t.serviceLevelPercent != null,
        JSON.stringify(t));
    const sum = (rep.body?.buckets ?? []).reduce((n, b) => n + b.inbound, 0);
    check('hourly buckets add up to the totals', sum === t.inbound && rep.body.buckets.length >= 1, `buckets=${rep.body?.buckets?.length} sum=${sum}`);
    const byQueue = await api('GET', `${T}/reports/calls?from=${from}&queue_ref=nope`);
    const badRange = await api('GET', `${T}/reports/calls?from=2026-01-01T00:00:00Z&to=2025-01-01T00:00:00Z`);
    check('report filters and ranges are validated', byQueue.status === 400 && badRange.status === 400, `${byQueue.status}/${badRange.status}`);
    const agents = await api('GET', `${T}/reports/agents?from=${from}`);
    const a1 = agents.body?.agents?.find((a) => a.agentRef === 'agent-1');
    check('the agents report credits the answering agent', agents.status === 200 && a1?.answered === 1 && a1.talkSeconds >= 1 && a1.avgTalkSeconds >= 1,
        JSON.stringify(a1));
    agent.socket.close();

    // ── API key rotation ──
    const listed = await api('GET', '/v1/api-keys');
    const seedKey = listed.body.apiKeys.find((k) => k.revokedAt == null);
    check('API keys are listed without secrets', listed.status === 200 && seedKey && !JSON.stringify(listed.body).includes(seed.api_key)
        && seedKey.prefix === seed.api_key.slice(0, 16), JSON.stringify(listed.body.apiKeys[0]));
    const idem = { 'Idempotency-Key': 'rotate-1' };
    const k1 = await api('POST', '/v1/api-keys', { name: 'rotated', expires_in_days: 30 }, idem);
    const k2 = await api('POST', '/v1/api-keys', { name: 'rotated', expires_in_days: 30 }, idem);
    check('a new API key is shown once, and a retried POST is never replayed (the secret is not stored)',
        k1.status === 201 && /^ck_dev_/.test(k1.body.apiKey.key) && k1.body.apiKey.expiresAt
        && k2.status === 201 && k2.body.apiKey.key !== k1.body.apiKey.key && !k2.headers.get('idempotent-replayed'),
        `${k1.status}/${k2.status}`);
    const withNew = makeApi(CALLIO, k1.body.apiKey.key);
    const revokeSeed = await withNew('DELETE', `/v1/api-keys/${seedKey.id}`);
    const seedAfter = await api('GET', '/v1/api-keys');
    check('the old key is revoked with the new one, and stops working', revokeSeed.status === 204 && seedAfter.status === 401,
        `${revokeSeed.status}/${seedAfter.status}`);
    await withNew('DELETE', `/v1/api-keys/${k2.body.apiKey.id}`);
    const last = await withNew('DELETE', `/v1/api-keys/${k1.body.apiKey.id}`);
    check('the last active API key cannot be revoked', last.status === 409 && last.body.error.code === 'last_key', `${last.status}`);
    await q('UPDATE consumer_api_keys SET revoked_at = NULL WHERE id = ?', [seedKey.id]);   // later suites use it

    // ── Signing key rotation ──
    const sk = await api('POST', '/v1/signing-keys', {});
    check('a new signing key gets the next kid and its secret once', sk.status === 201 && sk.body.signingKey.kid === 'k2' && sk.body.signingKey.secret,
        JSON.stringify(sk.body));
    const dup = await api('POST', '/v1/signing-keys', { kid: 'k2' });
    check('a kid is never reused', dup.status === 409 && dup.body.error.code === 'kid_taken', `${dup.status}`);
    const tokenK2 = jwt.sign({ iss: 'dev', sub: 'agent-1', tnt: 'demo', name: 'agent-1' }, sk.body.signingKey.secret,
        { algorithm: 'HS256', keyid: 'k2', expiresIn: '10m' });
    const connectWith = (token) => new Promise((resolve) => {
        const s = io(CALLIO, { transports: ['websocket'], auth: { token, device_id: 'k2-device', protocol: 1 }, reconnection: false });
        s.on('connect', () => resolve({ s, ok: true }));
        s.on('connect_error', (e) => { s.close(); resolve({ ok: false, error: e.message }); });
    });
    const onK2 = await connectWith(tokenK2);
    check('an agent connects with a token signed by the new key', onK2.ok, onK2.error);
    const dropped = new Promise((resolve) => onK2.s?.on('disconnect', resolve));
    const revokeK2 = await api('DELETE', '/v1/signing-keys/k2');
    const reason = await Promise.race([dropped, new Promise((r) => setTimeout(() => r('still connected'), 5000))]);
    check('revoking a signing key disconnects the sockets it signed', revokeK2.status === 204 && reason === 'io server disconnect', `${revokeK2.status} ${reason}`);
    const again2 = await connectWith(tokenK2);
    check('and its tokens are refused from then on', !again2.ok && /signing key/i.test(again2.error ?? ''), again2.error);
    const lastSk = await api('DELETE', '/v1/signing-keys/k1');
    check('the last signing key cannot be revoked', lastSk.status === 409 && lastSk.body.error.code === 'last_key', `${lastSk.status}`);
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    meta.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
