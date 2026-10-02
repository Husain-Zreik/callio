// The React bindings (sdk/agent-react) against real calls, rendered in Node:
// a provider connects, hooks go available, show the ringing call, answer it
// (audio both ways), mute, and a supervisor's hooks show the board and
// monitor the call; hang-up clears both screens; unmounting disconnects.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync } from 'fs';
import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { testDb, makeChecks, waitFor, hear, listen, toneTrack, fakeMeta, agentToken, api as makeApi, wrtc } from './lib.mjs';
import {
    CallioProvider, useCallio, useAgent, useIncomingCalls, useActiveCall, useCall, useQueues, useBoard, useMonitor,
} from '../../sdk/agent-react/src/index.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = false;   // socket events update the tree outside act()

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
const mic = (freq) => new wrtc.MediaStream([toneTrack(freq).track]);

// What the hooks returned on the latest render.
const agentView = {};
const supView = { watch: null };

function AgentProbe() {
    Object.assign(agentView, {
        callio: useCallio(), me: useAgent(), incoming: useIncomingCalls(), active: useActiveCall(), queues: useQueues(),
    });
    agentView.call = useCall(agentView.active ?? agentView.incoming[0] ?? null);
    return null;
}
function SupervisorProbe() {
    Object.assign(supView, { callio: useCallio(), me: useAgent(), board: useBoard() });
    supView.monitor = useMonitor(supView.watch);
    return null;
}
const provider = (ref, role, deviceId, probe) => createElement(CallioProvider, {
    url: CALLIO, token: agentToken(seed, ref, role), deviceId, webrtc: wrtc, getUserMedia: async () => mic(880),
}, createElement(probe));

await meta.listen();
let exitCode = 0;
let agentTree = null;
let supTree = null;

try {
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }] });

    // ── Provider and agent hooks ──
    agentTree = TestRenderer.create(provider('agent-1', 'AGENT', 'react-a1', AgentProbe));
    check('the provider starts connecting', ['connecting', 'ready'].includes(agentView.callio.status));
    await waitFor(() => agentView.callio.status === 'ready', 10000, 'provider ready');
    check('useCallio() reports ready and useAgent() identifies the agent', agentView.me.me?.ref === 'agent-1' && !agentView.me.isSupervisor);
    agentView.me.setAvailability('AVAILABLE');
    await waitFor(() => agentView.me.availability === 'AVAILABLE', 8000, 'available');
    check('useAgent().setAvailability re-renders with the new availability', agentView.me.availability === 'AVAILABLE');
    await waitFor(() => agentView.queues.length > 0, 8000, 'queues');
    check('useQueues() lists the queue snapshots', agentView.queues.some((qs) => qs.queueName === 'Main queue'));

    supTree = TestRenderer.create(provider('sup-1', 'SUPERVISOR', 'react-sup', SupervisorProbe));
    await waitFor(() => supView.callio.status === 'ready', 10000, 'supervisor ready');
    check('a supervisor provider: useAgent().isSupervisor', supView.me.isSupervisor);

    // ── A call through the hooks ──
    const c1 = await meta.callIn('wacid.react.1');
    const row1 = await callByProvider(c1.id);
    await waitFor(() => agentView.incoming.length === 1, 10000, 'ringing');
    check('useIncomingCalls() shows the ringing call, useCall() its customer', agentView.call.state === 'ringing'
        && agentView.call.customer?.address === '+96181030841');
    await waitFor(() => supView.board.some((c) => String(c.callId) === String(row1.id)), 8000, 'on the board');
    check('useBoard() shows the new call', supView.board.length === 1);

    await agentView.call.accept({ stream: mic(880) });
    await waitFor(() => agentView.active?.state === 'active' && agentView.call.remoteStream, 15000, 'active with audio');
    check('accept() through useCall(): useActiveCall() is active and the remote stream is there', agentView.call.state === 'active'
        && agentView.incoming.length === 0);
    const agentEar = listen(agentView.call.remoteStream.getAudioTracks()[0]);
    const customerEar = await c1.customer.received;
    await hear(agentEar);
    await hear(customerEar, 1000, 0);
    check('the agent hears the customer and the customer hears the agent', agentEar.dominant() === 440 && customerEar.dominant() === 880,
        `agent=${agentEar.dominant()} customer=${customerEar.dominant()}`);
    await waitFor(() => supView.board[0]?.status === 'IN_PROGRESS', 8000, 'board status');
    check('the board re-renders with the answered status', supView.board[0]?.status === 'IN_PROGRESS');

    // ── Supervisor monitoring through useMonitor ──
    const supAgentBefore = supView.callio.agent;
    supTree.update(provider('sup-1', 'SUPERVISOR', 'react-sup', SupervisorProbe));   // a freshly signed token
    check('re-rendering the provider with a new token keeps the same connection',
        supView.callio.agent === supAgentBefore && supView.callio.status === 'ready');
    supView.watch = row1.id;
    supTree.update(provider('sup-1', 'SUPERVISOR', 'react-sup', SupervisorProbe));
    await supView.monitor.start({ stream: mic(660) });
    await waitFor(() => supView.monitor.state === 'active' && supView.monitor.stream, 10000, 'monitoring');
    check('useMonitor(callId).start() listens: the call stream arrives', supView.monitor.mode === 'listen');
    supView.monitor.setMode('whisper');
    await waitFor(() => supView.monitor.mode === 'whisper', 8000, 'whisper');
    await hear(agentEar);
    check('setMode("whisper") re-renders the mode, and the agent hears the supervisor', agentEar.has(660));

    // ── Mute ──
    agentView.call.mute(true);
    await waitFor(() => agentView.call.muted, 3000, 'muted');
    await hear(customerEar, 2500, 1000);
    check('mute() re-renders muted and the customer no longer hears the agent', !customerEar.has(880));
    agentView.call.mute(false);

    // ── Hang up ──
    agentView.call.hangup();
    await waitFor(() => !agentView.active && agentView.incoming.length === 0, 8000, 'agent screen cleared');
    await waitFor(() => supView.board.length === 0 && supView.monitor.state === 'idle', 8000, 'supervisor screen cleared');
    await waitFor(async () => (await callRow(row1.id)).status === 'TERMINATED', 10000, 'ended');
    check('hangup(): the agent screen and the supervisor board and monitor clear', (await callRow(row1.id)).terminated_by === 'AGENT');

    // ── Unmount ──
    const socket = agentView.callio.agent.socket;
    agentTree.unmount();
    agentTree = null;
    await waitFor(() => !socket.connected, 5000, 'socket closed');
    check('unmounting the provider closes the connection', !socket.connected);
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    agentTree?.unmount();
    supTree?.unmount();
    meta.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
