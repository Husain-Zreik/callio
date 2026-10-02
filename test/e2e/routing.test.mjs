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
const availability = async (ref) => (await q("SELECT IF(busy_call_id IS NULL, availability, 'ON_CALL') AS availability FROM agents WHERE external_ref = ?", [ref]))[0]?.availability;
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
    // The client offers two audio lines (older clients heard the customer and
    // the agent on separate tracks): the first sends the supervisor's
    // microphone (a 660 Hz tone) and carries the room's mix; the second is
    // answered as rejected.
    sup.peer = newPeer([660], { audioLines: 2 });
    await sup.peer.pc.setLocalDescription(await sup.peer.pc.createOffer());
    await gathered(sup.peer.pc);
    const monitorStarted = new Promise((resolve) => sup.socket.once('call:monitor:started', resolve));
    sup.socket.emit('call:monitor', { callId: row3.id, sdpOffer: sup.peer.pc.localDescription.sdp });
    const started = await Promise.race([monitorStarted, sleep(8000).then(() => null)]);
    check('supervisor can start monitoring', Boolean(started?.sdpAnswer));
    await sup.peer.pc.setRemoteDescription({ type: 'answer', sdp: started.sdpAnswer });
    for (const c of sup.pendingCandidates.splice(0)) await sup.peer.pc.addIceCandidate(c).catch(() => { });
    check('the second audio line is answered as rejected (port 0)', /m=audio 0 /.test(started.sdpAnswer));
    const supEar = await Promise.race([sup.peer.received, sleep(8000).then(() => null)]);
    if (supEar) await hear(supEar);
    check('supervisor hears the customer and the agent (the room mix)', Boolean(supEar?.has(440) && supEar?.has(880)),
        supEar ? `bins=${JSON.stringify(Object.fromEntries(Object.entries(supEar.stats.bins).map(([f, e]) => [f, Math.round(Math.log10(e + 1))])))}` : 'no track');

    // What the agent and the customer hear of the supervisor in each mode.
    const agentEar = await a1.peer.received;
    const customerEar = await c3.customer.received;
    const hearsSupervisor = async () => {
        await sleep(1500);
        agentEar.reset(); customerEar.reset();
        await sleep(2500);
        return { agent: agentEar.has(660), customer: customerEar.has(660) };
    };
    const inListen = await hearsSupervisor();
    check('listen: neither the agent nor the customer hears the supervisor', !inListen.agent && !inListen.customer, JSON.stringify(inListen));
    sup.socket.emit('call:monitor:mode', { callId: row3.id, mode: 'whisper' });
    const inWhisper = await hearsSupervisor();
    check('whisper: the agent hears the supervisor, the customer does not', inWhisper.agent && !inWhisper.customer, JSON.stringify(inWhisper));
    sup.socket.emit('call:monitor:mode', { callId: row3.id, mode: 'barge' });
    const inBarge = await hearsSupervisor();
    check('barge: both the agent and the customer hear the supervisor', inBarge.agent && inBarge.customer, JSON.stringify(inBarge));

    // Agent-private (a reply only the supervisor hears) is real only in whisper.
    const privateAfter = (from) => a1.events.slice(from).filter((e) => e.event === 'call:agent:private:changed').map((e) => e.payload.active);
    let mark = a1.events.length;
    a1.errors.length = 0;
    a1.socket.emit('call:agent:private', { callId: row3.id, active: true });
    await sleep(1000);
    check('agent-private outside whisper is refused and reported as off', JSON.stringify(privateAfter(mark)) === '[false]'
        && a1.errors.some((e) => e.code === 'MONITOR_FAILED'), `changed=${JSON.stringify(privateAfter(mark))}`);
    sup.socket.emit('call:monitor:mode', { callId: row3.id, mode: 'whisper' });
    await sleep(800);
    mark = a1.events.length;
    a1.socket.emit('call:agent:private', { callId: row3.id, active: true });
    await sleep(1000);
    check('agent-private in whisper is on', JSON.stringify(privateAfter(mark)) === '[true]', JSON.stringify(privateAfter(mark)));

    // The agent's leg is rebuilt (call:reconnect): their UI gets the supervisor's
    // mode and agent-private back.
    mark = a1.events.length;
    const previousPeer = a1.peer;
    a1.peer = newPeer(880);
    await a1.peer.pc.setLocalDescription(await a1.peer.pc.createOffer());
    await gathered(a1.peer.pc);
    a1.socket.emit('call:reconnect', { callId: row3.id, sdpOffer: a1.peer.pc.localDescription.sdp });
    const rejoined = await waitFor(() => a1.events.slice(mark).find((e) => e.event === 'call:reconnected')?.payload, 10000, 'call:reconnected').catch(() => null);
    if (rejoined) {
        await a1.peer.pc.setRemoteDescription({ type: 'answer', sdp: rejoined.sdpAnswer });
        for (const c of a1.pendingCandidates.splice(0)) await a1.peer.pc.addIceCandidate(c).catch(() => { });
    }
    previousPeer.close();
    await sleep(1000);
    const afterReconnect = a1.events.slice(mark);
    const restored = {
        announced: afterReconnect.some((e) => e.event === 'call:monitor:agent:reconnected'),
        mode: afterReconnect.find((e) => e.event === 'call:supervisor:mode')?.payload?.mode ?? null,
        private: afterReconnect.find((e) => e.event === 'call:agent:private:changed')?.payload?.active ?? null,
    };
    check('after an agent reconnect the agent gets the supervisor mode and agent-private back',
        Boolean(rejoined) && restored.announced && restored.mode === 'whisper' && restored.private === true, JSON.stringify(restored));
    mark = a1.events.length;
    sup.socket.emit('call:monitor:mode', { callId: row3.id, mode: 'listen' });
    await sleep(1000);
    check('leaving whisper ends agent-private, and the agent is told', JSON.stringify(privateAfter(mark)) === '[false]',
        JSON.stringify(privateAfter(mark)));

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

    // A transfer the target never accepts comes back through the queue.
    await setAvailable(a2);
    const answeredBefore = (await callRow(row3.id)).answered_at;
    const seenByA1 = a1.incoming.length;   // only offers made after the transfer count
    a1.socket.emit('call:transfer', { callId: row3.id, agentId: id['agent-2'] });
    await nextIncoming(a2, row3.id, 10000, (p) => p.assignmentType === 'TRANSFERRED');
    const withdrawn = waitFor(() => a2.events.find((e) => e.event === 'call:offer_withdrawn' && String(e.payload?.callId) === String(row3.id)),
        15000, 'transfer withdrawn from agent-2').catch(() => null);
    const back = await waitFor(() => a1.incoming.slice(seenByA1).find((p) => String(p.callId) === String(row3.id)), 15000, 'call offered back to agent-1');
    const rowBack = await callRow(row3.id);
    const offeredToA1 = back.agentId === id['agent-1'] || (back.offeredAgentIds ?? []).includes(id['agent-1']);
    check('an unaccepted transfer goes back to the queue and is offered again', offeredToA1 && rowBack.status === 'RINGING',
        `${rowBack.status} agentId=${back.agentId} offered=${back.offeredAgentIds}`);
    await accept(a1, back, 880);
    await waitFor(async () => { const r = await callRow(row3.id); return r.status === 'IN_PROGRESS' && r.state === 'ACTIVE'; }, 15000, 'call answered again');
    const cust3r = await c3.customer.received;
    await hear(cust3r, 3000, 3000);
    const rowAgain = await callRow(row3.id);
    check('after taking it back, the customer hears the agent again and the answer time is kept',
        cust3r.dominant() === 880 && String(rowAgain.answered_at) === String(answeredBefore), `tone=${cust3r.dominant()}`);
    check('the target who ignored the transfer is told it was withdrawn', Boolean(await withdrawn));

    await setAvailable(a2);
    const seenByA2 = a2.incoming.length;
    a1.socket.emit('call:transfer', { callId: row3.id, agentId: id['agent-2'] });
    const xfer = await waitFor(() => a2.incoming.slice(seenByA2).find((p) => String(p.callId) === String(row3.id) && p.assignmentType === 'TRANSFERRED'),
        10000, 'transfer offered to agent-2');
    check('the target agent is offered the transferred call', xfer.transferredFrom?.id === id['agent-1']);
    await accept(a2, xfer, 660);
    await waitFor(async () => (await callRow(row3.id)).agent_id === id['agent-2'], 10000, 'call moved to agent-2');
    const cust3b = await c3.customer.received;
    await hear(cust3b, 3000, 3000);
    check('after the transfer the customer hears the new agent', cust3b.dominant() === 660, `tone=${cust3b.dominant()}`);
    const logs = await q('SELECT * FROM call_transfer_logs WHERE call_id = ?', [row3.id]);
    const last = logs[logs.length - 1];
    check('the transfer is logged and the previous agent released', logs.length === 2 && last?.from_agent_id === id['agent-1']
        && last?.to_agent_id === id['agent-2'] && (await availability('agent-1')) === 'AVAILABLE');
    const detail3 = await api('GET', `/v1/calls/${row3.id}`);
    const t3 = detail3.body.transfers?.at(-1);
    check('call detail lists the transfer in camelCase', t3?.fromAgentId === id['agent-1'] && t3?.toAgentId === id['agent-2']
        && Boolean(t3?.transferredAt), JSON.stringify(t3));
    a1.peer?.close(); a1.peer = null;
    await endByAgent(a2, row3.id);
    const people3 = (await api('GET', `/v1/calls/${row3.id}`)).body.participants ?? [];
    const stays = people3.map((p) => `${p.kind}:${p.agentRef ?? '-'}:${p.leaveReason}`);
    check('participants: the customer, agent-1 twice (each stay handed on), agent-2 to the end, the supervisor until they stopped',
        JSON.stringify(stays) === JSON.stringify(['CUSTOMER:-:ENDED', 'AGENT:agent-1:TRANSFERRED', 'SUPERVISOR:sup-1:MONITOR_STOPPED', 'AGENT:agent-1:TRANSFERRED', 'AGENT:agent-2:ENDED'])
        && people3.every((p) => p.joinedAt && p.leftAt), JSON.stringify(stays));

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
    const detail6 = await api('GET', `/v1/calls/${row6.id}`);
    const s6 = detail6.body.ivrSessions?.[0];
    check('call detail lists the IVR session and key presses in camelCase', s6?.outcome === 'transferred'
        && s6?.ivrFlowId === flow.body.ivrFlow.id && s6?.inputs?.some((i) => i.input === '1' && i.pressedAt), JSON.stringify(s6));
    await endByAgent(agent6, row6.id);

    // ── 6b. The API ends a call while it is still in the IVR ──
    // Nothing had subscribed the owning worker to the call's events before an
    // AGENT offer, so this terminate used to reach no worker.
    const c6b = await meta.callIn('wacid.r.6b', { from: '96181030847' });
    const row6b = await callByProvider(c6b.id);
    await waitFor(() => sup.events.some((e) => e.event === 'call:ivr_state' && e.payload.callId === row6b.id && e.payload.nodeType === 'ivr_menu'), 15000, 'menu node (6b)');
    const term6b = await api('POST', `/v1/calls/${row6b.id}/terminate`);
    check('terminate during the IVR is accepted', term6b.status === 202, `HTTP ${term6b.status}`);
    const ended6b = await waitFor(async () => { const r = await callRow(row6b.id); return r.status === 'TERMINATED' ? r : null; }, 10000, 'IVR call ended by the API').catch(() => null);
    check('the API ends a call in the IVR, recorded as the consumer hang-up', ended6b?.status === 'TERMINATED' && ended6b?.terminated_by === 'CONSUMER',
        `status=${(await callRow(row6b.id)).status} by=${ended6b?.terminated_by}`);
    const told6b = await waitFor(() => meta.calls.some((c) => c.body.action === 'terminate' && c.body.call_id === c6b.id), 5000, 'provider terminate (6b)').catch(() => false);
    const session6b = await waitFor(async () => (await q('SELECT * FROM ivr_sessions WHERE call_id = ? AND ended_at IS NOT NULL', [row6b.id]))[0], 5000, 'IVR session ended (6b)').catch(() => null);
    check('the provider is told and the IVR session stops', Boolean(told6b) && Boolean(session6b?.ended_at),
        `provider=${Boolean(told6b)} session=${session6b?.outcome}/${session6b?.ended_at}`);

    // ── 6c. The caller hangs up from the menu (9): supervisors are told ──
    await api('PUT', '/v1/tenants/demo/ivr-flows/main-menu', {
        name: 'Main menu', channel_ref: 'whatsapp-main', status: 'ACTIVE', trigger_condition: 'ALWAYS',
        structure: {
            nodes: [
                { id: 'start', type: 'ivr_start', data: {} },
                { id: 'menu', type: 'ivr_menu', data: { label: 'Main', audioFileId: asset.body.audioAsset.id, timeoutSeconds: 8 } },
                { id: 'bye', type: 'ivr_hangup', data: {} },
            ],
            edges: [{ source: 'start', target: 'menu' }, { source: 'menu', target: 'bye', sourceHandle: '9' }],
        },
    });
    const c6c = await meta.callIn('wacid.r.6c', { from: '96181030848' });
    const row6c = await callByProvider(c6c.id);
    await waitFor(() => sup.events.some((e) => e.event === 'call:ivr_state' && e.payload.callId === row6c.id && e.payload.nodeType === 'ivr_menu'), 15000, 'menu node (6c)');
    await sleep(2000);
    c6c.customer.tone.set([852, 1477]); // DTMF "9"
    await sleep(400);
    c6c.customer.tone.set([440]);
    const told6c = await waitFor(() => sup.events.find((e) => e.event === 'call:ivr_terminated' && e.payload.callId === row6c.id), 15000, 'call:ivr_terminated (6c)').catch(() => null);
    check('an IVR hang-up reaches the supervisors (call:ivr_terminated)', Boolean(told6c), JSON.stringify(told6c?.payload ?? null));

    await api('PUT', '/v1/tenants/demo/ivr-flows/main-menu', { ...flow.body.ivrFlow, name: 'Main menu', status: 'INACTIVE',
        structure: { nodes: [{ id: 'start', type: 'ivr_start', data: {} }], edges: [] } });

    // ── 7. The customer's audio drops: the agent sees it, it recovers, then it drops for good ──
    // core/calls/CustomerNetworkLossPolicy: warned at 15 s, ended as CUSTOMER_NETWORK_LOSS at 20 s.
    const c7 = await meta.callIn('wacid.r.7', { from: '96181030848' });
    const row7 = await callByProvider(c7.id);
    const offer7 = await waitFor(() => [...a1.incoming, ...a2.incoming].find((p) => p.callId === row7.id && p.sdpOffer), 15000, 'call 7 offered');
    const agent7 = offer7.agentId === id['agent-1'] ? a1 : a2;
    await accept(agent7, offer7, 660);
    await waitFor(async () => (await callRow(row7.id)).state === 'ACTIVE', 15000, 'call 7 answered');
    await hear(await c7.customer.received);
    const mediaState = (st) => waitFor(() => agent7.events.find((e) => e.event === 'call:customer:media:state'
        && String(e.payload.callId) === String(row7.id) && e.payload.state === st && !e.seen && (e.seen = true)), 15000, `customer media ${st}`);
    // The customer's network drops: their RTP stops.
    await c7.customer.stopSending();
    const drop1 = await mediaState('drop').catch(() => null);
    await c7.customer.resumeSending();
    const recovered7 = await mediaState('active').catch(() => null);
    check('the agent sees the customer’s audio drop and come back', Boolean(drop1 && recovered7));
    await c7.customer.stopSending();
    const warned = await waitFor(() => agent7.events.find((e) => e.event === 'call:network:terminating' && String(e.payload.callId) === String(row7.id)), 25000, 'network terminating warning').catch(() => null);
    const lost = await waitFor(async () => { const r = await callRow(row7.id); return r.status === 'FAILED' ? r : null; }, 12000, 'call 7 ended by network loss').catch(() => null);
    check('a customer who stays silent: the agent is warned, then the call ends as CUSTOMER_NETWORK_LOSS',
        Boolean(warned) && lost?.termination_reason === 'CUSTOMER_NETWORK_LOSS', `warned=${Boolean(warned)} ${lost?.status}/${lost?.termination_reason}`);
    agent7.peer?.close(); agent7.peer = null;

    for (const a of [a1, a2, sup]) a.socket.close();
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    meta.close(); receiver.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
