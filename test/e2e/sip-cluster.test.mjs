// e2e-workers: 2
// SIP calls outliving the worker that answered them. drachtio hands each
// INVITE to one of the two workers; the agents are on worker 2, and calls are
// placed until two answered ones run on worker 1. Worker 1 is killed: worker 2
// takes both over — the room from its snapshot, the carrier dialog by its id —
// and then:
//   X  the agent hangs up: the carrier gets a BYE (sent inside the taken-over dialog)
//   Y  the carrier hangs up: its BYE goes to the dead worker's connection, so
//      worker 2's in-dialog OPTIONS probe notices (481) and ends it COMPLETED/CUSTOMER
// Run through run.mjs; needs the local SIP gateway (docs/sip.md).
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { testDb, sleep, makeChecks, waitFor, hear, connectAgent, accept, api as makeApi } from './lib.mjs';
import { sipCarrier } from './sipCarrier.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const workers = JSON.parse(process.env.E2E_WORKERS || '[]');
if (workers.length < 2) {
    console.log('sip-cluster.test.mjs needs two workers (run it through run.mjs)');
    process.exit(1);
}
const [W1, W2] = workers.map((w) => `http://127.0.0.1:${w.port}`);
const DID = '+96170000001';
const { check, summary } = makeChecks();
const api = makeApi(W2, seed.api_key);
const carrier = sipCarrier({ sipPort: Number(process.env.TEST_SIP_CARRIER_PORT || 5070) });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const Redis = createRequire(import.meta.url)('ioredis');
const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT), db: Number(process.env.REDIS_DB ?? 0) });
const sipCall = (providerCallId) => waitFor(async () => (await q("SELECT * FROM calls WHERE channel = 'SIP' AND provider_call_id = ?", [providerCallId]))[0], 8000, `SIP call ${providerCallId}`);
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const availability = async (ref) => (await q('SELECT availability FROM agents WHERE external_ref = ?', [ref]))[0]?.availability;
const setAvailability = async (agent, value) => {
    agent.socket.emit('agent:availability:set', { availability: value });
    const ok = value === 'AVAILABLE' ? ['AVAILABLE', 'ON_CALL'] : [value];
    await waitFor(async () => ok.includes(await availability(agent.ref)), 5000, `${agent.ref} ${value}`);
};
const bootOf = async (url) => (await (await fetch(`${url}/health`)).json()).boot;
const lease = (callId) => redis.get(`callio:call:${callId}:lease`);
const carrierHears = async (call, ms = 3000) => { await sleep(1500); call.rtp.ear.reset(); await sleep(ms); return call.rtp.ear; };
const track = (received) => Promise.race([received, sleep(10000).then(() => null)]);

await carrier.listen();
let exitCode = 0;

