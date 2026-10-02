// Push credentials per consumer: set / read / remove through the Management
// API (validated, encrypted at rest, never returned), and a call's push going
// out with the consumer's own credentials — checked on OneSignal, against a
// fake OneSignal API (ONESIGNAL_API_URL from run.mjs). FCM and APNs resolve
// through the same code but can't be pointed at a fake, so their sends are
// verified on a device.
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync } from 'fs';
import http from 'http';
import { generateKeyPairSync } from 'crypto';
import { testDb, sleep, makeChecks, waitFor, fakeMeta, connectAgent, api as makeApi } from './lib.mjs';

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

// Fake OneSignal: records every notification request.
const oneSignal = [];
const oneSignalServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    oneSignal.push({ path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `n-${oneSignal.length}`, recipients: 1 }));
});

await meta.listen();
await new Promise((r) => oneSignalServer.listen(3998, '127.0.0.1', r));
let exitCode = 0;

try {
    // ── Credentials through the API ──
    const empty = await api('GET', '/v1/push-credentials');
    check('a consumer starts with no push credentials of its own',
        empty.status === 200 && Object.values(empty.body.pushCredentials).every((v) => v === null), JSON.stringify(empty.body));

    const bad = await api('PUT', '/v1/push-credentials/fcm', { service_account: { type: 'service_account', project_id: 'p', client_email: 'x@p', private_key: 'not a key' } });
    check('an unusable service account is refused', bad.status === 400 && /private_key/.test(bad.body?.error?.message ?? ''), `${bad.status} ${bad.body?.error?.message}`);
    const unknown = await api('PUT', '/v1/push-credentials/pigeon', {});
    check('an unknown provider is 404', unknown.status === 404, `HTTP ${unknown.status}`);

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const fcm = await api('PUT', '/v1/push-credentials/fcm', { service_account: {
        type: 'service_account', project_id: 'demo-push', client_email: 'push@demo-push.iam.gserviceaccount.com', private_key: privateKey,
    } });
    check('a Firebase service account is stored', fcm.status === 200 && fcm.body.fcm?.projectId === 'demo-push', JSON.stringify(fcm.body));
    const os = await api('PUT', '/v1/push-credentials/onesignal', { app_id: 'app-e2e', rest_api_key: 'rest-key-e2e' });
    check('a OneSignal app is stored', os.status === 200 && os.body.onesignal?.appId === 'app-e2e', JSON.stringify(os.body));

    const shown = await api('GET', '/v1/push-credentials');
    const text = JSON.stringify(shown.body);
    check('reads show which app, never a key', shown.body.pushCredentials.fcm?.projectId === 'demo-push'
        && shown.body.pushCredentials.onesignal?.appId === 'app-e2e' && !text.includes('rest-key-e2e') && !text.includes('PRIVATE KEY'), text);
    const [{ push_credentials: atRest }] = await q("SELECT push_credentials FROM consumers WHERE slug = 'dev'");
    check('credentials are encrypted at rest', typeof atRest === 'string' && !atRest.includes('rest-key-e2e') && !atRest.includes('PRIVATE KEY') && !atRest.includes('app-e2e'));

    // ── A call's push goes out with the consumer's OneSignal app ──
    await api('PUT', '/v1/tenants/demo/queues/main', { name: 'Main queue', strategy: 'ROUND_ROBIN' });
    await api('PUT', '/v1/tenants/demo/queues/main/members', { members: [{ agent_ref: 'agent-1' }] });
    const reg = await api('PUT', '/v1/tenants/demo/agents/agent-1/push-tokens/agent-1-browser', { platform: 'WEB', provider: 'ONESIGNAL', token: 'sub-agent-1' });
    check('a web push subscription is registered', reg.status === 200, `HTTP ${reg.status}`);
    const a1 = await connectAgent(CALLIO, seed, 'agent-1');
    a1.socket.emit('agent:availability:set', { availability: 'AVAILABLE' });
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 5000, 'agent-1 available');

    const c1 = await meta.callIn('wacid.p.1');
    const row1 = await callByProvider(c1.id);
    const sent = await waitFor(() => oneSignal.find((n) => n.body?.data?.callId == row1.id), 8000, 'OneSignal push').catch(() => null);
    check('the incoming-call push uses the consumer\'s OneSignal app and key',
        sent?.body.app_id === 'app-e2e' && sent?.auth === 'Key rest-key-e2e' && sent?.body.include_subscription_ids?.[0] === 'sub-agent-1'
        && sent?.body.data?.type === 'call.incoming',
        sent ? `app=${sent.body.app_id} auth=${sent.auth} type=${sent.body.data?.type}` : 'no push');
    await meta.hangUp(c1.id);
    await waitFor(async () => (await callRow(row1.id)).status === 'TERMINATED', 10000, 'call 1 ended');

    // ── Removed: nothing to send with (no platform OneSignal in the test env) ──
    const del = await api('DELETE', '/v1/push-credentials/onesignal');
    check('credentials are removed', del.status === 204 && (await api('GET', '/v1/push-credentials')).body.pushCredentials.onesignal === null, `HTTP ${del.status}`);
    await waitFor(async () => (await availability('agent-1')) === 'AVAILABLE', 8000, 'agent-1 released');
    const before = oneSignal.length;
    const c2 = await meta.callIn('wacid.p.2', { from: '96181030862' });
    const row2 = await callByProvider(c2.id);
    await waitFor(() => a1.incoming.find((p) => String(p.callId) === String(row2.id)), 8000, 'call 2 offered');
    await sleep(1500);
    check('without credentials, no push goes out with another app\'s', oneSignal.length === before, `requests=${oneSignal.length - before}`);
    await meta.hangUp(c2.id);
    await waitFor(async () => (await callRow(row2.id)).status === 'TERMINATED', 10000, 'call 2 ended');

    a1.socket.close();
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    meta.close(); oneSignalServer.close();
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
