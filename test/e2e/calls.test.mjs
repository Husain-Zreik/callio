// Core call flows with real WebRTC media on both legs: agent auth, inbound
// routing and bridging, agent hang-up, outbound intent → call:start → dial,
// API terminate, call detail, consumer events, a dial the provider refuses,
// isolation.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync } from 'fs';
import http from 'http';
import { createHmac } from 'crypto';
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

    a1b.socket.emit('call:terminate', { callId: inCall.id, reason: 'customer_network_loss' }); // not a reason a client may pick
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
    const outEnded = await waitFor(async () => { const r = await callRow(outId); return r.status === 'TERMINATED' ? r : null; }, 10000, 'outbound ended');
    check('an API hang-up is recorded as the consumer hang-up (terminated_by CONSUMER)', outEnded.terminated_by === 'CONSUMER', outEnded.terminated_by);
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

    // ── Idempotency-Key ──
    const intentBody = { channel_ref: 'whatsapp-main', agent_ref: 'agent-2', customer: { address: '+96181030842' } };
    const idem = { 'Idempotency-Key': `e2e-${Date.now()}` };
    const firstTry = await api('POST', '/v1/tenants/demo/calls', intentBody, idem);
    const retry = await api('POST', '/v1/tenants/demo/calls', intentBody, idem);
    check('a retried POST with the same Idempotency-Key returns the first response, not a second call',
        firstTry.status === 201 && retry.status === 201 && retry.body.call?.callId === firstTry.body.call?.callId
        && retry.headers.get('idempotent-replayed') === 'true',
        `first=${firstTry.body.call?.callId} retry=${retry.body.call?.callId}`);
    const [{ n: intentsMade }] = await q("SELECT COUNT(*) AS n FROM calls WHERE customer_address = '+96181030842'");
    check('only one call was created for the key', Number(intentsMade) === 1, `calls=${intentsMade}`);
    const reused = await api('POST', '/v1/tenants/demo/calls', { ...intentBody, customer: { address: '+96181030843' } }, idem);
    check('the same key with a different request is refused (422 idempotency_key_reused)',
        reused.status === 422 && reused.body.error?.code === 'idempotency_key_reused', `HTTP ${reused.status}`);
    const badKey = { 'Idempotency-Key': `e2e-bad-${Date.now()}` };
    const invalid1 = await api('POST', '/v1/tenants/demo/calls', { channel_ref: 'whatsapp-main' }, badKey);
    const invalid2 = await api('POST', '/v1/tenants/demo/calls', { channel_ref: 'whatsapp-main' }, badKey);
    check('a 4xx is replayed for the same key too', invalid1.status === 400 && invalid2.status === 400
        && invalid2.headers.get('idempotent-replayed') === 'true', `${invalid1.status}/${invalid2.status}`);
    const cancelIntent = await api('POST', `/v1/calls/${firstTry.body.call.callId}/terminate`);
    const cancelled = await waitFor(async () => { const r = await callRow(firstTry.body.call.callId); return r.status === 'TERMINATED' ? r : null; }, 5000, 'intent cancelled');
    check('terminating an outbound intent the agent never started ends it CANCELLED at once',
        cancelIntent.status === 202 && cancelled.termination_reason === 'CANCELLED' && cancelled.terminated_by === 'CONSUMER',
        `${cancelled.termination_reason}/${cancelled.terminated_by}`);

    // ── Reading events back ──
    const listed = await api('GET', `/v1/events?call_id=${outId}`);
    const listedTypes = (listed.body.events ?? []).map((e) => e.type);
    check('GET /v1/events lists a call\'s events, newest first', listed.status === 200
        && ['call.created', 'call.answered', 'call.ended'].every((t) => listedTypes.includes(t)) && listedTypes[0] === 'call.ended',
        listedTypes.join(','));
    const endedListed = listed.body.events.find((e) => e.type === 'call.ended');
    check('each listed event carries the exact webhook body and its delivery state',
        endedListed.body.event_id === endedEvent.eventId && endedListed.body.data?.call?.externalRef === 'crm-call-42'
        && endedListed.delivery.status === 'DELIVERED', JSON.stringify(endedListed.delivery));
    const one = await api('GET', `/v1/events/${endedListed.eventId}`);
    check('GET /v1/events/{eventId} returns one event', one.status === 200 && one.body.event?.eventId === endedListed.eventId);
    const page = await api('GET', `/v1/events?limit=1`);
    const page2 = await api('GET', `/v1/events?limit=1&before_id=${page.body.nextBeforeId}`);
    check('events page with before_id', page.body.events.length === 1 && page2.body.events.length === 1
        && page2.body.events[0].eventId !== page.body.events[0].eventId);
    const before = receiver.events.filter((e) => e.eventId === endedListed.eventId).length;
    const redo = await api('POST', `/v1/events/${endedListed.eventId}/redeliver`);
    await waitFor(() => receiver.events.filter((e) => e.eventId === endedListed.eventId).length > before, 10000, 'redelivered event');
    check('POST /v1/events/{eventId}/redeliver sends the same event again', redo.status === 202);
    const foreignEvent = await fetch(`${CALLIO}/v1/events/${endedListed.eventId}`, { headers: { Authorization: 'Bearer ck_wrong' } });
    check('events need the consumer\'s key', foreignEvent.status === 401);
    const [{ n: endedRows }] = await q("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE call_id = ? AND event_type = 'call.ended'", [outId]);
    check('a once-per-call event has exactly one outbox row', Number(endedRows) === 1, `rows=${endedRows}`);

    // ── Bad input is a 400, not a 500 ──
    const badDate = await api('GET', '/v1/tenants/demo/calls?from=yesterday');
    check('an unparseable date on the call list is a 400', badDate.status === 400 && /from/.test(badDate.body.error?.message), `HTTP ${badDate.status}`);
    const assetBody = { name: 'Dup', storage_provider: 'LOCAL', storage_key: 'dup.wav', ref: 'dup-ref' };
    const firstAsset = await api('POST', '/v1/tenants/demo/audio-assets', assetBody);
    const dupAsset = await api('POST', '/v1/tenants/demo/audio-assets', assetBody);
    check('a second audio asset with the same ref is a 400', firstAsset.status === 201 && dupAsset.status === 400,
        `${firstAsset.status}/${dupAsset.status}`);

    // ── Lookup hook: signed even without an event URL; reject ends the call unrung ──
    const lookups = [];
    const lookupServer = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const [, t, v1] = /t=(\d+),v1=([a-f0-9]+)/.exec(String(req.headers['x-callio-signature'] || '')) || [];
        lookups.push({ body: JSON.parse(raw), signed: Boolean(v1) && v1 === createHmac('sha256', seed.webhook_secret).update(`${t}.${raw}`).digest('hex') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ customer_name: 'Blocked Caller', external_ref: 'contact-blocked', action: 'reject' }));
    });
    await new Promise((r) => lookupServer.listen(3997, '127.0.0.1', r));
    const [{ event_webhook_url: savedWebhookUrl }] = await q("SELECT event_webhook_url FROM consumers WHERE slug = 'dev'");
    await q("UPDATE consumers SET lookup_url = 'http://127.0.0.1:3997/lookup', event_webhook_url = NULL WHERE slug = 'dev'");
    try {
        const blocked = await meta.callIn('wacid.lookup.1', { from: '96181030849' });
        const blockedRow = await waitFor(async () => {
            const [r] = await q("SELECT * FROM calls WHERE provider_call_id = 'wacid.lookup.1'");
            return r?.status === 'TERMINATED' ? r : null;
        }, 10000, 'looked-up call rejected');
        check('the lookup hook is called and signed, even with no event URL', lookups.length === 1 && lookups[0].signed
            && lookups[0].body.customer?.address === '+96181030849', JSON.stringify(lookups[0] ?? null));
        check('a lookup reject ends the call REJECTED / SYSTEM, with the lookup’s name and ref', blockedRow.termination_reason === 'REJECTED'
            && blockedRow.terminated_by === 'SYSTEM' && blockedRow.customer_name === 'Blocked Caller' && blockedRow.external_ref === 'contact-blocked',
            `${blockedRow.termination_reason}/${blockedRow.terminated_by} ${blockedRow.customer_name}`);
        void blocked;
    } finally {
        await q('UPDATE consumers SET lookup_url = NULL, event_webhook_url = ? WHERE slug = ?', [savedWebhookUrl, 'dev']);
        lookupServer.close();
    }

    // ── Call list filters ──
    const byCustomer = await api('GET', '/v1/tenants/demo/calls?customer=96181030841');
    check('?customer= finds a contact\'s calls, with or without the +', byCustomer.status === 200
        && byCustomer.body.calls.some((c) => c.callId === inCall.id)
        && byCustomer.body.calls.every((c) => c.customer.address === '+96181030841'), `n=${byCustomer.body.calls?.length}`);
    const byChannel = await api('GET', '/v1/tenants/demo/calls?channel_ref=whatsapp-main&queue_ref=main');
    check('?channel_ref= and ?queue_ref= filter by line and queue', byChannel.status === 200
        && byChannel.body.calls.some((c) => c.callId === inCall.id), `n=${byChannel.body.calls?.length}`);
    const badRef = await api('GET', '/v1/tenants/demo/calls?channel_ref=no-such-line');
    const badStatus = await api('GET', '/v1/tenants/demo/calls?status=CANCELLED');
    check('an unknown channel_ref or a status calls never have is a 400', badRef.status === 400 && badStatus.status === 400,
        `${badRef.status}/${badStatus.status}`);

    // ── Deleting a call ──
    const liveIntent = await api('POST', '/v1/tenants/demo/calls', { channel_ref: 'whatsapp-main', agent_ref: 'agent-2', customer: { address: '+96181030844' } });
    const delLive = await api('DELETE', `/v1/calls/${liveIntent.body.call.callId}`);
    check('a call that has not ended cannot be deleted (409 call_active)', delLive.status === 409 && delLive.body.error?.code === 'call_active', `HTTP ${delLive.status}`);
    await api('POST', `/v1/calls/${liveIntent.body.call.callId}/terminate`);
    const delOut = await api('DELETE', `/v1/calls/${outId}`);
    const goneOut = await api('GET', `/v1/calls/${outId}`);
    const [{ n: outDeliveries }] = await q("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE call_id = ? OR JSON_EXTRACT(payload, '$.data.call.callId') = ?", [outId, outId]);
    const [{ n: outEvents }] = await q('SELECT COUNT(*) AS n FROM call_lifecycle_events WHERE call_id = ?', [outId]);
    check('DELETE /v1/calls/{id} removes the call, its detail and the events sent about it',
        delOut.status === 204 && goneOut.status === 404 && Number(outDeliveries) === 0 && Number(outEvents) === 0,
        `delete=${delOut.status} get=${goneOut.status} deliveries=${outDeliveries} events=${outEvents}`);

    // ── Erasing a customer ──
    const erase = await api('POST', '/v1/tenants/demo/customers/erase', { address: '+96181030841' });
    const erasedRow = await callRow(inCall.id);
    const [{ n: inEvents }] = await q('SELECT COUNT(*) AS n FROM call_lifecycle_events WHERE call_id = ?', [inCall.id]);
    const [{ n: inDeliveries }] = await q('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE call_id = ?', [inCall.id]);
    check('erasing a customer anonymises their calls and removes the detail and events about them',
        erase.status === 200 && erase.body.callsErased >= 1 && erasedRow && erasedRow.customer_address === null
        && erasedRow.customer_name === null && Number(inEvents) === 0 && Number(inDeliveries) === 0,
        `${JSON.stringify(erase.body)} address=${erasedRow?.customer_address} events=${inEvents} deliveries=${inDeliveries}`);
    const afterErase = await api('GET', '/v1/tenants/demo/calls?customer=%2B96181030841');
    const keptCall = await api('GET', `/v1/calls/${inCall.id}`);
    check('the anonymised call stays in the history, without the customer', afterErase.body.calls.length === 0
        && keptCall.status === 200 && keptCall.body.call.customer.address === null && keptCall.body.call.status === 'TERMINATED');

    // ── Webhook settings, event subscriptions, no-change availability ──
    const hook = await api('GET', '/v1/webhook');
    check('GET /v1/webhook shows the URLs, every event type and that a secret is set',
        hook.status === 200 && hook.body.webhook.url === 'http://127.0.0.1:3999/events' && hook.body.webhook.eventTypes === null
        && hook.body.webhook.secretSet === true && !('secret' in hook.body), JSON.stringify(hook.body));
    const badUrl = await api('PUT', '/v1/webhook', { url: 'ftp://example.com/x' });
    const badType = await api('PUT', '/v1/webhook', { url: 'http://127.0.0.1:3999/events', event_types: ['call.exploded'] });
    check('a non-http(s) URL or an unknown event type is a 400', badUrl.status === 400 && badType.status === 400,
        `${badUrl.status}/${badType.status}`);
    const availabilityRows = async () => Number((await q(
        "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event_type = 'agent.availability.changed' AND JSON_EXTRACT(payload, '$.data.agent_ref') = 'agent-1'"))[0].n);
    const setA1 = (availability) => api('PUT', '/v1/tenants/demo/agents/agent-1/availability', { availability });
    await setA1('OFFLINE');
    await sleep(500);
    const base = await availabilityRows();
    await setA1('AVAILABLE');
    await setA1('AVAILABLE');
    await sleep(1500);
    check('setting the same availability again sends no agent.availability.changed', (await availabilityRows()) === base + 1,
        `rows ${base} → ${await availabilityRows()}`);
    const subscribe = await api('PUT', '/v1/webhook', { url: 'http://127.0.0.1:3999/events', event_types: ['call.ended'] });
    await setA1('OFFLINE');
    await setA1('AVAILABLE');
    await sleep(1500);
    check('with event_types, other events are not written or sent', subscribe.status === 200
        && JSON.stringify(subscribe.body.webhook.eventTypes) === '["call.ended"]' && (await availabilityRows()) === base + 1,
        `rows=${await availabilityRows()}`);
    const everything = await api('PUT', '/v1/webhook', { url: 'http://127.0.0.1:3999/events' });
    check('omitting event_types subscribes to every type again', everything.body.webhook.eventTypes === null);
    const [{ event_webhook_secret: savedSecret }] = await q("SELECT event_webhook_secret FROM consumers WHERE slug = 'dev'");
    const rotated = await api('POST', '/v1/webhook/secret');
    const [{ event_webhook_secret: newSecret }] = await q("SELECT event_webhook_secret FROM consumers WHERE slug = 'dev'");
    check('POST /v1/webhook/secret returns a new secret once and replaces the stored one',
        rotated.status === 200 && typeof rotated.body.secret === 'string' && rotated.body.secret.length >= 32 && newSecret !== savedSecret);
    // Later suites verify signatures with the seeded secret.
    await q("UPDATE consumers SET event_webhook_secret = ? WHERE slug = 'dev'", [savedSecret]);

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
