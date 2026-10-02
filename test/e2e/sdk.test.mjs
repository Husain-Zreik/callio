// The JS agent SDK (sdk/agent-js) against real calls, in Node: connect with
// a token from `npm run agent:token`, go available, ring, accept with a
// microphone, hear both ways, hang up; a decline passing the call on; a
// reload reconnecting the call's media; switching a call to another device;
// an outbound call started with the SDK.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { testDb, sleep, makeChecks, waitFor, hear, listen, toneTrack, fakeMeta, agentToken, api as makeApi, wrtc } from './lib.mjs';
import { connect } from '../../sdk/agent-js/src/index.js';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 3901);
const CALLIO = `http://127.0.0.1:${PORT}`;
const { check, summary } = makeChecks();
const api = makeApi(CALLIO, seed.api_key);
const meta = fakeMeta({ callioUrl: CALLIO, apiKey: seed.api_key, phoneNumberId: '111222333' });
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const callByProvider = (id) => waitFor(async () => (await q('SELECT * FROM calls WHERE provider_call_id = ?', [id]))[0], 8000, `call ${id}`);
const callRow = async (id) => (await q('SELECT * FROM calls WHERE id = ?', [id]))[0];
const availability = async (ref) => (await q("SELECT IF(busy_call_id IS NULL, availability, 'ON_CALL') AS availability FROM agents WHERE external_ref = ?", [ref]))[0]?.availability;

