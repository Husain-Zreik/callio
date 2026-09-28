// Queue timers and offers passing on: ring timeout to the next member, a
// decline passed on (and never offered back), a single member re-offered,
// max wait overflowing to another queue, and max wait ending the call.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync } from 'fs';
import {
    testDb, sleep, makeChecks, waitFor, hear, fakeMeta, eventReceiver,
    connectAgent, accept, nextIncoming, api as makeApi,
} from './lib.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 3901);
const CALLIO = `http://127.0.0.1:${PORT}`;
const { check, summary } = makeChecks();
const api = makeApi(CALLIO, seed.api_key);
const meta = fakeMeta({ callioUrl: CALLIO, apiKey: seed.api_key, phoneNumberId: '111222333' });
const receiver = eventReceiver({ secret: seed.webhook_secret });
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
const withdrawn = (agent, callId, reason) => waitFor(() => agent.events.find((e) => e.event === 'call:offer_withdrawn'
    && String(e.payload.callId) === String(callId) && (!reason || e.payload.reason === reason)), 15000, `${agent.ref} offer withdrawn (${reason})`);
const lifecycle = async (callId, type) => q('SELECT * FROM call_lifecycle_events WHERE call_id = ? AND event_type = ?', [callId, type]);
const endByAgent = async (agent, callId) => {
    agent.socket.emit('call:terminate', { callId });
    await waitFor(async () => (await callRow(callId)).status === 'TERMINATED', 10000, `call ${callId} ended`);
    agent.peer?.close(); agent.peer = null;
};

await meta.listen();
await receiver.listen();
let exitCode = 0;

