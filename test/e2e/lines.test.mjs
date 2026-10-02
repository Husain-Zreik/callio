// Personal lines (docs/direct-lines.md, A2) over SIP through the local
// gateway and the fake carrier: a line owned by one agent rings that agent's
// devices whatever their shift; busy → 486 BUSY; no answer → NO_ANSWER after
// the line's ring timeout; a decline ends it REJECTED; an owner nobody can
// reach → NO_ANSWER at once; only the owner calls out from the line, and doing
// so leaves their shift alone; a shared line with no queue rejects the call.
// The board (A3) with the tenant's team view off: other agents get none of the
// line's call events, a supervisor narrowed to the line gets its events (and
// not another line's), pages its live calls and gets counters.
import { readFileSync } from 'fs';
import {
    testDb, sleep, makeChecks, waitFor, newPeer, hear, gathered, eventReceiver,
    connectAgent, accept, nextIncoming, api as makeApi,
} from './lib.mjs';
import { sipCarrier } from './sipCarrier.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 3901);
const CALLIO = `http://127.0.0.1:${PORT}`;
const LINE = '+96170000101';          // owned by line-user-1
const UNREACHABLE_LINE = '+96170000102';   // owned by line-user-2, who never connects
const SHARED_NO_QUEUE = '+96170000103';
const { check, summary } = makeChecks();
const api = makeApi(CALLIO, seed.api_key);
const receiver = eventReceiver({ secret: seed.webhook_secret });
const carrier = sipCarrier({ sipPort: Number(process.env.TEST_SIP_CARRIER_PORT || 5070) });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const sipCall = (providerCallId) => waitFor(async () => (await q("SELECT * FROM calls WHERE channel = 'SIP' AND provider_call_id = ?", [providerCallId]))[0], 8000, `SIP call ${providerCallId}`);
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const agentRow = async (ref) => (await q('SELECT id, availability, busy_call_id FROM agents WHERE external_ref = ?', [ref]))[0];
const finalStatus = (call) => call.answered.then(() => 200, (err) => err.status);
const ended = (id) => waitFor(async () => { const r = await callRow(id); return ['TERMINATED', 'FAILED'].includes(r.status) ? r : null; }, 15000, `call ${id} ended`);
const ask = (agent, event, data) => Promise.race([new Promise((resolve) => agent.socket.emit(event, data, resolve)), sleep(5000).then(() => ({ timeout: true }))]);
const eventsFor = (agent, callIds) => agent.events.filter((e) => callIds.map(String).includes(String(e.payload?.callId)));
const endedEvent = (callId) => waitFor(() => receiver.events.find((e) => e.callId === callId && e.type === 'call.ended'), 15000, `call.ended for ${callId}`);

await receiver.listen();
await carrier.listen();
let exitCode = 0;
const tenantBefore = (await api('GET', '/v1/tenants/demo')).body.tenant;

