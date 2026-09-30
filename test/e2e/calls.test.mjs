// Core call flows with real WebRTC media on both legs: agent auth, inbound
// routing and bridging, agent hang-up, outbound intent → call:start → dial,
// API terminate, call detail, consumer events, a dial the provider refuses,
// isolation.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync } from 'fs';
import { io } from 'socket.io-client';
import {
    testDb, sleep, makeChecks, waitFor, newPeer, hear, gathered, fakeMeta, eventReceiver,
    connectAgent, accept, nextIncoming, api as makeApi, UNREACHABLE_NUMBER,
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
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const availability = async (ref) => (await q('SELECT availability FROM agents WHERE external_ref = ?', [ref]))[0]?.availability;

await meta.listen();
await receiver.listen();
let exitCode = 0;

try {
    const refused = await new Promise((resolve) => {
        const s = io(CALLIO, { transports: ['websocket'], auth: { token: 'nope' }, reconnection: false });
        s.on('connect_error', (e) => { s.close(); resolve(e.message); });
        s.on('connect', () => { s.close(); resolve(null); });
    });
    check('agent socket rejects an invalid token', /Authentication failed/.test(refused ?? ''), refused);

    const a1 = await connectAgent(CALLIO, seed, 'agent-1');
    const a2 = await connectAgent(CALLIO, seed, 'agent-2');
    const id = Object.fromEntries((await q('SELECT id, external_ref FROM agents')).map((r) => [r.external_ref, r.id]));
    check('agents connect with consumer-signed JWTs', true);
    const ready = a1.events.find((e) => e.event === 'session:ready')?.payload
        ?? await waitFor(() => a1.events.find((e) => e.event === 'session:ready')?.payload, 5000, 'session:ready');
    check('session:ready gives the agent its identity and ICE servers',
        ready.protocol === 1 && ready.agent.ref === 'agent-1' && ready.agent.id === id['agent-1']
        && ready.deviceId === 'agent-1-device' && Array.isArray(ready.iceServers) && ready.iceServers.length > 0,
        `iceServers=${ready.iceServers?.length}`);

    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }, { agent_ref: 'agent-2' }] });
    a1.socket.emit('agent:availability:set', { availability: 'AVAILABLE' });
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 5000, 'agent-1 available');
    await sleep(300);
    a2.socket.emit('agent:availability:set', { availability: 'AVAILABLE' });
    await waitFor(async () => (await availability('agent-2')) === 'AVAILABLE', 5000, 'agent-2 available');
    check('agents set themselves AVAILABLE over the socket', true);

    // ── Inbound ──
    const c1 = await meta.callIn('wacid.in.1');
    check('forwarded Meta webhook is accepted', c1.status === 200, `HTTP ${c1.status}`);
    const inCall = await waitFor(async () => (await q('SELECT * FROM calls WHERE provider_call_id = ?', [c1.id]))[0], 5000, 'inbound row');
    check("inbound call row created on the channel's queue", inCall.queue_id === seed.queue.id && inCall.channel === 'WHATSAPP'
        && inCall.customer_address === '+96181030841' && inCall.customer_name === 'Test Customer',
        `queue=${inCall.queue_id} customer=${inCall.customer_address} (${inCall.customer_name})`);

    const offer = await nextIncoming(a1, inCall.id);
    check('ROUND_ROBIN offers the call to the longest-available agent', offer.agentId === id['agent-1']);
    await accept(a1, offer, 880);
    await waitFor(async () => (await callRow(inCall.id)).status === 'IN_PROGRESS', 15000, 'inbound answered');

    const custHears = await hear(await c1.customer.received);
    const agentHears = await (await a1.peer.received);
    check('customer hears the agent (bridged 880 Hz)', custHears.dominant() === 880, `tone=${custHears.dominant()} rms=${custHears.rms()}`);
    check('agent hears the customer (bridged 440 Hz)', agentHears.dominant() === 440, `tone=${agentHears.dominant()} rms=${agentHears.rms()}`);
    check('the answering agent is ON_CALL, the other still AVAILABLE',
        (await availability('agent-1')) === 'ON_CALL' && (await availability('agent-2')) === 'AVAILABLE');

    // ── The agent moves the call to their other device ──
    const a1b = await connectAgent(CALLIO, seed, 'agent-1', 'AGENT', 'agent-1-phone');
    a1b.peer = newPeer(660);
    await a1b.peer.pc.setLocalDescription(await a1b.peer.pc.createOffer());
    await gathered(a1b.peer.pc);
    a1b.socket.emit('call:reconnect', { callId: inCall.id, sdpOffer: a1b.peer.pc.localDescription.sdp });
    const reconnected = await waitFor(() => a1b.events.find((e) => e.event === 'call:reconnected')?.payload, 10000, 'call:reconnected');
    await a1b.peer.pc.setRemoteDescription({ type: 'answer', sdp: reconnected.sdpAnswer });
    for (const c of a1b.pendingCandidates.splice(0)) await a1b.peer.pc.addIceCandidate(c).catch(() => { });
    const superseded = await waitFor(() => a1.events.find((e) => e.event === 'call:connection_superseded'), 5000, 'superseded').catch(() => null);
    check('the answer goes only to the device that reconnected; the other is told it lost the call',
        reconnected.deviceId === 'agent-1-phone' && Boolean(superseded) && !a1.events.some((e) => e.event === 'call:reconnected'));
    const custHearsPhone = await hear(await c1.customer.received);
    check('after the switch the customer hears the new device', custHearsPhone.dominant() === 660, `tone=${custHearsPhone.dominant()}`);
    a1.peer.close(); a1.peer = a1b.peer;

    a1b.socket.emit('call:terminate', { callId: inCall.id });
    await waitFor(async () => (await callRow(inCall.id)).status === 'TERMINATED', 10000, 'inbound ended');
    await sleep(1500);
    const ended = await callRow(inCall.id);
    check('agent hang-up terminates the call (terminated_by AGENT, COMPLETED)',
        ended.terminated_by === 'AGENT' && ended.termination_reason === 'COMPLETED', `duration=${ended.call_duration}s`);
    check("provider was told to terminate, with the channel's credentials",
        meta.calls.some((c) => c.body.action === 'terminate' && c.body.call_id === c1.id) && meta.calls.every((c) => c.auth === 'Bearer fake-token'));
    check('agent released back to AVAILABLE after the inbound call', (await availability('agent-1')) === 'AVAILABLE');
    a1.peer.close(); a1.peer = null;

    // ── Outbound ──
    const intent = await api('POST', '/v1/tenants/demo/calls', {
        channel_ref: 'whatsapp-main', agent_ref: 'agent-2',
        customer: { address: '+96181030841', name: 'Outbound Customer' }, external_ref: 'crm-call-42',
    });
    check('Management API creates an outbound call intent', intent.status === 201 && intent.body.call?.status === 'INITIATED', `HTTP ${intent.status}`);
    const outId = intent.body.call.callId;

    a2.peer = newPeer(880);
    await a2.peer.pc.setLocalDescription(await a2.peer.pc.createOffer());
    await gathered(a2.peer.pc);
    const started = new Promise((resolve) => a2.socket.once('call:started', resolve));
    a2.socket.emit('call:start', { callId: outId, sdpOffer: a2.peer.pc.localDescription.sdp });
    const startedPayload = await Promise.race([started, sleep(8000).then(() => null)]);
    check('agent starts the outbound call with call:start', Boolean(startedPayload?.sdpAnswer));
    await a2.peer.pc.setRemoteDescription({ type: 'answer', sdp: startedPayload.sdpAnswer });
    for (const c of a2.pendingCandidates.splice(0)) await a2.peer.pc.addIceCandidate(c).catch(() => { });

    const outRow = await waitFor(async () => { const r = await callRow(outId); return r.status === 'IN_PROGRESS' ? r : null; }, 15000, 'outbound answered');
    check('outbound call dialed through the channel and answered', Boolean(outRow.provider_call_id), `provider_call_id=${outRow.provider_call_id}`);
    const outCust = await hear(await meta.customers.get(outRow.provider_call_id).received);
    const outAgent = await a2.peer.received;
    check('outbound: customer hears the agent (880 Hz)', outCust.dominant() === 880, `tone=${outCust.dominant()}`);
    check('outbound: agent hears the customer (440 Hz)', outAgent.dominant() === 440, `tone=${outAgent.dominant()}`);

    const term = await api('POST', `/v1/calls/${outId}/terminate`);
    check('Management API accepts a terminate request', term.status === 202, `HTTP ${term.status}`);
    await waitFor(async () => (await callRow(outId)).status === 'TERMINATED', 10000, 'outbound ended');
    await waitFor(async () => (await availability('agent-2')) === 'OFFLINE', 5000, 'agent-2 offline');
    check('outbound call ended; agent goes OFFLINE after an outbound call', true);
    a2.peer.close(); a2.peer = null;

    const detail = await api('GET', `/v1/calls/${inCall.id}`);
    check('call detail API returns legs, lifecycle events and the final state',
        detail.body.call?.status === 'TERMINATED' && detail.body.legs?.length >= 2 && detail.body.events?.length >= 3,
        `legs=${detail.body.legs?.map((l) => l.type).join(',')}`);

    // ── Consumer events ──
    await waitFor(() => receiver.events.some((e) => e.callId === outId && e.type === 'call.ended'), 15000, 'call.ended delivered');
    const types = (callId) => receiver.events.filter((e) => e.callId === callId).map((e) => e.type);
    check('consumer received inbound events', ['call.created', 'call.assigned', 'call.answered', 'call.ended'].every((t) => types(inCall.id).includes(t)), types(inCall.id).join(','));
    check('consumer received outbound events', ['call.created', 'call.answered', 'call.ended'].every((t) => types(outId).includes(t)), types(outId).join(','));
    check('every event is signed and delivered once per id',
        receiver.events.every((e) => e.validSignature) && new Set(receiver.events.map((e) => e.eventId)).size === receiver.events.length
        && receiver.events.filter((e) => e.type === 'call.ended').length === 2);
    const endedEvent = receiver.events.find((e) => e.callId === outId && e.type === 'call.ended');
    check("events carry the consumer's refs", endedEvent?.body?.tenant_ref === 'demo'
        && endedEvent?.body?.data?.call?.externalRef === 'crm-call-42' && endedEvent?.body?.data?.call?.agentRef === 'agent-2');

    // ── Outbound the provider refuses to dial ──
    const refusedIntent = await api('POST', '/v1/tenants/demo/calls', {
        channel_ref: 'whatsapp-main', agent_ref: 'agent-2', customer: { address: `+${UNREACHABLE_NUMBER}` },
    });
    check('an outbound intent to an unreachable number is created', refusedIntent.status === 201, `HTTP ${refusedIntent.status}`);
    const refusedId = refusedIntent.body.call.callId;
    a2.peer = newPeer(880);
    await a2.peer.pc.setLocalDescription(await a2.peer.pc.createOffer());
    await gathered(a2.peer.pc);
    a2.errors.length = 0;
    a2.socket.emit('call:start', { callId: refusedId, sdpOffer: a2.peer.pc.localDescription.sdp });
    const refusedRow = await waitFor(async () => { const r = await callRow(refusedId); return r.status === 'FAILED' ? r : null; }, 15000, 'refused outbound failed');
    check('a dial the provider refuses ends FAILED / PROVIDER_TRIGGER_FAILED / PROVIDER',
        refusedRow.termination_reason === 'PROVIDER_TRIGGER_FAILED' && refusedRow.terminated_by === 'PROVIDER',
        `${refusedRow.termination_reason}/${refusedRow.terminated_by}`);
    check('the agent is told why (call:error PROVIDER_TRIGGER_FAILED)', a2.errors.some((e) => e.callId === refusedId && e.code === 'PROVIDER_TRIGGER_FAILED'),
        JSON.stringify(a2.errors));
    await waitFor(async () => (await availability('agent-2')) === 'OFFLINE', 5000, 'agent-2 offline after the failed dial');
    a2.peer.close(); a2.peer = null;

    // ── Isolation ──
    const foreign = await meta.post({ metadata: { phone_number_id: '999999' }, calls: [{ id: 'x', event: 'terminate' }] });
    check('webhooks for a line nobody owns are ignored', foreign === 200);
    const wrongKey = await fetch(`${CALLIO}/v1/calls/${inCall.id}`, { headers: { Authorization: 'Bearer ck_wrong' } });
    check('Management API rejects a wrong key', wrongKey.status === 401);

    a1.socket.close(); a2.socket.close(); a1b.socket.close();
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    meta.close(); receiver.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
