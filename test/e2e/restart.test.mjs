// e2e-workers: 2
// `pm2 restart` of every worker during a call: all of them stop at once
// (gracefully, handing their calls over to nobody yet), then fresh processes
// start. The call's media never depends on a worker, so the audio keeps going
// through the whole gap; a new worker's start-up sweep must spare the live
// call's legs, and the new workers adopt it. Then it hangs up cleanly.
// Run through run.mjs (E2E_WORKERS, E2E_CONTROL_URL: POST /workers/restart).
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import {
    testDb, sleep, makeChecks, waitFor, hear, fakeMeta,
    connectAgent, accept, nextIncoming, api as makeApi,
} from './lib.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const workers = JSON.parse(process.env.E2E_WORKERS || '[]');
if (workers.length < 2 || !process.env.E2E_CONTROL_URL) {
    console.log('restart.test.mjs needs two workers and the runner control (run it through run.mjs)');
    process.exit(1);
}
const [W1, W2] = workers.map((w) => `http://127.0.0.1:${w.port}`);
const { check, summary } = makeChecks();
const api = makeApi(W1, seed.api_key);
const meta = fakeMeta({ callioUrl: W1, apiKey: seed.api_key, phoneNumberId: '111222333' });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const Redis = createRequire(import.meta.url)('ioredis');
const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT), db: Number(process.env.REDIS_DB ?? 0) });
const callByProvider = (id) => waitFor(async () => (await q('SELECT * FROM calls WHERE provider_call_id = ?', [id]))[0], 8000, `call ${id}`);
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const availability = async (ref) => (await q('SELECT availability FROM agents WHERE external_ref = ?', [ref]))[0]?.availability;
const setAvailability = async (agent, value) => {
    agent.socket.emit('agent:availability:set', { availability: value });
    const ok = value === 'AVAILABLE' ? ['AVAILABLE', 'ON_CALL'] : [value];
    await waitFor(async () => ok.includes(await availability(agent.ref)), 5000, `${agent.ref} ${value}`);
};
const health = async (url) => { try { return await (await fetch(`${url}/health`)).json(); } catch { return null; } };
const track = (received) => Promise.race([received, sleep(10000).then(() => null)]);
const ear = async (received) => { const t = await track(received); if (t) await hear(t); return t; };
const terminatesFor = (providerCallId) => meta.calls.filter((c) => c.body?.action === 'terminate' && c.body?.call_id === providerCallId).length;

await meta.listen();
let exitCode = 0;

try {
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }] });
    let a1 = await connectAgent(W2, seed, 'agent-1');
    await setAvailability(a1, 'AVAILABLE');

    const c1 = await meta.callIn('wacid.rs.1');
    const row1 = await callByProvider(c1.id);
    await accept(a1, await nextIncoming(a1, row1.id), 880);
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 10000, 'call in progress');
    const custBefore = await ear(c1.customer.received);
    const agentBefore = await ear(a1.peer.received);
    check('a bridged call before the restart', custBefore?.dominant() === 880 && agentBefore?.dominant() === 440,
        `customer=${custBefore?.dominant()} agent=${agentBefore?.dominant()}`);
    const leaseKey = `callio:call:${row1.id}:lease`;
    const before = await redis.get(leaseKey);

    // Every worker restarts at once.
    const restartedAt = Date.now();
    const restart = fetch(`${process.env.E2E_CONTROL_URL}/workers/restart`, { method: 'POST' });
    await waitFor(async () => (await health(W1)) === null && (await health(W2)) === null, 30000, 'both workers down').catch(() => { });
    const custGap = await ear(c1.customer.received);
    const agentGap = await ear(a1.peer.received);
    check('with no worker running at all, the customer and the agent still hear each other',
        custGap?.dominant() === 880 && agentGap?.dominant() === 440, `customer=${custGap?.dominant()} agent=${agentGap?.dominant()}`);

    const res = await restart;
    check('fresh workers start on the same ports', res.ok, `HTTP ${res.status}`);
    const boots = new Set([(await health(W1))?.boot, (await health(W2))?.boot]);
    const adopted = await waitFor(async () => { const v = await redis.get(leaseKey); return v && v !== before && boots.has(v) ? v : null; }, 20000, 'call adopted by a new worker').catch(() => null);
    check('a new worker takes the call over after start-up (its sweep spared the legs)', Boolean(adopted),
        `lease=${await redis.get(leaseKey)} after ${Math.round((Date.now() - restartedAt) / 1000)}s`);
    const custAfter = await ear(c1.customer.received);
    const agentAfter = await ear(a1.peer.received);
    const during = await callRow(row1.id);
    check('the call was never ended and still bridges both ways; the provider never told to hang up',
        during.status === 'IN_PROGRESS' && custAfter?.dominant() === 880 && agentAfter?.dominant() === 440 && terminatesFor(c1.id) === 0,
        `${during.status} customer=${custAfter?.dominant()} agent=${agentAfter?.dominant()} terminates=${terminatesFor(c1.id)}`);

    // The agent's socket went with the restart: it reconnects and hangs up.
    a1.socket.close();
    a1 = Object.assign(await connectAgent(W1, seed, 'agent-1'), { peer: a1.peer });
    meta.retarget(W1);
    a1.socket.emit('call:terminate', { callId: row1.id });
    await waitFor(async () => (await callRow(row1.id)).status === 'TERMINATED', 15000, 'call ended').catch(() => { });
    const ended = await callRow(row1.id);
    check('after reconnecting, the agent hangs up: COMPLETED/AGENT, the provider told once', ended.termination_reason === 'COMPLETED'
        && ended.terminated_by === 'AGENT' && terminatesFor(c1.id) >= 1, `${ended.status} ${ended.termination_reason}/${ended.terminated_by} terminates=${terminatesFor(c1.id)}`);
    a1.peer?.close();
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    if (summary() > 0) exitCode = 1;
    meta.close();
    redis.disconnect();
    await db.end();
    process.exit(exitCode);
}
