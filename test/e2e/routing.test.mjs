// Routing scenarios: queue wait + drain, customer hang-up, PRIORITY, RING_ALL
// with a decline, transfer, supervisor monitoring, IVR with in-band DTMF.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
    testDb, sleep, makeChecks, waitFor, newPeer, hear, gathered, fakeMeta, eventReceiver,
    connectAgent, accept, nextIncoming, api as makeApi, wav,
} from './lib.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 3901);
const CALLIO = `http://127.0.0.1:${PORT}`;
const STORAGE = process.env.STORAGE_LOCAL_ROOT;
const { check, summary } = makeChecks();
const api = makeApi(CALLIO, seed.api_key);
const meta = fakeMeta({ callioUrl: CALLIO, apiKey: seed.api_key, phoneNumberId: '111222333' });
const receiver = eventReceiver({ secret: seed.webhook_secret });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const callByProvider = (id) => waitFor(async () => (await q('SELECT * FROM calls WHERE provider_call_id = ?', [id]))[0], 8000, `call ${id}`);
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const availability = async (ref) => (await q('SELECT availability FROM agents WHERE external_ref = ?', [ref]))[0]?.availability;
const setAvailable = async (agent, value = 'AVAILABLE') => {
    agent.socket.emit('agent:availability:set', { availability: value });
    // Going AVAILABLE with a call waiting claims the agent at once (ON_CALL).
    const ok = value === "AVAILABLE" ? ["AVAILABLE", "ON_CALL"] : [value];
    await waitFor(async () => ok.includes(await availability(agent.ref)), 5000, `${agent.ref} ${value}`);
};
const queue = (strategy, members) => Promise.all([
    api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy }),
    api('PUT', '/v1/tenants/demo/queues/main/members', { members }),
]);
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
    const sup = await connectAgent(CALLIO, seed, 'sup-1', 'SUPERVISOR');
    const id = Object.fromEntries((await q("SELECT id, external_ref FROM agents")).map((r) => [r.external_ref, r.id]));

    // ── 1. Nobody available: the call waits, then drains to the first agent who frees up ──
    await queue('ROUND_ROBIN', [{ agent_ref: 'agent-1' }, { agent_ref: 'agent-2' }]);
    const c1 = await meta.callIn('wacid.r.1');
    const row1 = await callByProvider(c1.id);
    await sleep(1000);
    const waiting = await callRow(row1.id);
    check('with no agent available the call waits in its queue', waiting.status === 'RINGING' && waiting.agent_id == null && waiting.queue_id === seed.queue.id);

    await setAvailable(a2);
    const offer1 = await nextIncoming(a2, row1.id);
    check('the call is offered to the agent who became available', offer1.agentId === id['agent-2'] && offer1.assignmentType === 'QUEUED');
    await accept(a2, offer1, 660);
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 15000, 'call 1 answered');
    const heard1 = await hear(await c1.customer.received);
    check('customer is bridged to that agent', heard1.dominant() === 660, `tone=${heard1.dominant()}`);

    await meta.hangUp(c1.id);
    await waitFor(async () => (await callRow(row1.id)).status === 'TERMINATED', 10000, 'call 1 ended');
    const end1 = await callRow(row1.id);
    check('customer hang-up ends the call (terminated_by CUSTOMER, COMPLETED)', end1.terminated_by === 'CUSTOMER' && end1.termination_reason === 'COMPLETED',
        `${end1.termination_reason}/${end1.terminated_by} duration=${end1.call_duration}s`);
    await waitFor(async () => (await availability('agent-2')) === 'AVAILABLE', 8000, 'agent-2 released');
    check('the agent is released after the customer hangs up', true);
    a2.peer?.close(); a2.peer = null;
    check('consumer got call.queued then call.assigned', ['call.queued', 'call.assigned'].every((t) =>
        receiver.events.some((e) => e.callId === row1.id && e.type === t)) || await waitFor(() => ['call.queued', 'call.assigned'].every((t) =>
        receiver.events.some((e) => e.callId === row1.id && e.type === t)), 8000, 'queued/assigned events'));

    // ── 2. PRIORITY: the lowest priority number is offered first ──
    await queue('PRIORITY', [{ agent_ref: 'agent-1', priority: 2 }, { agent_ref: 'agent-2', priority: 1 }]);
    await setAvailable(a1);
    const c2 = await meta.callIn('wacid.r.2', { from: '96181030842' });
    const row2 = await callByProvider(c2.id);
    const offer2 = await nextIncoming(a2, row2.id);
    check('PRIORITY offers the call to the priority-1 member', offer2.agentId === id['agent-2']);
    await accept(a2, offer2, 660);
    await waitFor(async () => (await callRow(row2.id)).status === 'IN_PROGRESS', 15000, 'call 2 answered');
    check('the priority-2 member was not offered it', !a1.incoming.some((p) => p.callId === row2.id));
    await endByAgent(a2, row2.id);
    await waitFor(async () => (await availability('agent-2')) === 'AVAILABLE', 8000, 'agent-2 released');

    // ── 3. RING_ALL: offered to everyone; a decline leaves the others ringing ──
    await queue('RING_ALL', [{ agent_ref: 'agent-1' }, { agent_ref: 'agent-2' }]);
    const c3 = await meta.callIn('wacid.r.3', { from: '96181030843' });
    const row3 = await callByProvider(c3.id);
    const [offer3a, offer3b] = await Promise.all([nextIncoming(a1, row3.id), nextIncoming(a2, row3.id)]);
    check('RING_ALL offers the call to every available member at once', offer3a.agentId == null && offer3b.agentId == null
        && offer3a.offeredAgentIds.length === 2, `offered=${offer3a.offeredAgentIds}`);

    a2.socket.emit('call:reject', { callId: row3.id });
    await waitFor(() => a2.events.some((e) => e.event === 'call:offer_withdrawn' && e.payload.callId === row3.id), 5000, 'offer withdrawn');
    await sleep(500);
    check('a decline only withdraws the offer for that agent', (await callRow(row3.id)).status === 'RINGING');

    await accept(a1, offer3a, 880);
    await waitFor(async () => (await callRow(row3.id)).status === 'IN_PROGRESS', 15000, 'call 3 answered');
    const r3 = await callRow(row3.id);
    check('the first agent to accept claims the call', r3.agent_id === id['agent-1'] && (await availability('agent-1')) === 'ON_CALL');
    const taken = await waitFor(() => a2.events.find((e) => e.event === 'call:offer_withdrawn' && e.payload.callId === row3.id && e.payload.reason === 'taken'), 5000, 'taken withdrawal').catch(() => null);
    check('the other members are told the offer was taken', Boolean(taken));
    const cust3 = await c3.customer.received;
    await hear(cust3);
    check('customer is bridged to the accepting agent', cust3.dominant() === 880, `tone=${cust3.dominant()}`);

    // ── 4. Supervisor monitoring ──
    sup.peer = newPeer([], { audioLines: 2 });
    await sup.peer.pc.setLocalDescription(await sup.peer.pc.createOffer());
    await gathered(sup.peer.pc);
    const monitorStarted = new Promise((resolve) => sup.socket.once('call:monitor:started', resolve));
    sup.socket.emit('call:monitor', { callId: row3.id, sdpOffer: sup.peer.pc.localDescription.sdp });
    const started = await Promise.race([monitorStarted, sleep(8000).then(() => null)]);
    check('supervisor can start monitoring', Boolean(started?.sdpAnswer));
    await sup.peer.pc.setRemoteDescription({ type: 'answer', sdp: started.sdpAnswer });
    for (const c of sup.pendingCandidates.splice(0)) await sup.peer.pc.addIceCandidate(c).catch(() => { });
    await waitFor(() => sup.peer.tracks.length >= 2, 8000, "both monitor tracks");
    await sleep(2000);
    sup.peer.tracks.forEach((t) => t.reset());
    await sleep(3000);
    const tones = sup.peer.tracks.map((t) => t.dominant());
    check('supervisor hears the customer and the agent on separate tracks', tones.includes(440) && tones.includes(880), `tracks=${tones.join(",")}`);

    const agentMonitor = await new Promise((resolve) => {
        a2.socket.emit('call:monitor', { callId: row3.id, sdpOffer: sup.peer.pc.localDescription.sdp });
        a2.socket.once('call:error', resolve);
        setTimeout(() => resolve(null), 3000);
    });
    check('a plain agent cannot monitor calls', agentMonitor?.message?.includes('supervisor'), agentMonitor?.message);
    sup.socket.emit('call:monitor:stop', { callId: row3.id });
    sup.peer.close(); sup.peer = null;

    // ── 5. Transfer to another agent ──
    await sleep(500);
    const outsider = await new Promise((resolve) => {
        a2.socket.emit('call:transfer', { callId: row3.id, agentId: id['agent-2'] });
        a2.socket.once('call:error', resolve);
        setTimeout(() => resolve(null), 3000);
    });
    check('an agent not on the call cannot transfer it', Boolean(outsider), outsider?.message);

    await setAvailable(a2);
    a1.socket.emit('call:transfer', { callId: row3.id, agentId: id['agent-2'] });
    const xfer = await nextIncoming(a2, row3.id, 10000, (p) => p.assignmentType === 'TRANSFERRED');
    check('the target agent is offered the transferred call', xfer.transferredFrom?.id === id['agent-1']);
    await accept(a2, xfer, 660);
    await waitFor(async () => (await callRow(row3.id)).agent_id === id['agent-2'], 10000, 'call moved to agent-2');
    const cust3b = await c3.customer.received;
    await hear(cust3b, 3000, 3000);
    check('after the transfer the customer hears the new agent', cust3b.dominant() === 660, `tone=${cust3b.dominant()}`);
    const logs = await q('SELECT * FROM call_transfer_logs WHERE call_id = ?', [row3.id]);
    check('the transfer is logged and the previous agent released', logs.length === 1 && logs[0].from_agent_id === id['agent-1']
        && logs[0].to_agent_id === id['agent-2'] && (await availability('agent-1')) === 'AVAILABLE');
    a1.peer?.close(); a1.peer = null;
    await endByAgent(a2, row3.id);

    // ── 6. IVR with an in-band DTMF key press ──
    mkdirSync(STORAGE, { recursive: true });
    writeFileSync(`${STORAGE}/prompt.wav`, wav(600, 1));
    const asset = await api('POST', '/v1/tenants/demo/audio-assets', { name: 'Main menu prompt', storage_provider: 'LOCAL', storage_key: 'prompt.wav', mime_type: 'audio/wav' });
    check('audio asset registered through the API', asset.status === 201, `HTTP ${asset.status}`);
    const flow = await api('PUT', '/v1/tenants/demo/ivr-flows/main-menu', {
        name: 'Main menu', channel_ref: 'whatsapp-main', status: 'ACTIVE', trigger_condition: 'ALWAYS',
        structure: {
            nodes: [
                { id: 'start', type: 'ivr_start', data: {} },
                { id: 'menu', type: 'ivr_menu', data: { label: 'Main', audioFileId: asset.body.audioAsset.id, timeoutSeconds: 8 } },
                { id: 'agents', type: 'ivr_transfer', data: { targetType: 'queue' } },
            ],
            edges: [{ source: 'start', target: 'menu' }, { source: 'menu', target: 'agents', sourceHandle: '1' }],
        },
    });
    check('IVR flow created through the API', flow.status === 200 && flow.body.ivrFlow.status === 'ACTIVE');
    await queue('ROUND_ROBIN', [{ agent_ref: 'agent-1' }, { agent_ref: 'agent-2' }]);
    await waitFor(async () => (await availability('agent-2')) === 'AVAILABLE', 8000, 'agent-2 released');

    const c6 = await meta.callIn('wacid.r.6', { from: '96181030846' });
    const row6 = await callByProvider(c6.id);
    check('the IVR flow takes the call first', row6.ivr_flow_id === flow.body.ivrFlow.id && row6.state === 'IVR');
    await waitFor(() => sup.events.some((e) => e.event === 'call:ivr_state' && e.payload.callId === row6.id && e.payload.nodeType === 'ivr_menu'), 15000, 'menu node');
    check('the provider call was auto-accepted for IVR', meta.calls.some((c) => c.body.action === 'accept' && c.body.call_id === c6.id));
    await sleep(2000); // prompt plays, then the menu listens
    c6.customer.tone.set([697, 1209]); // DTMF "1"
    await sleep(400);
    c6.customer.tone.set([440]);

    const offer6 = await waitFor(() => [...a1.incoming, ...a2.incoming].find((p) => p.callId === row6.id && p.sdpOffer), 15000, 'IVR transfer to an agent');
    const agent6 = offer6.agentId === id['agent-1'] ? a1 : a2;
    check('pressing 1 transfers the call to the queue, and an agent is offered it', Boolean(offer6.agentId));
    await accept(agent6, offer6, agent6 === a1 ? 880 : 660);
    await waitFor(async () => (await callRow(row6.id)).status === 'IN_PROGRESS' && (await callRow(row6.id)).state === 'ACTIVE', 15000, 'IVR call answered');
    const cust6 = await c6.customer.received;
    await hear(cust6);
    check('after IVR the customer is bridged to the agent', cust6.dominant() === (agent6 === a1 ? 880 : 660), `tone=${cust6.dominant()}`);
    const session = (await q('SELECT * FROM ivr_sessions WHERE call_id = ?', [row6.id]))[0];
    const inputs = session ? await q('SELECT * FROM ivr_session_inputs WHERE ivr_session_id = ?', [session.id]) : [];
    check('the IVR session and the key press are recorded', session?.outcome === 'transferred' && inputs.some((i) => i.input === '1'),
        `outcome=${session?.outcome} inputs=${inputs.map((i) => i.input).join(',')}`);
    await endByAgent(agent6, row6.id);
    await api('PUT', '/v1/tenants/demo/ivr-flows/main-menu', { ...flow.body.ivrFlow, name: 'Main menu', status: 'INACTIVE',
        structure: { nodes: [{ id: 'start', type: 'ivr_start', data: {} }], edges: [] } });

    for (const a of [a1, a2, sup]) a.socket.close();
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    meta.close(); receiver.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
