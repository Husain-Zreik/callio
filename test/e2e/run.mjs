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
import { fakeS3 } from './lib.mjs';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const Redis = require('ioredis');

// One run at a time: every run recreates the same database and uses the same
// ports, so two at once break each other. The lock is a listening port, so
// the OS frees it however this process ends (crash, kill). A second run waits.
const LOCK_PORT = Number(process.env.TEST_LOCK_PORT || 3899);
const lock = net.createServer();
for (let waited = 0; ; waited++) {
    const taken = await new Promise((resolve) => {
        lock.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
        lock.listen(LOCK_PORT, '127.0.0.1', () => resolve(false));
    });
    if (!taken) break;
    if (waited === 0) console.log(`[e2e] another test run is in progress (port ${LOCK_PORT}) — waiting for it to finish`);
    if (waited >= 180) { console.log('[e2e] gave up waiting after 15 minutes'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 5000));
}
lock.unref();

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const work = mkdtempSync(join(tmpdir(), 'callio-e2e-'));
const port = Number(process.env.TEST_CALLIO_PORT || 3901);
const S3_PORT = Number(process.env.TEST_S3_PORT || 3995);

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
    // Keep real provider credentials out of the test process. Object storage is
    // the fake S3 below, so recordings upload and can be read back.
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_BUCKET: 'callio-test', AWS_DEFAULT_REGION: 'us-east-1',
    AWS_ENDPOINT: `http://127.0.0.1:${S3_PORT}`, AWS_USE_PATH_STYLE_ENDPOINT: 'true', AWS_BUCKET_PREFIX: '', AWS_URL: '',
    ONESIGNAL_APP_ID: '', APNS_KEY_ID: '',
    ONESIGNAL_API_URL: 'http://127.0.0.1:3998/notifications',   // push.test.mjs's fake OneSignal
    FIREBASE_SERVICE_ACCOUNT_PATH: join(work, 'no-firebase.json'),
    // Each suite's Callio output (pretty, debug) lands in <work>/<suite>.callio.log.
    LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'debug', LOG_STDOUT: 'true', LOG_FORMAT: 'pretty',
    CALL_TRANSFER_TIMEOUT_SECONDS: '6',
    WEBHOOK_ALLOW_HTTP: 'true',      // the suites' receivers are http://127.0.0.1
    RETENTION_SWEEP_SECONDS: '10',   // retention.test.mjs: a sweep every ~10 s
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
    for (let i = 0; i < 120; i++) {   // up to 60 s: a cold first start (native modules, AV scanning) can be slow
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

// The logging rules (CLAUDE.md, Logging), checked on every run: code in src/
// logs through src/infra/logging/logger.js, never console.*, and messages
// carry no "[Prefix]" or emoji (the component names the source).
const LOG_RULES = [
    [/\bconsole\s*(\.|\[)/, 'console.* — use the logger'],
    [/\blog\.(trace|debug|info|warn|error|fatal)\((\{[^}]*\},\s*)?['`]\[/, 'message starts with [Prefix] — the component names the source'],
    [/\blog\.(trace|debug|info|warn|error|fatal)\(.*\p{Extended_Pictographic}/u, 'emoji in a log message'],
];
function checkLogging() {
    const offenders = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) { if (full !== join(root, 'src', 'infra', 'logging')) walk(full); continue; }
            if (!/\.m?js$/.test(entry.name)) continue;
            readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                const code = line.replace(/^\s*\/\/.*$/, '');
                for (const [rule, why] of LOG_RULES) {
                    if (rule.test(code)) offenders.push(`${full.slice(root.length + 1)}:${i + 1}: ${why}\n      ${line.trim()}`);
                }
            });
        }
    };
    walk(join(root, 'src'));
    if (offenders.length) {
        console.log(`[e2e] logging rules broken in src/:\n  ${offenders.join('\n  ')}`);
        process.exit(1);
    }
}
checkLogging();

// The logger's guarantees (context, redaction, levels, throttle) — loggingCheck.mjs.
{
    const r = spawnSync(process.execPath, [join(here, 'loggingCheck.mjs')], { cwd: root, encoding: 'utf8' });
    let results;
    try { results = JSON.parse(r.stdout); } catch { console.log(`[e2e] logging check crashed:\n${r.stdout}\n${r.stderr}`); process.exit(1); }
    const failedChecks = results.filter((c) => !c.ok);
    console.log(`[e2e] logging: ${results.length - failedChecks.length}/${results.length} checks passed`);
    for (const c of failedChecks) console.log(`FAIL  logging: ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (failedChecks.length) process.exit(1);
}

let failed = 0;
let callio = null;
const s3 = fakeS3({ bucket: 'callio-test', port: S3_PORT });
await s3.listen();
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
        // Not spawnSync: the fake S3 in this process has to keep answering while the suite runs.
        const r = await new Promise((done) => spawn(process.execPath, [join(here, suite), seedFile, String(port)], { cwd: root, env, stdio: 'inherit' })
            .on('exit', (status) => done({ status })));
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
    s3.close();
}

console.log(`\n[e2e] ${failed ? `${failed} suite(s) failed` : 'all suites passed'} — logs in ${work}`);
process.exit(failed ? 1 : 0);