try {
    // A product whose agents are its end users: no team view.
    await api('PUT', '/v1/tenants/demo', { name: tenantBefore.name, settings: { ...(tenantBefore.settings ?? {}), team_view: false } });
    const trunkId = (await q("SELECT id FROM sip_trunks WHERE name = 'dev-trunk'"))[0].id;
    await api('PUT', '/v1/tenants/demo/agents/line-user-1', { name: 'Line User 1' });
    await api('PUT', '/v1/tenants/demo/agents/line-user-2', { name: 'Line User 2' });
    const u1 = await connectAgent(CALLIO, seed, 'line-user-1');
    const u1Phone = await connectAgent(CALLIO, seed, 'line-user-1', 'AGENT', 'line-user-1-phone');
    const a2 = await connectAgent(CALLIO, seed, 'agent-2');
    const sup = await connectAgent(CALLIO, seed, 'sup-1', 'SUPERVISOR');
    const u1Id = (await agentRow('line-user-1')).id;

    // ── Provisioning ──
    const put = await api('PUT', '/v1/tenants/demo/channels/line-1', {
        type: 'SIP', address: LINE, sip_trunk_id: trunkId, owner_agent_ref: 'line-user-1', ring_timeout_seconds: 5,
    });
    check('a personal line is provisioned with its owner and ring timeout', put.status === 200
        && put.body.channel.ownerAgentId === u1Id && put.body.channel.ringTimeoutSeconds === 5 && put.body.channel.inboundQueueId == null,
        `HTTP ${put.status} ${JSON.stringify(put.body.channel ?? put.body)}`);
    const both = await api('PUT', '/v1/tenants/demo/channels/line-x', {
        type: 'SIP', address: '+96170000199', sip_trunk_id: trunkId, owner_agent_ref: 'line-user-1', inbound_queue_ref: 'main',
    });
    const noOwner = await api('PUT', '/v1/tenants/demo/channels/line-x', {
        type: 'SIP', address: '+96170000199', sip_trunk_id: trunkId, owner_agent_ref: 'nobody',
    });
    check('a line with an owner and a queue, or an unknown owner, is refused', both.status === 400 && noOwner.status === 400,
        `both=${both.status} unknown=${noOwner.status}`);
    await api('PUT', '/v1/tenants/demo/channels/line-2', { type: 'SIP', address: UNREACHABLE_LINE, sip_trunk_id: trunkId, owner_agent_ref: 'line-user-2' });
    const shared = await api('PUT', '/v1/tenants/demo/channels/shared-no-queue', { type: 'SIP', address: SHARED_NO_QUEUE, sip_trunk_id: trunkId });
    const line1Id = put.body.channel.id;

    // ── The board: who may watch ──
    const refused = await ask(a2, 'board:subscribe', {});
    check('with team view off, an agent may not subscribe to the board', refused?.error?.code === 'BOARD_REQUEST_FAILED', JSON.stringify(refused));
    const narrowed = await ask(sup, 'board:subscribe', { channelIds: [line1Id] });
    check('a supervisor narrows their board to one line', narrowed?.filter?.channelIds?.[0] === line1Id, JSON.stringify(narrowed));
    const foreign = await ask(sup, 'board:subscribe', { channelIds: [999999] });
    check('a filter naming another tenant\'s (or no) line is refused', foreign?.error?.code === 'BOARD_REQUEST_FAILED', JSON.stringify(foreign));
    await ask(sup, 'board:subscribe', { channelIds: [line1Id] });

    // ── 1. The line rings its owner (OFFLINE shift) on every device; nobody else ──
    check('the owner starts OFFLINE (their shift)', (await agentRow('line-user-1')).availability === 'OFFLINE');
    const c1 = await carrier.callIn({ from: '+96181030901', to: LINE, freqs: [440] });
    const row1 = await sipCall(c1.callId);
    const offer1 = await nextIncoming(u1, row1.id);
    const phoneOffer1 = await nextIncoming(u1Phone, row1.id).catch(() => null);
    await sleep(500);
    check('the call is offered DIRECT to the owner on both devices, whatever their shift',
        offer1.agentId === u1Id && offer1.assignmentType === 'DIRECT' && Boolean(phoneOffer1) && row1.queue_id == null,
        `agentId=${offer1.agentId} type=${offer1.assignmentType} phone=${Boolean(phoneOffer1)}`);
    check('another agent of the tenant is not offered it', !a2.incoming.some((p) => String(p.callId) === String(row1.id)));
    await accept(u1, offer1, 880);
    await c1.answered;
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 15000, 'line call answered');
    const ownerEar = await hear(await u1.peer.received);
    check('the owner hears the caller', ownerEar.dominant() === 440, `tone=${ownerEar.dominant()}`);

    const page = await ask(sup, 'board:calls', { channelIds: [line1Id], limit: 10 });
    const otherLine = await ask(sup, 'board:calls', { channelIds: [shared.body.channel.id] });
    check('board:calls pages the live calls of a line', page?.calls?.some((c) => String(c.callId) === String(row1.id)) && otherLine?.calls?.length === 0,
        `line=${page?.calls?.map((c) => c.callId)} other=${otherLine?.calls?.length}`);
    const counters = await ask(sup, 'board:counters');
    check('board:counters counts the tenant\'s live calls and agents', counters?.calls?.inProgress >= 1 && counters?.agents?.onCall >= 1,
        JSON.stringify(counters));

    // ── 2. Busy: a second call while the owner is on the first ──
    const c2 = await carrier.callIn({ from: '+96181030902', to: LINE });
    const status2 = await finalStatus(c2);
    const row2 = await ended((await sipCall(c2.callId)).id);
    check('a call to a busy line gets 486 and ends BUSY/SYSTEM, naming the owner', status2 === 486
        && row2.termination_reason === 'BUSY' && row2.terminated_by === 'SYSTEM' && row2.agent_id === u1Id,
        `status=${status2} ${row2.termination_reason}/${row2.terminated_by} agent=${row2.agent_id}`);
    const ev2 = await endedEvent(row2.id).catch(() => null);
    check('call.ended for the busy call names the line and the agent', ev2?.body?.data?.call?.terminationReason === 'BUSY'
        && ev2?.body?.data?.call?.channelRef === 'line-1' && ev2?.body?.data?.call?.agentRef === 'line-user-1',
        JSON.stringify(ev2?.body?.data?.call ? { r: ev2.body.data.call.terminationReason, ch: ev2.body.data.call.channelRef, a: ev2.body.data.call.agentRef } : null));
    check('the first call is untouched', (await callRow(row1.id)).status === 'IN_PROGRESS');

    u1.socket.emit('call:terminate', { callId: row1.id });
    await waitFor(() => c1.ended === 'remote', 10000, 'BYE to the carrier');
    await waitFor(async () => (await agentRow('line-user-1')).busy_call_id == null, 8000, 'owner released');
    const after1 = await agentRow('line-user-1');
    check('after the call the owner is released and still OFFLINE (shift untouched)', after1.availability === 'OFFLINE' && after1.busy_call_id == null,
        JSON.stringify(after1));
    u1.peer?.close(); u1.peer = null;

    // ── 3. No answer: the line rings out after its 5 s ring timeout ──
    const c3 = await carrier.callIn({ from: '+96181030903', to: LINE });
    const row3 = await sipCall(c3.callId);
    await nextIncoming(u1, row3.id);
    const rangAt = Date.now();
    const status3 = await finalStatus(c3);
    const end3 = await ended(row3.id);
    const rang = (Date.now() - rangAt) / 1000;
    check('unanswered, the line rings out after ~5 s: NO_ANSWER, the carrier told (480)', end3.termination_reason === 'NO_ANSWER'
        && status3 === 480 && rang >= 3.5 && rang < 12, `${end3.termination_reason} status=${status3} after ${rang.toFixed(1)}s`);
    const after3 = await agentRow('line-user-1');
    check('a missed line call releases the owner and leaves their shift alone', after3.busy_call_id == null && after3.availability === 'OFFLINE', JSON.stringify(after3));

    // ── 4. The owner declines ──
    const c4 = await carrier.callIn({ from: '+96181030904', to: LINE });
    const row4 = await sipCall(c4.callId);
    await nextIncoming(u1, row4.id);
    u1.socket.emit('call:reject', { callId: row4.id });
    const status4 = await finalStatus(c4);
    const end4 = await ended(row4.id);
    check('a decline ends the call REJECTED/AGENT and the carrier is told', end4.termination_reason === 'REJECTED' && end4.terminated_by === 'AGENT'
        && status4 >= 400, `${end4.termination_reason}/${end4.terminated_by} status=${status4}`);

    // ── 5. Outbound from the line: only its owner ──
    const stolen = await api('POST', '/v1/tenants/demo/calls', { channel_ref: 'line-1', agent_ref: 'agent-2', customer: { address: '+96181030999' } });
    check('another agent may not call out from the line (403 line_not_owned)', stolen.status === 403 && stolen.body?.error?.code === 'line_not_owned',
        `HTTP ${stolen.status} ${JSON.stringify(stolen.body)}`);
    const intent = await api('POST', '/v1/tenants/demo/calls', { channel_ref: 'line-1', agent_ref: 'line-user-1', customer: { address: '+96181030998' } });
    check('the owner calls out from their line', intent.status === 201, `HTTP ${intent.status}`);
    const outId = intent.body.call.callId;
    u1.peer = newPeer(660);
    await u1.peer.pc.setLocalDescription(await u1.peer.pc.createOffer());
    await gathered(u1.peer.pc);
    const started = new Promise((resolve) => u1.socket.once('call:started', resolve));
    u1.socket.emit('call:start', { callId: outId, sdpOffer: u1.peer.pc.localDescription.sdp });
    const startedPayload = await Promise.race([started, sleep(8000).then(() => null)]);
    await u1.peer.pc.setRemoteDescription({ type: 'answer', sdp: startedPayload.sdpAnswer });
    for (const c of u1.pendingCandidates.splice(0)) await u1.peer.pc.addIceCandidate(c).catch(() => { });
    const answered5 = await carrier.answerNext({ ringMs: 500, freqs: [440] });
    check('the carrier sees the call from the line number', String(answered5.from).includes(LINE.slice(1)), `from=${answered5.from}`);
    await waitFor(async () => (await callRow(outId)).status === 'IN_PROGRESS', 15000, 'outbound answered');
    check('the owner is busy (ON_CALL) during their outbound call', String((await agentRow('line-user-1')).busy_call_id) === String(outId));
    u1.socket.emit('call:terminate', { callId: outId });
    await waitFor(async () => (await callRow(outId)).status === 'TERMINATED', 10000, 'outbound ended');
    await waitFor(async () => (await agentRow('line-user-1')).busy_call_id == null, 8000, 'owner released after outbound');
    check('after an outbound call the owner keeps their shift (OFFLINE), not changed by the call', (await agentRow('line-user-1')).availability === 'OFFLINE');
    u1.peer?.close(); u1.peer = null;

    // ── 6. Inbound again right after the outbound call ──
    const c6 = await carrier.callIn({ from: '+96181030906', to: LINE, freqs: [440] });
    const row6 = await sipCall(c6.callId);
    const offer6 = await nextIncoming(u1, row6.id).catch(() => null);
    check('after placing a call, the owner still receives calls on their line', Boolean(offer6));
    if (offer6) {
        await accept(u1, offer6, 880);
        await c6.answered;
        await waitFor(async () => (await callRow(row6.id)).status === 'IN_PROGRESS', 15000, 'call 6 answered');
        await carrier.hangUp(c6);
        await ended(row6.id);
    }
    u1.peer?.close(); u1.peer = null;

    // ── 7. An owner nobody can reach ──
    const c7 = await carrier.callIn({ from: '+96181030907', to: UNREACHABLE_LINE });
    const t7 = Date.now();
    const status7 = await finalStatus(c7);
    const end7 = await ended((await sipCall(c7.callId)).id);
    check('an owner with no socket and no device: NO_ANSWER at once (480), naming the owner', end7.termination_reason === 'NO_ANSWER'
        && status7 === 480 && Date.now() - t7 < 4000 && end7.agent_id === (await agentRow('line-user-2')).id,
        `${end7.termination_reason} status=${status7} after ${Date.now() - t7}ms agent=${end7.agent_id}`);

    // ── 8. A shared line without a queue ──
    const c8 = await carrier.callIn({ from: '+96181030908', to: SHARED_NO_QUEUE });
    const status8 = await finalStatus(c8);
    const end8 = await ended((await sipCall(c8.callId)).id);
    check('a shared line with no queue rejects the call instead of ringing the tenant', end8.termination_reason === 'REJECTED'
        && end8.terminated_by === 'SYSTEM' && status8 === 480 && end8.agent_id == null
        && !a2.incoming.some((p) => String(p.callId) === String(end8.id)) && !u1.incoming.some((p) => String(p.callId) === String(end8.id)),
        `${end8.termination_reason}/${end8.terminated_by} status=${status8}`);

    // ── The board, after all of it ──
    const lineCalls = [row1.id, row2.id, row3.id, row4.id, outId, row6.id];
    check('an agent not on the calls received none of their events (no team view)', eventsFor(a2, [...lineCalls, end7.id, end8.id]).length === 0
        && !a2.events.some((e) => e.event === 'call:agent_availability' && String(e.payload?.userId) === String(u1Id)),
        eventsFor(a2, lineCalls).map((e) => e.event).join(','));
    check('the owner still gets their own status changes', u1.events.some((e) => e.event === 'call:agent_availability' && e.payload?.availability === 'ON_CALL'));
    const supEvents = new Set(eventsFor(sup, [row1.id]).map((e) => e.event));
    check('the supervisor narrowed to the line got its calls (offer, status, end)',
        ['call:incoming:supervisor', 'call:terminated'].every((e) => supEvents.has(e)), [...supEvents].join(','));
    check('… and nothing about calls on other lines', eventsFor(sup, [end7.id, end8.id]).length === 0,
        eventsFor(sup, [end7.id, end8.id]).map((e) => `${e.event}:${e.payload.callId}`).join(','));
    check('the supervisor got pushed counters', sup.events.some((e) => e.event === 'board:counters' && e.payload?.calls));

    for (const a of [u1, u1Phone, a2, sup]) a.socket.close();
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    await api('PUT', '/v1/tenants/demo', { name: tenantBefore.name, settings: tenantBefore.settings ?? {} }).catch(() => { });
    carrier.close(); receiver.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
