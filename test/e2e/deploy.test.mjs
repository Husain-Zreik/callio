// e2e-workers: 2
// A deploy doesn't end calls: a worker shutting down gracefully (as PM2 stops
// it — here by IPC message) hands the calls it runs over instead of ending
// them. The call stays IN_PROGRESS, the provider is never told to hang up,
// the media never stops, worker 2 takes it over within seconds (the lease is
// given up, not left to lapse), and it hangs up cleanly afterwards.
// Run through run.mjs, which provides E2E_WORKERS and E2E_CONTROL_URL.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import {
    testDb, sleep, makeChecks, waitFor, hear, fakeMeta,
    connectAgent, accept, nextIncoming, api as makeApi,
} from './lib.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const workers = JSON.parse(process.env.E2E_WORKERS || '[]');
if (workers.length < 2 || !process.env.E2E_CONTROL_URL) {
    console.log('deploy.test.mjs needs two workers and the runner control (run it through run.mjs)');
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
    const a1 = await connectAgent(W2, seed, 'agent-1');
    await setAvailability(a1, 'AVAILABLE');

    const c1 = await meta.callIn('wacid.dp.1');
    const row1 = await callByProvider(c1.id);
    await accept(a1, await nextIncoming(a1, row1.id), 880);
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 10000, 'call in progress');
    const custBefore = await ear(c1.customer.received);
    const agentBefore = await ear(a1.peer.received);
    const boot1 = (await health(W1))?.boot;
    const leaseKey = `callio:call:${row1.id}:lease`;
    check('a bridged call runs on worker 1', custBefore?.dominant() === 880 && agentBefore?.dominant() === 440 && (await redis.get(leaseKey)) === boot1,
        `customer=${custBefore?.dominant()} agent=${agentBefore?.dominant()} lease=${await redis.get(leaseKey)} w1=${boot1}`);

    // The deploy: worker 1 is asked to stop.
    const stoppedAt = Date.now();
    meta.retarget(W2);
    await fetch(`${process.env.E2E_CONTROL_URL}/workers/0/shutdown`, { method: 'POST' });
    const boot2 = (await health(W2))?.boot;
    const handedTo = await waitFor(async () => ((await redis.get(leaseKey)) === boot2) || null, 12000, 'call handed over').catch(() => false);
    check('worker 2 takes the call over within seconds (the lease is given up, not left to lapse)', Boolean(handedTo),
        `after ${Math.round((Date.now() - stoppedAt) / 1000)}s lease=${await redis.get(leaseKey)}`);
    const exited = await waitFor(async () => (await health(W1)) === null || null, 30000, 'worker 1 gone').catch(() => false);
    check('worker 1 finishes its shutdown and exits', Boolean(exited));

    const custAfter = await ear(c1.customer.received);
    const agentAfter = await ear(a1.peer.received);
    const during = await callRow(row1.id);
    check('the call was never ended: still IN_PROGRESS and bridged both ways, the provider never told to hang up',
        during.status === 'IN_PROGRESS' && custAfter?.dominant() === 880 && agentAfter?.dominant() === 440 && terminatesFor(c1.id) === 0,
        `${during.status} ${during.termination_reason ?? ''} customer=${custAfter?.dominant()} agent=${agentAfter?.dominant()} terminates=${terminatesFor(c1.id)}`);

    a1.socket.emit('call:terminate', { callId: row1.id });
    await waitFor(async () => (await callRow(row1.id)).status === 'TERMINATED', 10000, 'call ended').catch(() => { });
    const ended = await callRow(row1.id);
    check('it hangs up cleanly afterwards: COMPLETED/AGENT, the provider told once', ended.termination_reason === 'COMPLETED'
        && ended.terminated_by === 'AGENT' && terminatesFor(c1.id) >= 1, `${ended.termination_reason}/${ended.terminated_by} terminates=${terminatesFor(c1.id)}`);
    await waitFor(async () => (await health(W2))?.media?.rooms === 0, 8000, 'room closed').catch(() => { });
    check('its room, state and lease are gone', (await health(W2))?.media?.rooms === 0
        && !(await redis.exists(`callio:call:${row1.id}:room`)) && !(await redis.exists(leaseKey)));
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
