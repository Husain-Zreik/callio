// e2e-workers: 2
// Two Callio workers on one Redis and one database, as PM2 runs them: a
// call's media lives on the worker that took it, and everything else reaches
// that worker through the call's inbox (infra/cluster/CallInbox.js).
//   1. The customer arrives on worker 1; the agent, connected to worker 2,
//      accepts: the accept reaches worker 1, the call bridges both ways.
//   2. The call waits in the queue on worker 1; the agent becomes available
//      on worker 2, which drains the queue and makes the offer: the offer is
//      made by worker 1 (the call's room stays on one worker) and bridges.
// Run through run.mjs, which starts the workers and passes them in E2E_WORKERS.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import {
    testDb, sleep, makeChecks, waitFor, hear, fakeMeta,
    connectAgent, accept, nextIncoming, api as makeApi,
} from './lib.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const workers = JSON.parse(process.env.E2E_WORKERS || '[]');
if (workers.length < 2) {
    console.log('cluster.test.mjs needs two workers (run it through run.mjs)');
    process.exit(1);
}
const [W1, W2] = workers.map((w) => `http://127.0.0.1:${w.port}`);
const { check, summary } = makeChecks();
const Redis = createRequire(import.meta.url)('ioredis');
const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT), db: Number(process.env.REDIS_DB ?? 0) });
const roomState = async (callId) => JSON.parse((await redis.get(`callio:call:${callId}:room`)) ?? 'null');
const api = makeApi(W1, seed.api_key);
const meta = fakeMeta({ callioUrl: W1, apiKey: seed.api_key, phoneNumberId: '111222333' });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const callByProvider = (id) => waitFor(async () => (await q('SELECT * FROM calls WHERE provider_call_id = ?', [id]))[0], 8000, `call ${id}`);
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const availability = async (ref) => (await q('SELECT availability FROM agents WHERE external_ref = ?', [ref]))[0]?.availability;
const setAvailability = async (agent, value) => {
    agent.socket.emit('agent:availability:set', { availability: value });
    const ok = value === 'AVAILABLE' ? ['AVAILABLE', 'ON_CALL'] : [value];
    await waitFor(async () => ok.includes(await availability(agent.ref)), 5000, `${agent.ref} ${value}`);
};
// A track, or null after 10 s (a call that never bridges fails its check, not the run).
const track = (received) => Promise.race([received, sleep(10000).then(() => null)]);
const ear = async (received) => { const t = await track(received); if (t) await hear(t); return t; };
const rooms = async (url) => (await (await fetch(`${url}/health`)).json()).media?.rooms ?? -1;
const endByAgent = async (agent, callId) => {
    agent.socket.emit('call:terminate', { callId });
    await waitFor(async () => (await callRow(callId)).status === 'TERMINATED', 10000, `call ${callId} ended`);
    agent.peer?.close(); agent.peer = null;
};

await meta.listen();
let exitCode = 0;

try {
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }] });
    const a1 = await connectAgent(W2, seed, 'agent-1');

    // ── 1. Customer on worker 1, agent on worker 2 ──
    await setAvailability(a1, 'AVAILABLE');
    const c1 = await meta.callIn('wacid.cl.1');
    const row1 = await callByProvider(c1.id);
    const offer1 = await nextIncoming(a1, row1.id);
    check('a call arriving on worker 1 is offered to an agent connected to worker 2', Boolean(offer1?.sdpOffer));
    await accept(a1, offer1, 880);
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 10000, 'call 1 in progress');
    const cust1 = await ear(c1.customer.received);
    const agent1 = await ear(a1.peer.received);
    check('across workers the customer hears the agent and the agent hears the customer',
        cust1?.dominant() === 880 && agent1?.dominant() === 440, `customer=${cust1?.dominant()} agent=${agent1?.dominant()}`);
    check('the call\'s room is on worker 1 only', (await rooms(W1)) === 1 && (await rooms(W2)) === 0,
        `w1=${await rooms(W1)} w2=${await rooms(W2)}`);
    const snap = await roomState(row1.id);
    const legOk = (leg) => Boolean(leg?.uuid && leg?.dialogId && leg?.rtpKey && leg?.memberId != null);
    check('the room state is in Redis for a worker taking it over (legs with channel uuid, dialog id, rtpengine key, member)',
        legOk(snap?.customer) && legOk(snap?.agents?.[0]) && snap?.bridged === true,
        JSON.stringify({ customer: snap?.customer && Object.keys(snap.customer).filter((k) => snap.customer[k] != null), agents: snap?.agents?.length, bridged: snap?.bridged }));
    await endByAgent(a1, row1.id);
    await waitFor(async () => !(await redis.exists(`callio:call:${row1.id}:room`)), 5000, 'room state dropped').catch(() => { });
    check('the room state goes when the call ends', !(await redis.exists(`callio:call:${row1.id}:room`)));
    check('a hang-up from worker 2 ends the call', (await callRow(row1.id)).status === 'TERMINATED');
    await waitFor(async () => (await rooms(W1)) === 0, 8000, 'worker 1 room closed').catch(() => { });
    await waitFor(async () => (await availability('agent-1')) !== 'ON_CALL', 8000, 'agent-1 released').catch(() => { });

    // ── 2. The queue drains on worker 2, the offer comes from worker 1 ──
    await setAvailability(a1, 'OFFLINE');
    const c2 = await meta.callIn('wacid.cl.2', { from: '96181030852' });
    const row2 = await callByProvider(c2.id);
    await waitFor(async () => (await callRow(row2.id)).status === 'RINGING', 8000, 'call 2 queued');
    await sleep(500);
    // No stored agent offer to reuse (as after an answered agent leg was
    // dropped): the drain on worker 2 has to get a new one made.
    await q("DELETE FROM call_connections WHERE call_id = ? AND connection_type = 'AGENT'", [row2.id]);
    a1.incoming.length = 0;
    await setAvailability(a1, 'AVAILABLE');
    const offer2 = await nextIncoming(a1, row2.id, 10000).catch(() => null);
    check('an agent becoming available on worker 2 is offered the call waiting on worker 1', Boolean(offer2?.sdpOffer));
    if (offer2) {
        await accept(a1, offer2, 880);
        await waitFor(async () => (await callRow(row2.id)).status === 'IN_PROGRESS', 10000, 'call 2 in progress').catch(() => { });
        const cust2 = await ear(c2.customer.received);
        const agent2 = await ear(a1.peer.received);
        check('the offer made from worker 2\'s drain bridges both ways',
            cust2?.dominant() === 880 && agent2?.dominant() === 440, `customer=${cust2?.dominant()} agent=${agent2?.dominant()}`);
        check('the call\'s legs stay on worker 1 (worker 2 made no room)', (await rooms(W1)) === 1 && (await rooms(W2)) === 0,
            `w1=${await rooms(W1)} w2=${await rooms(W2)}`);
        await endByAgent(a1, row2.id);
    }
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
