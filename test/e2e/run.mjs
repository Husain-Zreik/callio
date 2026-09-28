// End-to-end test runner (npm run test:e2e). Creates a fresh test database,
// migrates and seeds it, starts Callio against a fake Meta Graph API, runs
// every *.test.mjs suite with a clean call state, and stops Callio.
//
// Needs MySQL 8 and Redis reachable — `docker compose -f test/e2e/docker-compose.yml up -d`
// gives both on the default ports below. Override with TEST_DB_* / TEST_REDIS_*.
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const Redis = require('ioredis');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const work = mkdtempSync(join(tmpdir(), 'callio-e2e-'));
const port = Number(process.env.TEST_CALLIO_PORT || 3901);

// The SIP suite needs the local SIP gateway (deploy/sip-gateway/docker-compose.local.yml).
const drachtioUp = await new Promise((resolve) => {
    const s = net.connect(9022, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
});
const sipEnv = drachtioUp ? {
    DRACHTIO_HOST: '127.0.0.1', DRACHTIO_PORT: '9022', DRACHTIO_SECRET: process.env.TEST_DRACHTIO_SECRET || 'CHANGE_ME',
    RTPENGINE_HOST: '127.0.0.1', RTPENGINE_NG_PORT: '22222',
} : {};

const env = {
    ...process.env,
    DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT || '33306',
    DB_USERNAME: process.env.TEST_DB_USERNAME || 'root',
    DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'callio',
    DB_DATABASE: process.env.TEST_DB_DATABASE || 'callio_test',
    REDIS_HOST: process.env.TEST_REDIS_HOST || '127.0.0.1',
    REDIS_PORT: process.env.TEST_REDIS_PORT || '36379',
    REDIS_DB: process.env.TEST_REDIS_DB || '15',
    NODE_HOST: '127.0.0.1',
    NODE_PORT: String(port),
    WORKER_ID: 'e2e',
    WHATSAPP_API_URL: 'http://127.0.0.1:3990/',
    STORAGE_LOCAL_ROOT: join(work, 'storage'),
    CALLIO_MASTER_KEY: randomBytes(32).toString('base64'),
    // Keep real provider credentials out of the test process.
    AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', ONESIGNAL_APP_ID: '', APNS_KEY_ID: '',
    FIREBASE_SERVICE_ACCOUNT_PATH: join(work, 'no-firebase.json'),
    ...sipEnv,
};

const run = (args, opts = {}) => {
    const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', ...opts });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
};

async function resetState() {
    const db = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD, database: env.DB_DATABASE });
    await db.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of ['webhook_deliveries', 'call_recordings', 'ivr_session_inputs', 'ivr_sessions', 'call_transfer_logs',
        'call_lifecycle_events', 'call_connections', 'calls']) await db.query(`TRUNCATE ${t}`);
    await db.query('SET FOREIGN_KEY_CHECKS=1');
    await db.query("UPDATE agents SET availability = 'OFFLINE'");
    await db.end();
    const redis = new Redis({ host: env.REDIS_HOST, port: Number(env.REDIS_PORT), db: Number(env.REDIS_DB) });
    await redis.flushdb();
    redis.disconnect();
}

async function startCallio(logFile) {
    const { openSync } = await import('fs');
    const out = openSync(logFile, 'w');
    const child = spawn(process.execPath, ['index.js'], { cwd: root, env, stdio: ['ignore', out, out] });
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    child.kill();
    throw new Error(`Callio did not start — see ${logFile}`);
}

function suiteFiles() {
    const only = process.argv.slice(2);
    let all = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
    if (!drachtioUp) {
        console.log('[e2e] SIP gateway not running — skipping sip.test.mjs (docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d)');
        all = all.filter((f) => f !== 'sip.test.mjs');
    }
    return only.length ? all.filter((f) => only.some((o) => f.includes(o))) : all;
}

let failed = 0;
let callio = null;
try {
    console.log(`[e2e] preparing database ${env.DB_DATABASE}`);
    const admin = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD });
    await admin.query(`DROP DATABASE IF EXISTS \`${env.DB_DATABASE}\``);
    await admin.query(`CREATE DATABASE \`${env.DB_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.end();

    run([join(root, 'node_modules/knex/bin/cli.js'), 'migrate:latest']);
    const seedOut = run(['scripts/seed-dev.js', '--phone-number-id', '111222333', '--whatsapp-token', 'fake-token',
        '--whatsapp-number', '+96170000000', '--webhook-url', 'http://127.0.0.1:3999/events',
        // The trunk points at the fake carrier (sipCarrier.mjs) as the gateway's containers see this machine.
        '--sip-did', '+96170000001', '--sip-trunk-host', 'host.docker.internal', '--sip-trunk-port', '5070']);
    const seedFile = join(work, 'seed.json');
    writeFileSync(seedFile, seedOut.slice(seedOut.indexOf('{')));

    for (const suite of suiteFiles()) {
        await resetState();
        const logFile = join(work, `${suite}.callio.log`);
        callio = await startCallio(logFile);
        console.log(`\n[e2e] ── ${suite}`);
        const r = spawnSync(process.execPath, [join(here, suite), seedFile, String(port)], { cwd: root, env, stdio: 'inherit' });
        callio.kill();
        await new Promise((r) => callio.once('exit', r));
        callio = null;
        const errors = readFileSync(logFile, 'utf8').split('\n')
            .filter((l) => /unhandled|exception|is not a function|unknown column|doesn't exist|AGENT STUCK/i.test(l));
        if (errors.length) console.log(`[e2e] Callio log problems (${logFile}):\n  ${errors.slice(0, 20).join('\n  ')}`);
        if (r.status !== 0 || errors.length) failed++;
    }
} catch (err) {
    console.error('[e2e] setup failed:', err.message);
    failed++;
} finally {
    if (callio) callio.kill();
}

console.log(`\n[e2e] ${failed ? `${failed} suite(s) failed` : 'all suites passed'} — logs in ${work}`);
process.exit(failed ? 1 : 0);