try {
    const a1 = await connectAgent(CALLIO, seed, 'agent-1');
    const a2 = await connectAgent(CALLIO, seed, 'agent-2');
    const id = Object.fromEntries((await q("SELECT id, external_ref FROM agents")).map((r) => [r.external_ref, r.id]));
    const byId = { [id['agent-1']]: a1, [id['agent-2']]: a2 };
    const both = [{ agent_ref: 'agent-1' }, { agent_ref: 'agent-2' }];

    // ── 1. Ring timeout: an unanswered offer passes to the next member ──
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN', ring_timeout_seconds: 5 });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: both });
    await setAvailability(a1, 'AVAILABLE');
    await setAvailability(a2, 'AVAILABLE');

    const c1 = await meta.callIn('wacid.q.1');
    const row1 = await callByProvider(c1.id);
    const first = byId[row1.agent_id];
    const second = first === a1 ? a2 : a1;
    check('the call is offered to one member first', Boolean(first) && Boolean(await nextIncoming(first, row1.id)));

    await withdrawn(first, row1.id, 'timeout');
    const offerAfterTimeout = await nextIncoming(second, row1.id, 10000);
    const r1 = await callRow(row1.id);
    check('after the ring timeout the offer passes to the next member', offerAfterTimeout.agentId === id[second.ref] && r1.agent_id === id[second.ref]
        && r1.status === 'RINGING', `offered to ${second.ref}`);
    check('the agent who let it ring out is available again', (await availability(first.ref)) === 'AVAILABLE');
    check('the missed offer is logged', (await lifecycle(row1.id, 'inbound_offer_missed')).length === 1);

    await accept(second, offerAfterTimeout, second === a1 ? 880 : 660);
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 15000, 'call 1 answered');
    const heard1 = await hear(await c1.customer.received);
    check('the customer is bridged to the agent who answered', heard1.dominant() === (second === a1 ? 880 : 660), `tone=${heard1.dominant()}`);
    await endByAgent(second, row1.id);
    await waitFor(async () => (await availability(second.ref)) === 'AVAILABLE', 8000, `${second.ref} released`);

    // ── 2. A decline passes the offer on; a decliner is never offered it again ──
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    const c2 = await meta.callIn('wacid.q.2', { from: '96181030852' });
    const row2 = await callByProvider(c2.id);
    const d1 = byId[row2.agent_id];
    const d2 = d1 === a1 ? a2 : a1;
    await nextIncoming(d1, row2.id);
    d1.socket.emit('call:reject', { callId: row2.id });
    await withdrawn(d1, row2.id, 'declined');
    const passed = await nextIncoming(d2, row2.id, 10000);
    check('a decline passes the call to the next member instead of ending it', passed.agentId === id[d2.ref]
        && (await callRow(row2.id)).status === 'RINGING');

    d2.socket.emit('call:reject', { callId: row2.id });
    await withdrawn(d2, row2.id, 'declined');
    await sleep(3000);
    const r2 = await callRow(row2.id);
    const reOffered = [a1, a2].some((a) => a.incoming.filter((p) => String(p.callId) === String(row2.id)).length > 1);
    check('once everyone declined, the call waits and nobody is offered it again', r2.status === 'RINGING' && r2.agent_id == null && !reOffered);
    check('both agents are available after declining', (await availability('agent-1')) === 'AVAILABLE' && (await availability('agent-2')) === 'AVAILABLE');

    await meta.hangUp(c2.id);
    await waitFor(async () => (await callRow(row2.id)).status === 'TERMINATED', 10000, 'call 2 ended');
    check('the waiting call ends when the customer hangs up', (await callRow(row2.id)).terminated_by === 'CUSTOMER');

    // ── 3. A single member who misses the offer gets it again in the next round ──
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN', ring_timeout_seconds: 5 });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }] });
    const c3 = await meta.callIn('wacid.q.3', { from: '96181030853' });
    const row3 = await callByProvider(c3.id);
    await nextIncoming(a1, row3.id);
    await withdrawn(a1, row3.id, 'timeout');
    const again = await waitFor(() => a1.incoming.filter((p) => String(p.callId) === String(row3.id)).length >= 2, 10000, 'second round offer');
    check('a lone member who missed the call is offered it again', Boolean(again) && (await callRow(row3.id)).agent_id === id['agent-1']);
    await meta.hangUp(c3.id);
    await waitFor(async () => (await callRow(row3.id)).status === 'TERMINATED', 10000, 'call 3 ended');
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 8000, 'agent-1 released');

    // ── 4. Max wait: the call overflows to another queue ──
    await api('PUT', '/v1/tenants/demo/queues/overflow', { name: 'Overflow', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/overflow/members', { members: [{ agent_ref: 'agent-2' }] });
    const overflowQueue = (await q("SELECT id FROM queues WHERE external_ref = 'overflow'"))[0];
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN', max_wait_seconds: 5, overflow_queue_ref: 'overflow' });
    await setAvailability(a1, 'OFFLINE');

    const c4 = await meta.callIn('wacid.q.4', { from: '96181030854' });
    const row4 = await callByProvider(c4.id);
    await sleep(1500);
    check('with no member available the call waits in the first queue', (await callRow(row4.id)).queue_id === seed.queue.id);
    const overflowOffer = await nextIncoming(a2, row4.id, 15000);
    const r4 = await callRow(row4.id);
    check('after the max wait the call moves to the overflow queue and its member is offered it',
        r4.queue_id === overflowQueue.id && overflowOffer.agentId === id['agent-2'] && r4.overflow_count === 1);
    check('the overflow is logged', (await lifecycle(row4.id, 'inbound_overflowed')).length === 1);
    await waitFor(() => receiver.events.some((e) => e.callId === row4.id && e.type === 'call.overflowed'), 8000, 'call.overflowed event').catch(() => null);
    check('the consumer is told the call overflowed', receiver.events.some((e) => e.callId === row4.id && e.type === 'call.overflowed'
        && e.body.data.to_queue_id === overflowQueue.id));
    await accept(a2, overflowOffer, 660);
    await waitFor(async () => (await callRow(row4.id)).status === 'IN_PROGRESS', 15000, 'call 4 answered');
    await endByAgent(a2, row4.id);
    await waitFor(async () => (await availability('agent-2')) === 'AVAILABLE', 8000, 'agent-2 released');

    // ── 5. Max wait with nowhere to overflow: the call ends as TIMEOUT ──
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN', max_wait_seconds: 5 });
    const c5 = await meta.callIn('wacid.q.5', { from: '96181030855' });
    const row5 = await callByProvider(c5.id);
    await waitFor(async () => (await callRow(row5.id)).status === 'TERMINATED', 15000, 'call 5 timed out');
    const r5 = await callRow(row5.id);
    check('after the max wait with no overflow the call ends as TIMEOUT', r5.termination_reason === 'TIMEOUT' && r5.terminated_by === 'SYSTEM',
        `${r5.termination_reason}/${r5.terminated_by}`);
    // The terminator commits first and tells the provider a moment later.
    const told = await waitFor(() => meta.calls.some((c) => c.body.call_id === c5.id && ['terminate', 'reject'].includes(c.body.action)), 5000, 'provider end').catch(() => false);
    check('the provider is told to end the call', told);
    await waitFor(() => receiver.events.some((e) => e.callId === row5.id && e.type === 'call.ended'), 8000, 'call.ended').catch(() => null);
    check('the consumer gets call.ended with TIMEOUT', receiver.events.some((e) => e.callId === row5.id && e.type === 'call.ended'
        && e.body.data.call.terminationReason === 'TIMEOUT'));

    for (const a of [a1, a2]) a.socket.close();
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    meta.close(); receiver.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