// A microphone that plays a tone.
const mic = (freq) => new wrtc.MediaStream([toneTrack(freq).track]);
// What the agent hears on a call.
const earOf = (call) => new Promise((resolve) => {
    if (call.pc) for (const r of call.pc.getReceivers()) if (r.track?.readyState === 'live' && call.remoteStream) return resolve(listen(r.track));
    call.once('remoteStream', (_stream, track) => resolve(listen(track)));
});
const nextEvent = (emitter, event, filter = () => true, ms = 10000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${event}`)); }, ms);
    const off = emitter.on(event, (...args) => { if (!filter(...args)) return; clearTimeout(t); off(); resolve(args[0]); });
});
const sdkAgent = (ref, deviceId, token = agentToken(seed, ref)) =>
    connect({ url: CALLIO, token, deviceId, webrtc: wrtc, getUserMedia: async () => mic(880) });

await meta.listen();
let exitCode = 0;
const opened = [];

try {
    // ── The token command signs what the gateway accepts ──
    const tokenRun = spawnSync(process.execPath, ['scripts/agent-token.js', '--consumer', 'dev', '--tenant', 'demo', '--agent', 'agent-1', '--minutes', '10'],
        { env: process.env, encoding: 'utf8' });
    const cliToken = tokenRun.stdout.trim();
    check('npm run agent:token prints a token', tokenRun.status === 0 && cliToken.split('.').length === 3, tokenRun.stderr.trim());

    const a1 = await sdkAgent('agent-1', 'a1-browser', cliToken);
    opened.push(a1);
    check('the SDK connects with it; session:ready identifies the agent and gives ICE servers',
        a1.agent?.ref === 'agent-1' && a1.iceServers.length > 0 && a1.session.deviceId === 'a1-browser');
    const a2 = await sdkAgent('agent-2', 'a2-browser');
    opened.push(a2);

    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }] });
    const avail = nextEvent(a1, 'availability', (p) => p.availability === 'AVAILABLE');
    a1.setAvailability('AVAILABLE');
    check('setAvailability reports back through the availability event', (await avail).availability === 'AVAILABLE');

    // A supervisor on the SDK: the tenant's live calls (board) and monitoring.
    const sup = await sdkAgent('sup-1', 'sup-browser', agentToken(seed, 'sup-1', 'SUPERVISOR'));
    opened.push(sup);
    check('a supervisor connects with the SDK and is recognised as one', sup.isSupervisor && !a1.isSupervisor);

    // A credentials refresh on a live connection: new session, no resync, calls untouched.
    let resynced = false;
    const offReady = a1.on('ready', () => { resynced = true; });
    const refreshed = nextEvent(a1, 'sessionRefreshed');
    a1.refreshSession();
    const refreshedSession = await refreshed;
    offReady();
    check('refreshSession() gets a fresh session without a reconnect or resync', Boolean(refreshedSession?.iceServers) && !resynced);

    // ── 1. Ring, accept, hear both ways, hang up ──
    const ringing = nextEvent(a1, 'incoming');
    const onBoard = nextEvent(sup, 'boardCall');
    const c1 = await meta.callIn('wacid.sdk.1');
    const call1 = await ringing;
    const row1 = await callByProvider(c1.id);
    check('an offered call arrives as an incoming Call', String(call1.id) === String(row1.id) && call1.state === 'ringing'
        && call1.customer.address === '+96181030841');
    const ear1 = earOf(call1);
    const active1 = nextEvent(call1, 'state', (s) => s === 'active', 15000);
    await call1.accept({ stream: mic(880) });
    await active1;
    check('accept() connects the media (state active)', call1.state === 'active');
    await waitFor(async () => (await callRow(row1.id)).status === 'IN_PROGRESS', 15000, 'answered');
    const agentHears = await hear(await ear1);
    const customerHears = await hear(await c1.customer.received);
    check('the agent hears the customer and the customer hears the agent', agentHears.dominant() === 440 && customerHears.dominant() === 880,
        `agent=${agentHears.dominant()} customer=${customerHears.dominant()}`);

    // The supervisor's board and monitoring of this call.
    const boardView = await onBoard;
    await waitFor(() => String(sup.board.get(String(row1.id))?.agentId) === String(a1.agent.id), 8000, 'board shows who answered');
    const view1 = sup.board.get(String(row1.id));
    check('the board shows the new call, then who answered it', String(boardView.callId) === String(row1.id)
        && view1?.status === 'IN_PROGRESS', `first=${boardView.callId} status=${view1?.status} agent=${view1?.agentId}`);
    const monitor = await sup.monitor(row1.id, { stream: mic(660) });
    await waitFor(() => monitor.stream && monitor.state === 'active', 10000, 'monitor stream');
    const supHears = listen(monitor.stream.getAudioTracks()[0]);
    await hear(supHears);
    check('monitor() hears the call: the agent and the customer, mixed',
        supHears.has(880) && supHears.has(440), `bins=${JSON.stringify(Object.fromEntries(Object.entries(supHears.stats.bins).map(([f, e]) => [f, Math.round(Math.log10(e + 1))])))}`);
    const agentEar = await ear1;
    await hear(agentEar);
    const inListen = agentEar.has(660);
    const whisper = nextEvent(monitor, 'mode', (m) => m === 'whisper');
    monitor.setMode('whisper');
    await whisper;
    await hear(agentEar);
    check('listen is silent to the agent; setMode("whisper") lets the agent hear the supervisor', !inListen && agentEar.has(660),
        `listen=${inListen} whisper=${agentEar.has(660)}`);
    const monitorEnded = nextEvent(monitor, 'ended');
    const boardEnded = nextEvent(sup, 'boardCallEnded', (v) => String(v.callId) === String(row1.id));

    const ended1 = nextEvent(call1, 'ended');
    call1.hangup();
    check('hangup() ends the call locally', (await ended1).reason === 'hangup');
    await waitFor(async () => (await callRow(row1.id)).status === 'TERMINATED', 10000, 'call 1 ended');
    check('…and at Callio (COMPLETED/AGENT)', (await callRow(row1.id)).terminated_by === 'AGENT');
    const [monitorEnd, boardEnd] = await Promise.all([monitorEnded, boardEnded]);
    check('when the call ends, the monitor ends and the call leaves the board',
        monitorEnd.reason === 'call_ended' && !sup.board.has(String(row1.id)) && String(boardEnd.callId) === String(row1.id), monitorEnd.reason);
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 8000, 'agent-1 available');

    // ── 2. The customer hangs up ──
    const ringing2 = nextEvent(a1, 'incoming');
    const c2 = await meta.callIn('wacid.sdk.2', { from: '96181030872' });
    const call2 = await ringing2;
    const active2 = nextEvent(call2, 'state', (s) => s === 'active', 15000);
    await call2.accept({ stream: mic(880) });
    await active2;
    const ended2 = nextEvent(call2, 'ended');
    await meta.hangUp(c2.id);
    check('a customer hang-up ends the Call with reason terminated', (await ended2).reason === 'terminated');
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 8000, 'agent-1 available');

    // ── 3. Decline passes the call to the next member ──
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }, { agent_ref: 'agent-2' }] });
    a2.setAvailability('AVAILABLE');
    await waitFor(async () => (await availability('agent-2')) === 'AVAILABLE', 5000, 'agent-2 available');
    const firstRing = Promise.race([nextEvent(a1, 'incoming'), nextEvent(a2, 'incoming')]);
    const c3 = await meta.callIn('wacid.sdk.3', { from: '96181030873' });
    const call3 = await firstRing;
    const decliner = call3.agent;
    const other = decliner === a1 ? a2 : a1;
    const passed = nextEvent(other, 'incoming');
    call3.decline();
    const call3b = await passed;
    check('decline() passes the call to the other member', String(call3b.id) === String(call3.id) && call3.state === 'ended');

    // ── 4. A reload: same device reconnects the call's media ──
    const active3 = nextEvent(call3b, 'state', (s) => s === 'active', 15000);
    await call3b.accept({ stream: mic(880) });
    await active3;
    const deviceId = other.deviceId;
    const ref = other.agent.ref;
    other.close();
    await sleep(500);
    const reopened = await sdkAgent(ref, deviceId);
    opened.push(reopened);
    const recovered = await waitFor(() => reopened.call(call3.id)?.state === 'active' ? reopened.call(call3.id) : null, 20000, 'media back after reload');
    const customerAfterReload = await hear(await c3.customer.received);
    check('after a reload the SDK reconnects the call by itself and the customer hears the agent again',
        recovered.state === 'active' && customerAfterReload.dominant() === 880, `tone=${customerAfterReload.dominant()}`);

    // ── 5. Moving the call to another device ──
    const phone = await sdkAgent(ref, `${ref}-phone`);
    opened.push(phone);
    const away = await waitFor(() => phone.call(call3.id), 10000, 'call visible on the other device');
    check('the other device sees the call as elsewhere', away.state === 'elsewhere');
    const superseded = nextEvent(recovered, 'state', (s) => s === 'elsewhere', 15000);
    const phoneActive = nextEvent(away, 'state', (s) => s === 'active', 20000);
    await away.switchHere({ stream: mic(660) });
    await phoneActive;
    await superseded;
    const customerAfterSwitch = await hear(await c3.customer.received);
    check('switchHere() moves the media; the first device is told it lost the call', customerAfterSwitch.dominant() === 660
        && recovered.state === 'elsewhere', `tone=${customerAfterSwitch.dominant()}`);
    const ended3 = nextEvent(away, 'ended');
    away.hangup();
    await ended3;
    await waitFor(async () => (await callRow(call3.id)).status === 'TERMINATED', 10000, 'call 3 ended');

    // ── 6. Outbound with the SDK ──
    const intent = await api('POST', '/v1/tenants/demo/calls', { channel_ref: 'whatsapp-main', agent_ref: 'agent-1', customer: { address: '+96181030879' } });
    const out = await a1.startOutbound(intent.body.call.callId, { stream: mic(880) });
    const outActive = await nextEvent(out, 'state', (s) => s === 'active', 20000).then(() => true).catch(() => false);
    const outRow = await callRow(out.id);
    const outCustomer = await hear(await meta.customers.get(outRow.provider_call_id).received);
    check('startOutbound() connects the agent, Callio dials, the customer answers and hears the agent',
        outActive && outRow.status === 'IN_PROGRESS' && outCustomer.dominant() === 880, `state=${out.state} tone=${outCustomer.dominant()}`);
    out.hangup();
    await waitFor(async () => (await callRow(out.id)).status === 'TERMINATED', 10000, 'outbound ended');
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    for (const a of opened) a.close();
    meta.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
