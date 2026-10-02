// SIP channel scenarios through the local SIP gateway (drachtio-server +
// rtpengine, deploy/sip-gateway/docker-compose.local.yml) with a fake
// carrier (sipCarrier.mjs): inbound call bridged to an agent with real G.711
// audio, hang-up from either side, a caller who gives up while it rings, an
// unknown number, IVR with in-band DTMF, outbound answered and declined, and
// a queue timeout ending a ringing SIP call.
// run.mjs runs this suite only when the gateway is up.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
    testDb, sleep, makeChecks, waitFor, newPeer, hear, gathered, eventReceiver,
    connectAgent, accept, nextIncoming, api as makeApi, wav,
} from './lib.mjs';
import { sipCarrier } from './sipCarrier.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 3901);
const CALLIO = `http://127.0.0.1:${PORT}`;
const STORAGE = process.env.STORAGE_LOCAL_ROOT;
const DID = '+96170000001';
const { check, summary } = makeChecks();
const api = makeApi(CALLIO, seed.api_key);
const receiver = eventReceiver({ secret: seed.webhook_secret });
const carrier = sipCarrier({ sipPort: Number(process.env.TEST_SIP_CARRIER_PORT || 5070) });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const sipCall = (providerCallId) => waitFor(async () => (await q("SELECT * FROM calls WHERE channel = 'SIP' AND provider_call_id = ?", [providerCallId]))[0], 8000, `SIP call ${providerCallId}`);
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const availability = async (ref) => (await q("SELECT IF(busy_call_id IS NULL, availability, 'ON_CALL') AS availability FROM agents WHERE external_ref = ?", [ref]))[0]?.availability;
const setAvailability = async (agent, value) => {
    agent.socket.emit('agent:availability:set', { availability: value });
    const ok = value === 'AVAILABLE' ? ['AVAILABLE', 'ON_CALL'] : [value];
    await waitFor(async () => ok.includes(await availability(agent.ref)), 5000, `${agent.ref} ${value}`);
};
const carrierHears = async (call, ms = 3000) => { await sleep(1500); call.rtp.ear.reset(); await sleep(ms); return call.rtp.ear; };

await receiver.listen();
await carrier.listen();
let exitCode = 0;

