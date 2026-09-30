// Retention (core/calls/RetentionService): old call detail, SDP, finished
// webhook deliveries and a tenant's expired recordings go; the call record,
// live calls, recent detail and pending deliveries stay. Rows are backdated
// in the database; run.mjs sweeps every ~10 s. Also: a push token lives on one
// device only (UNIQUE provider + token).
// Run through run.mjs (npm run test:e2e), which passes <seed.json> <callio-port>.
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { testDb, makeChecks, waitFor, api as makeApi } from './lib.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PORT = Number(process.argv[3] || 3901);
const CALLIO = `http://127.0.0.1:${PORT}`;
const { check, summary } = makeChecks();
const api = makeApi(CALLIO, seed.api_key);
const db = await testDb();
const q = async (sql, params = []) => (await db.execute(sql, params))[0];
const count = async (sql, params) => Number((await q(sql, params))[0].n);
let exitCode = 0;

try {
    const [{ id: tenantId, consumer_id: consumerId }] = await q("SELECT id, consumer_id FROM tenants WHERE external_ref = 'demo'");
    const newCall = async (status, endedDaysAgo) => {
        const [r] = await db.execute(
            `INSERT INTO calls (tenant_id, channel, direction, status, termination_reason, terminated_by, ringing_at, ended_at, created_at, updated_at)
             VALUES (?, 'WHATSAPP', 'INBOUND', ?, ?, ?, NOW() - INTERVAL ? DAY, ${endedDaysAgo == null ? 'NULL' : 'NOW() - INTERVAL ? DAY'}, NOW() - INTERVAL ? DAY, NOW())`,
            status === 'RINGING'
                ? [tenantId, status, null, null, 0, 0]
                : [tenantId, status, 'COMPLETED', 'CUSTOMER', endedDaysAgo, endedDaysAgo, endedDaysAgo]
        );
        const id = r.insertId;
        await db.execute(`INSERT INTO call_lifecycle_events (call_id, tenant_id, event_type, occurred_at, created_at, updated_at) VALUES (?, ?, 'inbound_queued', NOW(), NOW(), NOW())`, [id, tenantId]);
        await db.execute(`INSERT INTO call_connections (call_id, connection_type, local_sdp, remote_sdp, ice_candidates, created_at, updated_at)
                          VALUES (?, 'CUSTOMER', 'v=0 local', 'v=0 remote', '[]', NOW(), NOW())`, [id]);
        const [s] = await db.execute(`INSERT INTO ivr_sessions (call_id, started_at, created_at, updated_at) VALUES (?, NOW(), NOW(), NOW())`, [id]);
        await db.execute(`INSERT INTO ivr_session_inputs (ivr_session_id, node_name, input, created_at, updated_at) VALUES (?, 'menu', '1', NOW(), NOW())`, [s.insertId]);
        return id;
    };
    const oldCall = await newCall('TERMINATED', 200);   // past the 180-day detail retention
    const recentCall = await newCall('TERMINATED', 2);  // past the 24 h SDP retention only
    const liveCall = await newCall('RINGING', null);

    const delivery = async (status, daysAgo) => db.execute(
        `INSERT INTO webhook_deliveries (consumer_id, tenant_id, event_id, event_type, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, 'call.ended', '{}', ?, NOW() - INTERVAL ? DAY, NOW())`, [consumerId, tenantId, randomUUID(), status, daysAgo]);
    await delivery('DELIVERED', 40);
    await delivery('PENDING', 40);
    await delivery('DELIVERED', 1);
    const tag = (await q('SELECT MAX(id) AS id FROM webhook_deliveries'))[0].id;

    // A tenant keeping recordings 10 days; one is 20 days old, one 5.
    await db.execute(`UPDATE tenants SET settings = JSON_OBJECT('recording', JSON_OBJECT('retention_days', 10)) WHERE id = ?`, [tenantId]);
    const recording = async (callId, daysAgo) => (await db.execute(
        `INSERT INTO call_recordings (call_id, storage_provider, storage_key, status, started_at, created_at, updated_at)
         VALUES (?, 'local', 'rec.ogg', 'completed', NOW() - INTERVAL ? DAY, NOW(), NOW())`, [callId, daysAgo]))[0].insertId;
    const oldRec = await recording(oldCall, 20);
    const newRec = await recording(recentCall, 5);

    // ── A sweep ──
    const swept = await waitFor(async () => (await count('SELECT COUNT(*) AS n FROM call_lifecycle_events WHERE call_id = ?', [oldCall])) === 0, 30000, 'a retention sweep').catch(() => false);
    check('a sweep runs on its own', Boolean(swept));
    await waitFor(async () => (await q('SELECT status FROM call_recordings WHERE id = ?', [oldRec]))[0].status === 'purged', 15000, 'recording purge').catch(() => null);

    const detail = async (id) => ({
        events: await count('SELECT COUNT(*) AS n FROM call_lifecycle_events WHERE call_id = ?', [id]),
        legs: await count('SELECT COUNT(*) AS n FROM call_connections WHERE call_id = ?', [id]),
        ivr: await count('SELECT COUNT(*) AS n FROM ivr_sessions WHERE call_id = ?', [id]),
    });
    const o = await detail(oldCall);
    const inputsLeft = await count(`SELECT COUNT(*) AS n FROM ivr_session_inputs i JOIN ivr_sessions s ON s.id = i.ivr_session_id WHERE s.call_id = ?`, [oldCall]);
    const oldRow = (await q('SELECT id, termination_reason FROM calls WHERE id = ?', [oldCall]))[0];
    check('an old call’s detail is deleted and its record kept',
        o.events === 0 && o.legs === 0 && o.ivr === 0 && inputsLeft === 0 && oldRow?.termination_reason === 'COMPLETED', JSON.stringify(o));

    const r = await detail(recentCall);
    const [recentLeg] = await q('SELECT local_sdp, remote_sdp, ice_candidates FROM call_connections WHERE call_id = ?', [recentCall]);
    check('a recent call keeps its detail, with its SDP cleared',
        r.events === 1 && r.legs === 1 && r.ivr === 1 && recentLeg?.local_sdp == null && recentLeg?.remote_sdp == null && recentLeg?.ice_candidates == null,
        JSON.stringify({ ...r, sdp: recentLeg?.local_sdp }));
    const [liveLeg] = await q('SELECT local_sdp FROM call_connections WHERE call_id = ?', [liveCall]);
    check('a live call is untouched', liveLeg?.local_sdp === 'v=0 local' && (await detail(liveCall)).events === 1);

    const left = await q('SELECT status, DATEDIFF(NOW(), created_at) AS age FROM webhook_deliveries WHERE id <= ? AND id > ? - 3 ORDER BY id', [tag, tag]);
    check('finished deliveries past retention are deleted; pending and recent ones stay',
        left.length === 2 && left.some((d) => d.status === 'PENDING' && d.age >= 39) && left.some((d) => d.status === 'DELIVERED' && d.age <= 1),
        JSON.stringify(left));

    const recs = Object.fromEntries((await q('SELECT id, status, storage_key, purged_at FROM call_recordings WHERE id IN (?, ?)', [oldRec, newRec])).map((x) => [x.id, x]));
    check('a recording past the tenant’s retention is purged; a newer one is kept',
        recs[oldRec]?.status === 'purged' && recs[oldRec]?.storage_key == null && recs[oldRec]?.purged_at && recs[newRec]?.status === 'completed',
        JSON.stringify(recs));
    await db.execute('UPDATE tenants SET settings = NULL WHERE id = ?', [tenantId]);

    // ── A push token belongs to one device ──
    const put = (device) => api('PUT', `/v1/tenants/demo/agents/agent-1/push-tokens/${device}`, { platform: 'ANDROID', provider: 'FCM', token: 'shared-token' });
    await put('phone-a');
    const moved = await put('phone-b');
    const rows = await q("SELECT device_id FROM agent_push_tokens WHERE provider = 'FCM' AND token = 'shared-token'");
    check('a token registered on another device moves there (one row per token)',
        moved.status === 200 && rows.length === 1 && rows[0].device_id === 'phone-b', JSON.stringify(rows));
} catch (err) {
    console.error('HARNESS ERROR:', err);
    exitCode = 1;
} finally {
    await db.end();
}
process.exit(exitCode || (summary() ? 1 : 0));