try {
    const trunkId = (await q("SELECT id FROM sip_trunks WHERE name = 'dev-trunk'"))[0].id;
    await api('PUT', '/v1/tenants/demo/channels/sip-main', { type: 'SIP', display_name: 'SIP line', address: DID, sip_trunk_id: trunkId, inbound_queue_ref: 'main' });
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }, { agent_ref: 'agent-2' }] });
    const agents = [await connectAgent(W2, seed, 'agent-1'), await connectAgent(W2, seed, 'agent-2')];
    for (const a of agents) await setAvailability(a, 'AVAILABLE');
    const boot1 = await bootOf(W1);
    const boot2 = await bootOf(W2);

    // An answered SIP call that worker 1 runs (drachtio picks the worker).
    let n = 0;
    async function callOnWorker1() {
        for (let attempt = 0; attempt < 6; attempt++) {
            const c = await carrier.callIn({ from: `+9618103090${++n}`, to: DID, freqs: [440] });
            const row = await sipCall(c.callId);
            const offered = await waitFor(() => agents.map((a) => ({ a, p: a.incoming.find((p) => String(p.callId) === String(row.id)) })).find((x) => x.p),
                10000, `offer of call ${row.id}`);
            await accept(offered.a, offered.p, 880);
            await c.answered;
            await waitFor(async () => (await callRow(row.id)).status === 'IN_PROGRESS', 15000, `call ${row.id} answered`);
            if ((await lease(row.id)) === boot1) return { c, row, agent: offered.a };
            offered.a.socket.emit('call:terminate', { callId: row.id });   // on worker 2: try again
            await waitFor(async () => (await callRow(row.id)).status === 'TERMINATED', 10000, `call ${row.id} ended`);
            offered.a.peer?.close(); offered.a.peer = null;
            await waitFor(async () => (await availability(offered.a.ref)) === 'AVAILABLE', 8000, `${offered.a.ref} released`);
        }
        throw new Error('no call landed on worker 1');
    }
    const X = await callOnWorker1();
    const Y = await callOnWorker1();
    check('two answered SIP calls run on worker 1', (await lease(X.row.id)) === boot1 && (await lease(Y.row.id)) === boot1);
    const xAgentEar = await track(X.agent.peer.received);
    if (xAgentEar) await hear(xAgentEar);
    const xCarrierEar = await carrierHears(X.c);
    check('call X bridges both ways over G.711', xAgentEar?.dominant() === 440 && xCarrierEar.dominant() === 880,
        `agent=${xAgentEar?.dominant()} carrier=${xCarrierEar.dominant()}`);

    process.kill(workers[0].pid);
    const yCarrierGap = await carrierHears(Y.c);
    check('with worker 1 dead the carrier still hears the agent', yCarrierGap.dominant() === 880, `carrier=${yCarrierGap.dominant()}`);
    const adopted = await waitFor(async () => ((await lease(X.row.id)) === boot2 && (await lease(Y.row.id)) === boot2) || null, 30000, 'both SIP calls adopted').catch(() => false);
    check('worker 2 takes both SIP calls over', Boolean(adopted), `X=${await lease(X.row.id)} Y=${await lease(Y.row.id)} worker2=${boot2}`);

    // X: hung up on Callio's side — a BYE inside the taken-over carrier dialog.
    X.agent.socket.emit('call:terminate', { callId: X.row.id });
    const byeX = await waitFor(() => X.c.ended === 'remote' || null, 10000, 'BYE to the carrier for X').catch(() => false);
    await waitFor(async () => (await callRow(X.row.id)).status === 'TERMINATED', 10000, 'X ended').catch(() => { });
    const endX = await callRow(X.row.id);
    check('an agent hang-up on a taken-over SIP call sends the carrier a BYE; COMPLETED/AGENT',
        Boolean(byeX) && endX.termination_reason === 'COMPLETED' && endX.terminated_by === 'AGENT', `bye=${Boolean(byeX)} ${endX.termination_reason}/${endX.terminated_by}`);

    // Y: hung up by the carrier — noticed by the OPTIONS probe.
    await carrier.hangUp(Y.c);
    await waitFor(async () => (await callRow(Y.row.id)).status === 'TERMINATED', 20000, 'Y ended').catch(() => { });
    const endY = await callRow(Y.row.id);
    check('a carrier hang-up on a taken-over SIP call is noticed by the in-dialog probe (481, or a dialog drachtio no longer has); COMPLETED/CUSTOMER',
        endY.status === 'TERMINATED' && endY.termination_reason === 'COMPLETED' && endY.terminated_by === 'CUSTOMER',
        `${endY.status} ${endY.termination_reason}/${endY.terminated_by} options=${Y.c.optionsSeen ?? 0}`);
    await waitFor(async () => !(await redis.exists(`callio:call:${Y.row.id}:room`)), 8000, 'room state dropped').catch(() => { });
    check('both calls\' rooms and state are gone', !(await redis.exists(`callio:call:${X.row.id}:room`)) && !(await redis.exists(`callio:call:${Y.row.id}:room`))
        && (await (await fetch(`${W2}/health`)).json()).media?.rooms === 0);
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    if (summary() > 0) exitCode = 1;
    carrier.close?.();
    redis.disconnect();
    await db.end();
    process.exit(exitCode);
}