try {
    const a1 = await connectAgent(CALLIO, seed, 'agent-1');
    const a2 = await connectAgent(CALLIO, seed, 'agent-2');
    const id = Object.fromEntries((await q('SELECT id, external_ref FROM agents')).map((r) => [r.external_ref, r.id]));
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }] });
    await setAvailability(a1, 'AVAILABLE');

    // ── 0. The SIP channel through the Management API ──
    const trunkId = (await q("SELECT id FROM sip_trunks WHERE name = 'dev-trunk'"))[0].id;
    const put = await api('PUT', '/v1/tenants/demo/channels/sip-main', { type: 'SIP', display_name: 'SIP line', address: DID, sip_trunk_id: trunkId, inbound_queue_ref: 'main' });
    check('a SIP channel is provisioned through the API with its trunk', put.status === 200 && put.body.channel.sipTrunkId === trunkId && put.body.channel.address === DID, `HTTP ${put.status}`);
    const badTrunk = await api('PUT', '/v1/tenants/demo/channels/sip-other', { type: 'SIP', address: '+96170000002', sip_trunk_id: 999999 });
    check('a trunk the consumer may not use is refused', badTrunk.status === 400, `HTTP ${badTrunk.status}`);

    // ── 1. Inbound: the carrier's call reaches an agent, audio both ways ──
    const c1 = await carrier.callIn({ to: DID, freqs: [440] });
    const row1 = await sipCall(c1.callId);
    check('an inbound SIP call is created on the SIP channel, caller as E.164', row1.channel === 'SIP'
        && row1.customer_address === '+96181030841' && row1.customer_address_type === 'E164' && row1.queue_id === seed.queue.id,
        `customer=${row1.customer_address}`);
    check('the carrier hears ringing while the call waits for an agent', c1.responses.includes(180));
    const offer1 = await nextIncoming(a1, row1.id);
    check('the call is offered to the agent', offer1.agentId === id['agent-1'] && offer1.channel === 'SIP');
    await accept(a1, offer1, 880);
    await c1.answered;
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 15000, 'SIP call answered');
    check('accepting answers the carrier (200 OK, ACK)', Boolean(c1.answeredAt));
    const agentEar1 = await hear(await a1.peer.received);
    check('the agent hears the caller (440 Hz over G.711)', agentEar1.dominant() === 440, `tone=${agentEar1.dominant()} rms=${agentEar1.rms()}`);
    const callerEar1 = await carrierHears(c1);
    check('the caller hears the agent (880 Hz over G.711)', callerEar1.dominant() === 880, `tone=${callerEar1.dominant()} packets=${callerEar1.stats.packets}`);

    a1.socket.emit('call:terminate', { callId: row1.id });
    await waitFor(() => c1.ended === 'remote', 10000, 'BYE to the carrier');
    await waitFor(async () => (await callRow(row1.id)).status === 'TERMINATED', 10000, 'SIP call 1 ended');
    await sleep(1000);
    const end1 = await callRow(row1.id);
    check('an agent hang-up sends BYE to the carrier; the call is COMPLETED/AGENT with its duration',
        end1.termination_reason === 'COMPLETED' && end1.terminated_by === 'AGENT' && end1.call_duration >= 5,
        `${end1.termination_reason}/${end1.terminated_by} duration=${end1.call_duration}s`);
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 8000, 'agent-1 released');
    a1.peer?.close(); a1.peer = null;

    // ── 2. The caller hangs up (BYE from the carrier) ──
    const c2 = await carrier.callIn({ from: '+96181030842', to: DID });
    const row2 = await sipCall(c2.callId);
    await accept(a1, await nextIncoming(a1, row2.id), 880);
    await c2.answered;
    await waitFor(async () => (await callRow(row2.id)).status === 'IN_PROGRESS', 15000, 'SIP call 2 answered');
    await sleep(2000);
    await carrier.hangUp(c2);
    await waitFor(async () => (await callRow(row2.id)).status === 'TERMINATED', 10000, 'SIP call 2 ended');
    const end2 = await callRow(row2.id);
    check('a caller hang-up ends the call COMPLETED/CUSTOMER', end2.termination_reason === 'COMPLETED' && end2.terminated_by === 'CUSTOMER',
        `${end2.termination_reason}/${end2.terminated_by}`);
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 8000, 'agent-1 released after BYE');
    check('the agent is released when the caller hangs up', true);
    a1.peer?.close(); a1.peer = null;

    // ── 3. The caller gives up while it rings (CANCEL) ──
    await setAvailability(a1, 'OFFLINE');
    const c3 = await carrier.callIn({ from: '+96181030843', to: DID });
    const row3 = await sipCall(c3.callId);
    await sleep(1000);
    await carrier.cancel(c3);
    await waitFor(async () => (await callRow(row3.id)).status === 'TERMINATED', 10000, 'SIP call 3 cancelled');
    const end3 = await callRow(row3.id);
    check('a CANCEL while waiting ends the call by the customer, unanswered', end3.terminated_by === 'CUSTOMER'
        && ['CANCELLED', 'NO_ANSWER'].includes(end3.termination_reason) && end3.answered_at == null, `${end3.termination_reason}/${end3.terminated_by}`);

    // ── 4. A number nobody has ──
    const c4 = await carrier.callIn({ to: '+96170009999' });
    const status4 = await c4.answered.then(() => 200, (err) => err.status);
    check('a call to an unknown number is refused (404)', status4 === 404, `status=${status4}`);

    // ── 5. A queue timeout ends a ringing SIP call; the carrier is told ──
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN', max_wait_seconds: 5 });
    const c5 = await carrier.callIn({ from: '+96181030845', to: DID });
    const row5 = await sipCall(c5.callId);
    const status5 = await c5.answered.then(() => 200, (err) => err.status);
    const end5 = await callRow(row5.id);
    check('max wait ends the ringing SIP call as TIMEOUT and the carrier gets a final error', end5.termination_reason === 'TIMEOUT'
        && status5 >= 400, `${end5.termination_reason} status=${status5}`);
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });

    // ── 6. IVR with in-band DTMF from the carrier ──
    mkdirSync(STORAGE, { recursive: true });
    writeFileSync(`${STORAGE}/sip-prompt.wav`, wav(600, 1));
    const asset = await api('POST', '/v1/tenants/demo/audio-assets', { name: 'SIP menu prompt', storage_provider: 'LOCAL', storage_key: 'sip-prompt.wav', mime_type: 'audio/wav' });
    const flow = await api('PUT', '/v1/tenants/demo/ivr-flows/sip-menu', {
        name: 'SIP menu', channel_ref: 'sip-main', status: 'ACTIVE', trigger_condition: 'ALWAYS',
        structure: {
            nodes: [
                { id: 'start', type: 'ivr_start', data: {} },
                { id: 'menu', type: 'ivr_menu', data: { label: 'Main', audioFileId: asset.body.audioAsset.id, timeoutSeconds: 8 } },
                { id: 'agents', type: 'ivr_transfer', data: { targetType: 'queue' } },
            ],
            edges: [{ source: 'start', target: 'menu' }, { source: 'menu', target: 'agents', sourceHandle: '1' }],
        },
    });
    check('an IVR flow is set up on the SIP channel', flow.status === 200);
    await setAvailability(a1, 'AVAILABLE');
    const c6 = await carrier.callIn({ from: '+96181030846', to: DID, freqs: [440] });
    const row6 = await sipCall(c6.callId);
    await c6.answered;
    check('the IVR answers the SIP call itself', row6.ivr_flow_id === flow.body.ivrFlow.id && Boolean(c6.answeredAt));
    // Press "1" (in-band) once the menu is listening, i.e. after its prompt.
    await waitFor(async () => (await q('SELECT id FROM ivr_sessions WHERE call_id = ?', [row6.id]))[0], 15000, 'IVR session');
    await sleep(2000);
    c6.rtp.tone([697, 1209]);
    await sleep(400);
    c6.rtp.tone([440]);
    const offer6 = await nextIncoming(a1, row6.id, 15000);
    check('pressing 1 over the SIP line transfers the call to the queue', offer6.agentId === id['agent-1']);
    await accept(a1, offer6, 880);
    await waitFor(async () => { const r = await callRow(row6.id); return r.status === 'IN_PROGRESS' && r.state === 'ACTIVE'; }, 15000, 'IVR SIP call answered');
    const callerEar6 = await carrierHears(c6);
    check('after IVR the caller is bridged to the agent', callerEar6.dominant() === 880, `tone=${callerEar6.dominant()}`);
    a1.socket.emit('call:terminate', { callId: row6.id });
    await waitFor(async () => (await callRow(row6.id)).status === 'TERMINATED', 10000, 'IVR SIP call ended');
    a1.peer?.close(); a1.peer = null;

    // The caller gives up while waiting for an agent after the IVR: the IVR
    // answered the call, but no agent did — not COMPLETED.
    const c6b = await carrier.callIn({ from: '+96181030847', to: DID, freqs: [440] });
    const row6b = await sipCall(c6b.callId);
    await c6b.answered;
    await waitFor(async () => (await q('SELECT id FROM ivr_sessions WHERE call_id = ?', [row6b.id]))[0], 15000, 'IVR session');
    await sleep(2000);
    c6b.rtp.tone([697, 1209]);
    await sleep(400);
    c6b.rtp.tone([440]);
    await nextIncoming(a1, row6b.id, 15000);
    await sleep(6000);                      // ringing the agent, unanswered
    await carrier.hangUp(c6b);
    await waitFor(async () => (await callRow(row6b.id)).status === 'TERMINATED', 10000, 'abandoned IVR call ended');
    const end6b = await callRow(row6b.id);
    check('a caller who hangs up while waiting after the IVR is NO_ANSWER, not COMPLETED',
        end6b.termination_reason === 'NO_ANSWER' && end6b.terminated_by === 'CUSTOMER', `${end6b.termination_reason}/${end6b.terminated_by}`);

    await api('PUT', '/v1/tenants/demo/ivr-flows/sip-menu', { name: 'SIP menu', channel_ref: 'sip-main', status: 'INACTIVE',
        structure: { nodes: [{ id: 'start', type: 'ivr_start', data: {} }], edges: [] } });

    // ── 7. Outbound through the trunk ──
    const startOutbound = async (agent, address, freq) => {
        const intent = await api('POST', '/v1/tenants/demo/calls', { channel_ref: 'sip-main', agent_ref: agent.ref, customer: { address } });
        const callId = intent.body.call.callId;
        agent.peer = newPeer(freq);
        await agent.peer.pc.setLocalDescription(await agent.peer.pc.createOffer());
        await gathered(agent.peer.pc);
        const started = new Promise((resolve) => agent.socket.once('call:started', resolve));
        agent.socket.emit('call:start', { callId, sdpOffer: agent.peer.pc.localDescription.sdp });
        const payload = await Promise.race([started, sleep(8000).then(() => null)]);
        await agent.peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdpAnswer });
        for (const c of agent.pendingCandidates.splice(0)) await agent.peer.pc.addIceCandidate(c).catch(() => { });
        return { intent, callId };
    };
    await setAvailability(a2, 'OFFLINE');
    const out = await startOutbound(a2, '+96181030999', 660);
    check('an outbound call intent on the SIP channel is accepted', out.intent.status === 201);
    const answered7 = await carrier.answerNext({ ringMs: 800, freqs: [440] });
    check('Callio dials the customer through the trunk', answered7.to === '96181030999', `to=${answered7.to}`);
    const row7 = await waitFor(async () => { const r = await callRow(out.callId); return r.status === 'IN_PROGRESS' ? r : null; }, 15000, 'outbound SIP answered');
    check('the carrier ringing and answering move the call to IN_PROGRESS', Boolean(row7.provider_call_id) && row7.ringing_at != null);
    const agentEar7 = await hear(await a2.peer.received);
    const callerEar7 = await carrierHears(answered7);
    check('outbound: the agent and the customer hear each other', agentEar7.dominant() === 440 && callerEar7.dominant() === 660,
        `agent=${agentEar7.dominant()} customer=${callerEar7.dominant()}`);
    a2.socket.emit('call:terminate', { callId: out.callId });
    await waitFor(() => answered7.ended === 'remote', 10000, 'BYE to the customer');
    await waitFor(async () => (await callRow(out.callId)).status === 'TERMINATED', 10000, 'outbound SIP ended');
    check('hanging up an outbound SIP call sends BYE', true);
    a2.peer?.close(); a2.peer = null;
    await waitFor(async () => (await availability('agent-2')) === 'OFFLINE', 8000, 'agent-2 offline');

    // ── 8. Outbound declined by the customer (486) ──
    const out8 = await startOutbound(a2, '+96181030998', 660);
    await carrier.answerNext({ ringMs: 300, decline: 486 });
    await waitFor(async () => ['TERMINATED', 'FAILED'].includes((await callRow(out8.callId)).status), 10000, 'declined outbound ended');
    const end8 = await callRow(out8.callId);
    check('a 486 from the customer ends the outbound call REJECTED/CUSTOMER', end8.termination_reason === 'REJECTED' && end8.terminated_by === 'CUSTOMER',
        `${end8.termination_reason}/${end8.terminated_by}`);
    a2.peer?.close(); a2.peer = null;

    await waitFor(() => receiver.events.some((e) => e.callId === row1.id && e.type === 'call.ended'), 8000, 'call.ended').catch(() => null);
    check('consumers get the same events for SIP calls', ['call.created', 'call.assigned', 'call.answered', 'call.ended']
        .every((t) => receiver.events.some((e) => e.callId === row1.id && e.type === t)));

    for (const a of [a1, a2]) a.socket.close();
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    carrier.close(); receiver.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
